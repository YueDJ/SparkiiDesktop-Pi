/**
 * 主 Agent 集成单测：service 门面新增的活动量统计与 installId 重置（I-2 / I-3 / I-15）。
 * 全零网络：只用注入的 rt 假句柄 + 临时目录状态文件。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../electron/main/update/audit.js';
import { initUpdateService, type UpdateDeps } from '../electron/main/update/service.js';

let dir: string;
const SECRET = Buffer.alloc(32, 11);

function baseDeps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    dataDir: dir,
    currentVersion: '0.1.0',
    resourcesPath: join(dir, 'resources'),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    audit: { append: vi.fn(async () => ({})) },
    sendEvent: vi.fn(),
    loadSettings: async () => ({ update: { autoCheck: false } }),
    saveSettings: vi.fn(async () => {}),
    keyringSecret: async () => SECRET,
    now: () => Date.now(),
    ...over,
  } as UpdateDeps;
}

beforeEach(() => {
  resetAuditThrottle();
  dir = mkdtempSync(join(tmpdir(), 'sparkii-svc-act-'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('活动量统计（§7.5 安装确认的判定源）', () => {
  it('getState() 把 Main 侧的待审批数与活跃会话数如实带出', async () => {
    const svc = initUpdateService(baseDeps({
      rt: {
        pool: { stopAll: async () => {}, activeCount: () => 3 },
        auditStore: { close: () => {} },
        chatSessions: { close: () => {} },
        errors: { close: () => {} },
        gate: { abortPendingForQuit: async () => 0, listPending: () => [{ id: 'a' }, { id: 'b' }] },
        reviewer: { dispose: async () => {} },
        documentParseSupervisor: { beginQuit: async () => {} },
      },
    }));
    const s = await svc.getState();
    expect(s.activeSessions).toBe(3);
    expect(s.pendingApprovals).toBe(2);
  });

  it('未装配 rt（单测 / 降级装配）时为 0，绝不抛错', async () => {
    const svc = initUpdateService(baseDeps());
    const s = await svc.getState();
    expect(s.activeSessions).toBe(0);
    expect(s.pendingApprovals).toBe(0);
  });

  it('阶段变化推给 UI 的事件里也带最新活动量（安装弹窗不等第二次 IPC）', async () => {
    const sendEvent = vi.fn();
    let count = 0;
    const svc = initUpdateService(baseDeps({
      sendEvent,
      rt: {
        pool: { stopAll: async () => {}, activeCount: () => count },
        auditStore: { close: () => {} },
        chatSessions: { close: () => {} },
        errors: { close: () => {} },
        gate: { abortPendingForQuit: async () => 0, listPending: () => [] },
        reviewer: { dispose: async () => {} },
        documentParseSupervisor: { beginQuit: async () => {} },
      },
    }));
    count = 5;
    await svc.cancelDownload();     // 任何阶段变化都会 emit
    const last = sendEvent.mock.calls.at(-1) as [string, { activeSessions: number }];
    expect(last[0]).toBe('sparkii:event:update-state');
    expect(last[1].activeSessions).toBe(5);
  });
});

describe('resetInstallId（§6.6 第三入口）', () => {
  it('重置后 installId 真的换了，并写一条变更审计', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService(baseDeps({ audit }));
    const first = await svc.resetInstallId();
    expect(first.ok).toBe(true);
    const second = await svc.resetInstallId();
    expect(second.ok).toBe(true);
    // 返回文案里带新 id 的前缀，两次必须不同（证明确实重新生成并落盘）
    const head = (m?: string) => (m ?? '').split('：')[1] ?? '';
    expect(head(first.message)).not.toBe(head(second.message));
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.settings-changed'
      && String(c[0].payloadSummary).includes('installIdReset'))).toBe(true);
  });

  it('状态文件 HMAC 对不上（密钥换了）时拒绝重置 —— 与「损坏即拒绝一切自动更新」一致', async () => {
    // 用密钥 1 写一份合法状态，再用密钥 2 装配：读出来必然 mac 不符 ⇒ tampered。
    const a = initUpdateService(baseDeps({ keyringSecret: async () => Buffer.alloc(32, 1) }));
    await a.deferUpdate();
    const b = initUpdateService(baseDeps({ keyringSecret: async () => Buffer.alloc(32, 2) }));
    const r = await b.resetInstallId();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STATE_TAMPERED');
    const s = await b.getState();
    expect(s.stateTampered).toBe(true);
  });
});

describe('§7.10 启动延迟基准（回归：全新安装的首次检查不能被永久推迟）', () => {
  const freshDeps = (processStartedAt: () => number) => baseDeps({
    loadSettings: async () => ({
      update: { autoCheck: true, baseUrl: 'http://127.0.0.1:1/sparkii-updates/', startupDelaySeconds: 90 },
    }),
    processStartedAt,
    freeDiskBytes: 10 ** 12,
  });

  it('进程已启动 10 分钟、从未检查过 ⇒ 不再判 STARTUP_DELAY（改为真的去试一次）', async () => {
    const now = Date.now();
    const svc = initUpdateService(freshDeps(() => now - 10 * 60_000));
    const r = await svc.checkForUpdate(false);
    expect(r.reason).not.toBe('STARTUP_DELAY');
    // 端口关着 ⇒ 走真实网络失败路径，说明闸门确实放行了
    expect(r.reason).toBe('NETWORK');
  });

  it('刚刚启动（在延迟窗口内）⇒ 仍然判 STARTUP_DELAY，不抢启动带宽', async () => {
    const now = Date.now();
    const svc = initUpdateService(freshDeps(() => now));
    const r = await svc.checkForUpdate(false);
    expect(r.reason).toBe('STARTUP_DELAY');
  });

  it('缺省基准取自 process.uptime()，不取 now()（否则上一条例子永远不放行）', async () => {
    // 原来这条靠 vitest 进程自身的存活时长断言，落在 (95, 90+抖动] 这段窄窗里就可能翻转
    // ——属 R3 抓到的同一类「把运气当结论」。改成显式打桩，判定变成确定性。
    const uptimeSpy = vi.spyOn(process, 'uptime').mockReturnValue(600);   // 已运行 10 分钟
    try {
      const d = baseDeps({
        loadSettings: async () => ({
          update: { autoCheck: true, baseUrl: 'http://127.0.0.1:1/sparkii-updates/', startupDelaySeconds: 90 },
        }),
      });
      delete (d as { processStartedAt?: unknown }).processStartedAt;
      const svc = initUpdateService(d);
      const r = await svc.checkForUpdate(false);
      // 基准若取 now()，elapsed 恒为 0 ⇒ 永远 STARTUP_DELAY；取 uptime ⇒ 闸门放行、真的去试网络
      expect(r.reason).toBe('NETWORK');
    } finally {
      uptimeSpy.mockRestore();
    }
  });
});

describe('saveSettings 的地址语义（§6.6 / §7.4）', () => {
  it('合法 http 地址落盘走 merge，不丢 settings 的其它字段', async () => {
    const store: Record<string, unknown> = { rag: { baseUrl: 'http://rag.internal/' }, activeProviderId: 'deepseek' };
    const saveSettings = vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(store, patch);
    });
    const svc = initUpdateService(baseDeps({
      loadSettings: async () => store as never,
      saveSettings,
    }));
    const r = await svc.saveSettings({ baseUrl: 'http://10.8.0.5/sparkii-updates' });
    expect(r.ok).toBe(true);
    const written = saveSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.rag).toEqual({ baseUrl: 'http://rag.internal/' });   // merge 语义保留
    expect((written.update as Record<string, unknown>).baseUrl).toBe('http://10.8.0.5/sparkii-updates/');
    const cfg = await svc.getSettings();
    expect(cfg.baseUrl).toBe('http://10.8.0.5/sparkii-updates/');
    expect(cfg.autoDownload).toBe(false);
  });

  it('留空 = 关闭自动检查；非法 scheme 一律拒绝且不落盘', async () => {
    const saveSettings = vi.fn(async () => {});
    const svc = initUpdateService(baseDeps({ saveSettings }));
    expect((await svc.saveSettings({ baseUrl: '' })).ok).toBe(true);
    saveSettings.mockClear();
    const bad = await svc.saveSettings({ baseUrl: 'file:///C:/Windows/system32' });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('INVALID_BASE_URL');
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
