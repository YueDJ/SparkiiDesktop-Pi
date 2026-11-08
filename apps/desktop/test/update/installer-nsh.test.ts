/*
 * NSIS 安装握手的静态断言（B1 / M1 / M2 的测试盲区补丁）。
 *
 * 为什么需要这一层：历史上 update-watchdog.test.ts 只用假 `.mjs` 安装器，
 * 从不执行真实 NSIS 模板 —— 于是「watchdog 被 CHECK_APP_RUNNING 杀掉」「静默装完不重启」
 * 「升级重解压运行时」三类缺陷一个都抓不到（审核报告 §6 的测试盲区）。
 * 真机验证仍在隔离 VM 里做（见交付清单），但这里把**模板事实**与**我们宏的结构**
 * 钉成可回归的断言：模板一旦升级改了匹配规则、或我们的宏把守卫/版本粒度改回去，这里会红。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(desktopRoot, '..', '..');
const nshPath = join(desktopRoot, 'build', 'installer.nsh');

function readNsh(): string {
  return readFileSync(nshPath, 'utf8');
}

/** 取一个 `!macro name … !macroend` 的正文（不含首尾行）。 */
function macroBody(source: string, name: string): string {
  const start = source.indexOf(`!macro ${name}`);
  expect(start, `找不到 !macro ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('!macroend', start);
  expect(end, `!macro ${name} 没有 !macroend`).toBeGreaterThan(start);
  return source.slice(start + `!macro ${name}`.length, end);
}

/** 真实的 app-builder-lib NSIS 模板目录（pnpm store 里按包名定位，避免硬编码哈希后缀）。 */
function findNsisTemplates(): string {
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');
  expect(existsSync(pnpmDir), `缺少 pnpm store：${pnpmDir}`).toBe(true);
  const candidates = readdirSync(pnpmDir)
    .filter((name) => name.startsWith('app-builder-lib@'))
    .map((name) => join(pnpmDir, name, 'node_modules', 'app-builder-lib', 'templates', 'nsis'))
    .filter((dir) => existsSync(join(dir, 'installSection.nsh')));
  expect(candidates.length, '找不到 app-builder-lib 的 NSIS 模板（依赖未安装？）').toBeGreaterThan(0);
  return candidates[0]!;
}

const TEMPLATES = findNsisTemplates();
const template = (rel: string): string => readFileSync(join(TEMPLATES, rel), 'utf8');

describe('真实 NSIS 模板：B1 的两个 kill 点与文件锁前提（模板升级即需要重新评估修复）', () => {
  it('第一 kill 点：oneClick 静默安装也执行 CHECK_APP_RUNNING（在 ${IfNot} ${Silent} 块之外）', () => {
    const text = template('installSection.nsh');
    // 静默块以 ${endif} 结束，紧接着才是 CHECK_APP_RUNNING ⇒ 「静默也查」这一事实被钉住。
    expect(text).toMatch(/\$\{endif\}\s*\r?\n\s*!insertmacro CHECK_APP_RUNNING/);
    // 且它位于 ONE_CLICK 分支内（installer.nsi 的 assisted 分支另有条件）。
    const oneClick = text.indexOf('!ifdef ONE_CLICK');
    const check = text.indexOf('!insertmacro CHECK_APP_RUNNING');
    expect(oneClick).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(oneClick);
  });

  it('第二 kill 点：旧卸载器在静默模式下 call un.checkAppRunning，且 installUtil 以 --updated 运行它', () => {
    const un = template('uninstaller.nsh');
    expect(un).toMatch(/\$\{If\} \$\{Silent\}\s*\r?\n\s*call un\.checkAppRunning/);
    const util = template(join('include', 'installUtil.nsh'));
    // 旧卸载器命令行写死，$0 只带 --updated / --keep-shortcuts / --delete-app-data ⇒
    // /WATCHDOG_PID= 之类的豁免参数送不到第二 kill 点（方案 A 被否决的事实依据）。
    expect(util).toContain('StrCpy $0 "$0 --updated"');
    expect(util).toMatch(/ExecWait '"\$uninstallerFileNameTemp" \/S \/KEEP_APP_DATA \$0 _\?=\$installationDir'/);
    expect(util).not.toContain('WATCHDOG_PID');
  });

  it('第三个失效点：升级时 un.atomicRMDir 逐文件 Rename，占用即 Abort（watchdog 不能持有 $INSTDIR 内镜像）', () => {
    const un = template('uninstaller.nsh');
    expect(un).toContain('Function un.atomicRMDir');
    expect(un).toContain('File is busy, aborting');
    expect(un).toMatch(/Abort `Can't rename/);
    // kill 匹配规则（独立镜像名 + $INSTDIR 外部署才能同时避开）
    const guard = template(join('include', 'allowOnlyOneInstallerInstance.nsh'));
    expect(guard).toContain("Path.StartsWith('$INSTDIR'");
    expect(guard).toContain('IMAGENAME eq ${_FILE}');
  });
});

describe('build/installer.nsh：M1 所需的重启语义 / M2 的标记粒度与 isUpdated 守卫', () => {
  it('M1 前提：静默重启只认 isForceRun，--updated 通过 StartApp 传给重启后的 app', () => {
    const section = template('installSection.nsh');
    expect(section).toMatch(/\$\{ifNot\} \$\{Silent\}\s*\r?\n\s*\$\{orIf\} \$\{isForceRun\}/);
    const common = template('common.nsh');
    expect(common).toMatch(/\$\{if\} \$\{isUpdated\}\s*\r?\n\s*StrCpy \$startAppArgs "--updated"/);
  });

  it('M2 层2：标记粒度是 RUNTIME_VERSION 常量，不再拿 app 版本 ${VERSION} 当标记', () => {
    const nsh = readNsh();
    expect(nsh).toMatch(/^!define SPARKII_RUNTIME_VERSION "[^"]+"$/m);
    const install = macroBody(nsh, 'customInstall');
    expect(install).toContain('StrCmp $8 "${SPARKII_RUNTIME_VERSION}"');
    expect(install).toContain('FileWrite $9 "${SPARKII_RUNTIME_VERSION}"');
    // 注释里也不许再出现「用 ${VERSION} 当标记」的旧口径（M2 的假前提正是它）。
    expect(nsh).not.toContain('${VERSION}');
  });

  it('M2 层1：customUnInstall 的全部清理都在 ${ifNot} ${isUpdated} 守卫内（升级跳过、完整卸载照旧）', () => {
    const un = macroBody(readNsh(), 'customUnInstall');
    const guardAt = un.indexOf('${ifNot} ${isUpdated}');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    const endifAt = un.indexOf('${endif}', guardAt);
    expect(endifAt).toBeGreaterThan(guardAt);
    const before = un.slice(0, guardAt);
    const inside = un.slice(guardAt, endifAt);
    const after = un.slice(endifAt + '${endif}'.length);
    // 守卫外不得有任何运行时 / 标记清理。
    expect(before).not.toMatch(/\b(?:RMDir|Delete|CopyFiles)\b/);
    expect(after).not.toMatch(/\b(?:RMDir|Delete|CopyFiles)\b/);
    // 清理范围与本修复前逐项一致（只 runtime + tools + data\pi-agent\bin + 标记）。
    const paths = [...inside.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.replace(/\.exe$/, '.exe'));
    expect(paths).toEqual([
      '$LOCALAPPDATA\\SparkiiDesktop\\runtime\\portable-git',
      '$LOCALAPPDATA\\SparkiiDesktop\\runtime\\document-parse',
      '$LOCALAPPDATA\\SparkiiDesktop\\runtime\\tools\\fd.exe',
      '$LOCALAPPDATA\\SparkiiDesktop\\runtime\\tools\\rg.exe',
      '$LOCALAPPDATA\\SparkiiDesktop\\runtime\\tools',
      '$LOCALAPPDATA\\SparkiiDesktop\\runtime\\sparkii-runtime.version',
      '$LOCALAPPDATA\\SparkiiDesktop\\data\\pi-agent\\bin\\fd.exe',
      '$LOCALAPPDATA\\SparkiiDesktop\\data\\pi-agent\\bin\\rg.exe',
      '$LOCALAPPDATA\\SparkiiDesktop\\data\\pi-agent\\bin',
    ]);
  });

  it('customInstall 不写 install-result.json（写入方唯一 = watchdog）', () => {
    const nsh = readNsh();
    expect(macroBody(nsh, 'customInstall')).not.toContain('install-result.json');
  });

  it('customUnInstall 在升级路径上先于 customInstall 执行（M2 必须靠 isUpdated 守卫而非顺序）', () => {
    const section = template('installSection.nsh');
    const uninstallAt = section.indexOf('!insertmacro uninstallOldVersion');
    const customAt = section.indexOf('!insertmacro customInstall');
    expect(uninstallAt).toBeGreaterThanOrEqual(0);
    expect(customAt).toBeGreaterThan(uninstallAt);
  });
});
