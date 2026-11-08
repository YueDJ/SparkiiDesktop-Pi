// 调度与防降级状态（契约 §5 / 设计 §6.3 第 4 条）。
// update-state.json：{ v:1, payload, mac }，MAC 覆盖规范化 payload JSON 原始字节。
// 关键：解析失败 / mac 不匹配 / v 不符 → isTampered() 为 true，损坏即拒绝，绝不回退到可信默认状态。

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compareVersions } from './decision.js';

export const UPDATE_UPDATES_DIRNAME = 'updates';
export const UPDATE_STATE_FILENAME = 'update-state.json';

export interface PersistedState {
  lastSeenSequence: number | null;
  sequenceNonce: Record<string, string>;
  minInstalledVersion: string | null;
  skippedVersions: string[];
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  deferredUntil: number | null;
  failureCount: number;
  installId: string;
}

interface PersistedFile { v: 1; payload: PersistedState; mac: string; }

function defaultState(): PersistedState {
  return {
    lastSeenSequence: null,
    sequenceNonce: {},
    minInstalledVersion: null,
    skippedVersions: [],
    lastCheckedAt: null,
    lastSuccessAt: null,
    deferredUntil: null,
    failureCount: 0,
    installId: randomUUID(),
  };
}

/** 损坏时使用的「毒化」状态：即便调用方漏检 isTampered()，sequence 闸门也会拒绝一切更新。 */
function poisonState(): PersistedState {
  return { ...defaultState(), lastSeenSequence: Number.MAX_SAFE_INTEGER, installId: '' };
}

/**
 * 状态文件位置**读不动**时的写侧拒绝（`EISDIR` / `EPERM` / `ENOTDIR`…）。
 * 与 `TamperedStateWriteError` 刻意分成两类（R18 · Major-1 / R19 · Major-1 的教训）：
 * 这一类是磁盘 / 权限 / 被占用的运维现场，**不是**"有人改了本地状态"，
 * 因此调用方不得抬 tamper 闩锁、不得让整次运行停用后还要重启才恢复。
 */
export class UnreadableStateError extends Error {
  constructor(readonly code: string) {
    super(`update-state: path is not readable (errno ${code}); refusing to write over an unknown scene`);
    this.name = 'UnreadableStateError';
  }
}

/**
 * 状态不可信时的**写侧**拒绝（R13 · Major-2）。调用方必须把它映射成结构化的
 * `STATE_TAMPERED` 拒绝，而不是与 IO 故障（`STATE_WRITE_FAILED`）混成一类：
 * 前者意味着"这台机器的锚点被人动过"，后者只是"这次没写进去"。
 */
export class TamperedStateWriteError extends Error {
  constructor() {
    super('update-state: local state failed MAC / shape check; refusing to overwrite the scene');
    this.name = 'TamperedStateWriteError';
  }
}

/** 规范化：固定键顺序、sequenceNonce 与 skippedVersions 排序，保证写/读字节一致。 */
function normalize(input: Partial<PersistedState>): PersistedState {
  const sequenceNonce: Record<string, string> = {};
  for (const k of Object.keys(input.sequenceNonce ?? {}).sort()) {
    sequenceNonce[k] = String(input.sequenceNonce?.[k] ?? '');
  }
  return {
    lastSeenSequence:
      typeof input.lastSeenSequence === 'number' ? input.lastSeenSequence : null,
    sequenceNonce,
    minInstalledVersion:
      typeof input.minInstalledVersion === 'string' ? input.minInstalledVersion : null,
    skippedVersions: [...(input.skippedVersions ?? [])].sort(),
    lastCheckedAt: typeof input.lastCheckedAt === 'number' ? input.lastCheckedAt : null,
    lastSuccessAt: typeof input.lastSuccessAt === 'number' ? input.lastSuccessAt : null,
    deferredUntil: typeof input.deferredUntil === 'number' ? input.deferredUntil : null,
    failureCount: typeof input.failureCount === 'number' ? input.failureCount : 0,
    installId: typeof input.installId === 'string' ? input.installId : '',
  };
}

function canonical(state: PersistedState): string {
  return JSON.stringify(normalize(state));
}

export class UpdateStateStore {
  private readonly file: string;
  private current: PersistedState = defaultState();
  private loaded = false;
  private _tampered = false;
  /** 区分「文件从未存在」（首装）与「文件存在但不可信」——§6.3 第 4 条要求两者不同处置。 */
  private _absent = false;
  /** 读文件本身失败（非 ENOENT）的错误码：`EISDIR` / `EPERM` / `ENOTDIR` 等，供审计区分根因。 */
  private readFailureCode: string | null = null;

  constructor(private opts: { dataDir: string; secret: Buffer; now(): number }) {
    this.file = join(opts.dataDir, UPDATE_UPDATES_DIRNAME, UPDATE_STATE_FILENAME);
  }

  private mac(canon: string): string {
    return createHmac('sha256', this.opts.secret).update(canon, 'utf8').digest('base64');
  }

  private macEquals(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }

  private applyDecode(text: string | null): void {
    this.loaded = true;
    this.readFailureCode = null;   // 每次解码重新判定：读得动就不是"读不动"现场
    if (text == null) {
      // 文件缺失 → 全新默认状态，且可正常写入（不是损坏）。
      // 「首次装机」与「用过之后被人删掉」在这里长得一样，必须由 §6.3 第 4 条的
      // DPAPI 侧序号镜像（service.seqMirror）来判别；判别前不得把默认状态当成可信下限。
      this._tampered = false;
      this._absent = true;
      this.current = defaultState();
      return;
    }
    this._absent = false;
    try {
      const parsed = JSON.parse(text) as PersistedFile;
      if (parsed?.v !== 1 || !parsed.payload || typeof parsed.mac !== 'string') {
        throw new Error('shape');
      }
      const norm = normalize(parsed.payload);
      if (!this.macEquals(parsed.mac, this.mac(canonical(norm)))) {
        throw new Error('mac');
      }
      this._tampered = false;
      this.current = norm;
    } catch {
      // 损坏即拒绝：不回退到可信默认，置毒化状态 + 标记。
      this._tampered = true;
      this.current = poisonState();
    }
  }

  /** 同步惰性加载，供 isTampered() / 各 getter 在未显式 read() 时也能正确判定。 */
  private ensureLoaded(): void {
    // R20 · Major / R21 · Major-1：第三态（位置读不动）多半只是瞬时磁盘 / 权限 / 被占用故障。
    // 原先 `loaded` 一置位就永不重读、`readFailureCode` 只置不清 ⇒ 故障物理消失后**同一实例**
    // 仍抛 `UnreadableStateError`，只有重启才好，I-75 承诺的「同一次运行即恢复」是假的。
    // 这里让第三态每次调用重读一次：正常盘态仍只读一次（loaded 且无 readFailureCode 即早退），
    // 只有异常态才付出重读代价；重读成功时 `applyDecode()` 会清掉 readFailureCode。
    if (this.loaded && this.readFailureCode == null) return;
    let text: string | null = null;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      // R19 · 差异 (c)：原先这里把**任何**读失败都当成"文件不存在"。
      // 但 `EISDIR` / `EPERM` / `ENOTDIR`（状态文件的位置被占成目录、被杀软锁住、ACL 被改）
      // 根本不是"这台机器从没写过状态"——把它们读成首装会让 §6.3 第 4 条的删档判别当场失效
      // （镜像也为空时整个更新链看着像全新安装，界面无痕、phase 还是 idle）。
      // 只有「父目录正常存在而文件缺失」的 `ENOENT` 才算缺失；其余一律走第三态。
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // R20 · Major：Windows 上「`updates` 上级变成普通文件」时 readFileSync 报的是 **ENOENT**
        // 而不是 ENOTDIR（实测 code=ENOENT / errno=-4058）。只凭 code 会把这个现场折成"首装"：
        // 镜像有序号时误报 STATE_TAMPERED，镜像为空时 I-31 的删档判别当场失效。
        // 故先探父路径是不是目录，是文件就归入第三态（平台 errno 差异由这一层吸收）。
        let parentIsFile = false;
        let probeFailure: string | null = null;
        const parent = dirname(this.file);
        try {
          parentIsFile = !statSync(parent).isDirectory();
        } catch (probeErr) {
          const probeCode = (probeErr as NodeJS.ErrnoException).code ?? 'READ_FAILED';
          if (probeCode === 'ENOENT') {
            // R22 · Maj-1：`statSync` **跟随链接**。悬空 junction / 断掉的符号链接会让 stat 报
            // ENOENT，但那个名字其实还在（本机实测：read=ENOENT、stat=ENOENT、lstat 成功且
            // isDirectory=false）。空 catch 一律按首装会把「占住路径」又读成「这台机器从没写过状态」。
            // 用 lstatSync 补看名字本身：还在且不是目录 ⇒ 第三态；连名字都不存在 ⇒ 才是真首装。
            try {
              parentIsFile = !lstatSync(parent).isDirectory();
            } catch {
              parentIsFile = false;
            }
          } else {
            // 探查本身被 EACCES / EPERM / ELOOP 挡住 ⇒ 无法证明父目录正常，按 fail closed 归第三态，
            // 绝不静默折成 absent（R23 观察项同一格）。
            probeFailure = probeCode;
          }
        }
        if (parentIsFile || probeFailure) {
          this.loaded = true;
          this._tampered = false;
          this._absent = false;
          this.readFailureCode = probeFailure ?? 'ENOTDIR';
          this.current = poisonState();
          return;
        }
        text = null;
      } else {
        // 第三态：既不是"文件不存在"（首装口径），也不是"内容被改过字节"（tampered 口径）。
        // ⚠ 这里刻意**不**置 `_tampered`：R18 · Major-1 / R19 · Major-1 刚判过我把磁盘 / 权限问题
        // 报成"本地状态不可信"是误报（会让运维按人为篡改去查，还会把整次运行闩死、故障消失也不自愈）。
        // 但它也绝不能被读成 absent —— 否则"把状态文件位置占成目录"就等于"删掉状态文件"，
        // §6.3 第 4 条的删档判别当场失效（镜像也为空时整个更新链看着像全新装机）。
        this.loaded = true;
        this._tampered = false;
        this._absent = false;
        this.readFailureCode = code ?? 'READ_FAILED';
        this.current = poisonState();
        return;
      }
    }
    this.applyDecode(text);
  }

  async read(): Promise<PersistedState> {
    this.ensureLoaded();
    return this.current;
  }

  isTampered(): boolean {
    this.ensureLoaded();
    return this._tampered;
  }

  /**
   * 非 `ENOENT` 的读失败错误码（`EISDIR` / `EPERM` / `ENOTDIR` …），即"状态文件的位置根本不是一个能读的文件"。
   * 与"文件内容不可信"分开：前者多半是磁盘 / 权限 / 被占用，后者才是被人改过字节（R19 差异 (c) 的现场）。
   */
  unreadableCode(): string | null {
    this.ensureLoaded();
    return this.readFailureCode;
  }

  /**
   * 'absent'     ⇒ 状态文件从未存在（首装，或被删——需 seqMirror 判别）
   * 'tampered'   ⇒ 存在但不可信（解析失败 / mac 不符 / 版本不符）
   * 'unreadable' ⇒ 位置读不动（`EISDIR` / `EPERM` / `ENOTDIR`…），既非缺失也非被改字节
   * 'ok'         ⇒ 存在且 MAC 校验通过
   */
  fileStatus(): 'absent' | 'tampered' | 'unreadable' | 'ok' {
    this.ensureLoaded();
    if (this.readFailureCode != null) return 'unreadable';
    if (this._tampered) return 'tampered';
    return this._absent ? 'absent' : 'ok';
  }

  /**
   * 由 DPAPI 序号镜像强制下限（R2 · B1 的修复面之一）：
   * 攻击者用同一把密钥恢复出一份**更旧但 MAC 合法**的状态文件时，
   * 文件自身看不出任一回退 ⇒ 以镜像里更高的 sequence 为准，并把 nonce 绑定补齐。
   * 只抬高、从不降低；抬高后必须落盘，避免每次都靠内存兜底。
   */
  async enforceFloorFromMirror(mirror: { sequence: number; nonce: string; version?: string }): Promise<void> {
    this.ensureLoaded();
    // R22 · Maj-4：这是全类第三个会调 persist() 的公共出口，write/mutate 都有
    // `readFailureCode` 闸门，唯独这里漏了 ⇒ 第三态下要么静默 return 伪装成功，
    // 要么把落盘的裸 EPERM 原文抛出去。与写侧统一为结构化拒绝，绝不"看起来抬高了下限"。
    if (this.readFailureCode != null) throw new UnreadableStateError(this.readFailureCode);
    if (this._tampered) return;                      // 已判毒化，交给调用方的 fail closed 路径
    const last = this.current.lastSeenSequence;
    if (typeof mirror?.sequence !== 'number' || mirror.sequence < 0) return;
    if (last != null && last >= mirror.sequence) return;
    this.current.lastSeenSequence = mirror.sequence;
    if (mirror.nonce) this.current.sequenceNonce[String(mirror.sequence)] = mirror.nonce;
    if (mirror.version &&
        (this.current.minInstalledVersion == null ||
         compareVersions(mirror.version, this.current.minInstalledVersion) > 0)) {
      this.current.minInstalledVersion = mirror.version;
    }
    await this.persist();
  }

  lastSeenSequence(): number | null {
    this.ensureLoaded();
    return this.current.lastSeenSequence;
  }

  nonceFor(sequence: number): string | null {
    this.ensureLoaded();
    return this.current.sequenceNonce[String(sequence)] ?? null;
  }

  private async persist(): Promise<void> {
    const canon = canonical(this.current);
    const file: PersistedFile = { v: 1, payload: this.current, mac: this.mac(canon) };
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(file), 'utf8');
    try {
      await rename(tmp, this.file); // 原子替换
    } catch (err) {
      // rename 失败（Windows 下目标被占用会 EPERM/EBUSY）时，绝不把自己的临时文件留在更新目录里，
      // 也不得让调用方以为写成功：原样抛出，由 service 侧转成结构化拒绝（I-52 的同一条教训用在状态文件上）。
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    // 写成功就说明文件此刻存在且 MAC 是我们自己算的 ⇒ `_absent` 必须跟着落地清掉。
    // 它原先是「只置不清」的闩锁：首装会话里第一次成功检查之后，`fileStatus()` 会永远返回
    // 'absent'，于是 §6.3 第 4 条把「刚写好状态文件的正常机器」误判成「删档攻击」，
    // 同一进程内第二次检查起就假报 STATE_TAMPERED 并连带封掉下载 / 安装（R5 · Blocker-1）。
    this._absent = false;
  }

  async write(next: PersistedState): Promise<void> {
    this.ensureLoaded();
    if (this.readFailureCode != null) throw new UnreadableStateError(this.readFailureCode);
    // 损坏即拒绝——但**必须是"抛错式拒绝"**：原先这里是 `return`（静默无操作），
    // 于是 service 侧 `deferUpdate` / `skipUpdate` 拿到的是"正常返回"，
    // 对用户报 `ok:true`、一条审计都不写、盘上一个字节没动（R13 · Major-2 实测）。
    // 那正是本仓用例名里写着、而我一度当成已防住的"最坏失败形态"：把失败伪装成成功。
    if (this._tampered) throw new TamperedStateWriteError();
    this.current = normalize(next);
    await this.persist();
  }

  private async mutate(fn: (s: PersistedState) => void): Promise<void> {
    this.ensureLoaded();
    if (this.readFailureCode != null) throw new UnreadableStateError(this.readFailureCode);
    if (this._tampered) throw new TamperedStateWriteError();   // 绝不静默成功
    fn(this.current);
    await this.persist();
  }

  /** 只在验签成功后调用：绑定 (sequence → nonce) 并推进版本下限。sequence 只允许单调递增。 */
  async recordSeen(sequence: number, nonce: string, version: string): Promise<void> {
    await this.mutate((s) => {
      if (s.lastSeenSequence != null && sequence < s.lastSeenSequence) return; // 防回退
      s.lastSeenSequence = sequence;
      s.sequenceNonce[String(sequence)] = nonce;
      if (s.minInstalledVersion == null ||
          compareVersions(version, s.minInstalledVersion) > 0) {
        s.minInstalledVersion = version;
      }
    });
  }

  async markSuccess(at: number): Promise<void> {
    await this.mutate((s) => {
      s.lastSuccessAt = at;
      s.lastCheckedAt = at;
      s.failureCount = 0;
      s.deferredUntil = null;
    });
  }

  async markCheck(at: number): Promise<void> {
    await this.mutate((s) => {
      s.lastCheckedAt = at;
      s.failureCount += 1;
    });
  }

  async defer(at: number): Promise<void> {
    await this.mutate((s) => { s.deferredUntil = at; });
  }

  async skip(version: string): Promise<void> {
    await this.mutate((s) => {
      if (!s.skippedVersions.includes(version)) s.skippedVersions.push(version);
    });
  }

  /**
   * §6.6「重置 installId」：installId 只用于本地抖动 / 分桶，永不出网；
   * 重置会改变本机在检查周期上的散布，故调用方必须写审计。返回新生成的 id。
   */
  async regenerateInstallId(): Promise<string> {
    const next = randomUUID();
    await this.mutate((s) => { s.installId = next; });
    return next;
  }
}
