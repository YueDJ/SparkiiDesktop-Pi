import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(desktopRoot, 'electron-builder.config.mjs');
const ymlPath = join(desktopRoot, 'electron-builder.yml');
const pkgPath = join(desktopRoot, 'package.json');
const outDir = join(desktopRoot, 'out');
const latestYmlPath = join(outDir, 'latest.yml');
const appUpdateYmlPath = join(outDir, 'win-unpacked', 'resources', 'app-update.yml');
const company = '深圳宇岳向上科技有限公司';

// 任务正文给定的「非真实 IP」判定正则：排除 IPv4 字面量。
const IPV4 = /(\d{1,3}\.){3}\d{1,3}/;

type ExtraResource = { from: string; to: string };
type BuilderConfig = {
  appId: string;
  publish: { provider: string; url: string };
  win: { icon: string; target: string[]; verifyUpdateCodeSignature: boolean };
  nsis: {
    oneClick: boolean;
    perMachine: boolean;
    deleteAppDataOnUninstall: boolean;
    include: string;
    guid?: string | null;
  };
  artifactName: string;
  copyright: string;
  extraMetadata: { name: string; main: string };
  extraResources: ExtraResource[];
  directories: { output: string };
};

// 已删除的 electron-builder.yml 中 extraResources 的原样快照。
// 注：G2 任务正文标注「9 条」，但 yml（- from: 行 14/16/18/20/22/24/26/28）与
// 阶段 0 等价配置实测均为 8 条；按「全部键原样迁入 / 与 yml 一致」的权威要求以 8 条为准。
const YML_EXTRA_RESOURCES: ExtraResource[] = [
  { from: 'native/windows-sandbox/bin', to: 'windows-sandbox' },
  { from: '../../apps/desktop/agents', to: 'agents' },
  { from: 'runtime/portable-git.7z.exe', to: 'runtime/portable-git.7z.exe' },
  {
    from: 'runtime/document-parse/sparkii-document-parse.7z.exe',
    to: 'runtime/document-parse/sparkii-document-parse.7z.exe',
  },
  { from: 'runtime/document-parse/checksums.json', to: 'runtime/document-parse/checksums.json' },
  { from: 'runtime/tools/fd.exe', to: 'runtime/tools/fd.exe' },
  { from: 'runtime/tools/rg.exe', to: 'runtime/tools/rg.exe' },
  { from: 'runtime/tools/licenses', to: 'runtime/tools/licenses' },
];

async function loadConfig(): Promise<{ default: BuilderConfig; PLACEHOLDER_UPDATE_URL: string }> {
  // 变量形式的 file: URL + @vite-ignore：让 Vitest 走 Node 原生 ESM 直接加载 .mjs。
  const mod = await import(/* @vite-ignore */ pathToFileURL(configPath).href);
  return mod as { default: BuilderConfig; PLACEHOLDER_UPDATE_URL: string };
}

// 在独立 Node 子进程中加载配置，用于验证 SPARKII_OUT_DIR 覆盖：
// 每次都是全新进程，不受 ESM 模块缓存影响，也不会污染本测试进程的 env 与其它测试。
const configUrl = pathToFileURL(configPath).href;
const PROBE = 'import(process.env.CONFIG_URL).then(m => process.stdout.write(m.default.directories.output))';
function probeOutput(env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ['-e', PROBE], { env, encoding: 'utf8' });
}
function baseEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CONFIG_URL: configUrl };
}

describe('auto-update build artifacts (G2)', () => {
  it('publish 为 generic，url 为占位常量且不是真实 IP', async () => {
    const { default: config, PLACEHOLDER_UPDATE_URL } = await loadConfig();
    expect(config.publish.provider).toBe('generic');
    expect(config.publish.url).toBe(PLACEHOLDER_UPDATE_URL);
    expect(PLACEHOLDER_UPDATE_URL).toBe('http://localhost/sparkii-updates/');
    expect(IPV4.test(config.publish.url)).toBe(false);
  });

  it('win.verifyUpdateCodeSignature / target / icon', async () => {
    const { default: config } = await loadConfig();
    expect(config.win.verifyUpdateCodeSignature).toBe(false);
    expect(config.win.target).toEqual(['nsis']);
    expect(config.win.icon).toBe('build/icon.ico');
  });

  it('nsis per-user 静默安装配置', async () => {
    const { default: config } = await loadConfig();
    expect(config.nsis.oneClick).toBe(true);
    expect(config.nsis.perMachine).toBe(false);
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(config.nsis.include).toBe('build/installer.nsh');
  });

  it('nsis.guid 必须等于 appId（卸载注册表键 = 客户端安装目录解析键）', async () => {
    const { default: config } = await loadConfig();
    // electron-builder 缺省把卸载键写成 UUID.v5(appId)，而客户端按 appId 查
    // Uninstall\<appId> ⇒ 解析不到 ⇒ INSTALL_BLOCKED（真机 E2E 实测）。
    expect(config.nsis.guid).toBe(config.appId);
  });

  it('artifactName / copyright / extraMetadata 原样', async () => {
    const { default: config } = await loadConfig();
    expect(config.artifactName).toBe('Sparkii-${version}-win-${arch}.${ext}');
    expect(config.copyright).toContain(company);
    expect(config.extraMetadata).toEqual({
      name: 'sparkii-desktop',
      main: 'dist-electron/main/index.js',
    });
  });

  it('extraResources 原样迁入 yml 的 8 项，并追加随包发布的 watchdog 独立载体', async () => {
    const { default: config } = await loadConfig();
    // 前 8 项必须与已删除的 electron-builder.yml 逐字一致（迁移保真）。
    expect(config.extraResources!.slice(0, YML_EXTRA_RESOURCES.length)).toEqual(YML_EXTRA_RESOURCES);
    // 第 9 项是 B 关新增：§7.7 的 detached watchdog 必须在安装包内可达。
    // B1：载体是独立镜像名的 SEA 可执行文件（镜像名 ≠ Sparkii.exe，运行时再部署到 $INSTDIR 之外）。
    expect(config.extraResources).toHaveLength(YML_EXTRA_RESOURCES.length + 1);
    const watchdog = config.extraResources![YML_EXTRA_RESOURCES.length];
    expect(watchdog).toEqual({
      from: 'build/watchdog/sparkii-update-watchdog.exe',
      to: 'scripts/sparkii-update-watchdog.exe',
    });
    const blob = JSON.stringify(config.extraResources);
    for (const key of [
      'agents',
      'portable-git',
      'document-parse',
      'fd',
      'rg',
      'licenses',
      'windows-sandbox',
      'sparkii-update-watchdog.exe',
    ]) {
      expect(blob).toContain(key);
    }
    // 旧脚本载体不得再随包发布（否则又会有人在资源里找到它、绕开独立镜像）。
    expect(blob).not.toContain('update-watchdog.mjs');
  });

  it('directories.output 默认值为 out', () => {
    const env = baseEnv();
    delete env.SPARKII_OUT_DIR;
    expect(probeOutput(env)).toBe('out');
  });

  it('SPARKII_OUT_DIR 覆盖生效（设置/恢复 env，不污染其它测试）', () => {
    const prev = process.env.SPARKII_OUT_DIR;
    try {
      process.env.SPARKII_OUT_DIR = 'out-override-check';
      expect(probeOutput(baseEnv())).toBe('out-override-check');
    } finally {
      if (prev === undefined) delete process.env.SPARKII_OUT_DIR;
      else process.env.SPARKII_OUT_DIR = prev;
    }
    expect(process.env.SPARKII_OUT_DIR).toBe(prev);
  });

  it('electron-builder.yml 已删除（唯一构建配置载体）', () => {
    expect(existsSync(ymlPath)).toBe(false);
  });

  // 阶段 0 实跑构建后的产物；不存在时跳过而不是失败。
  // 明确不写「服务器会上传 latest.yml」的断言——设计 §6.1 禁止上传 latest.yml。
  it.skipIf(!existsSync(appUpdateYmlPath))('app-update.yml 不含 publisherName 与真实 IP', () => {
    const text = readFileSync(appUpdateYmlPath, 'utf8');
    expect(text).not.toContain('publisherName');
    expect(IPV4.test(text)).toBe(false);
  });

  it.skipIf(!existsSync(latestYmlPath))('latest.yml 不含真实 IP', () => {
    const text = readFileSync(latestYmlPath, 'utf8');
    expect(IPV4.test(text)).toBe(false);
  });

  // 该断言会先失败：package.json 是主 Agent 独占，G2 只提交改动清单。
  it('package.json scripts.dist 使用 .mjs 唯一配置载体', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.dist).toContain('--config electron-builder.config.mjs');
  });

  // B1：dist 必须先构建 watchdog 载体，再交给 electron-builder 收集 extraResources。
  // 只读 package.json 的静态事实（真正的"产物里有 exe"由构建机验证）。
  it('dist 在 electron-builder 之前构建 watchdog 载体', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:watchdog']).toBe('node scripts/build-watchdog-sea.mjs');
    const dist = pkg.scripts.dist!;
    expect(dist).toContain('build:watchdog');
    expect(dist.indexOf('build:watchdog')).toBeLessThan(dist.indexOf('electron-builder'));
  });
});
