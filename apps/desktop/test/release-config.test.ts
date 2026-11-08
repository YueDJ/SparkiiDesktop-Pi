import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const company = '深圳宇岳向上科技有限公司';
const configPath = join(desktopRoot, 'electron-builder.config.mjs');

type BuilderConfig = {
  productName: string;
  copyright: string;
  artifactName: string;
  appx?: unknown;
  win: { target: string[] };
  nsis: {
    oneClick: boolean;
    perMachine: boolean;
    deleteAppDataOnUninstall: boolean;
    allowToChangeInstallationDirectory?: unknown;
  };
  extraMetadata: { name: string; main: string };
};

async function loadConfig(): Promise<BuilderConfig> {
  // 变量 URL + @vite-ignore：让 Vitest 走 Node 原生 ESM 直接加载 .mjs
  const mod = await import(/* @vite-ignore */ pathToFileURL(configPath).href);
  return mod.default as BuilderConfig;
}

describe('Windows internal release configuration', () => {
  it('uses the legal company identity in package metadata', () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
      productName: string;
      author: unknown;
      scripts: Record<string, string>;
    };

    expect(pkg.productName).toBe('Sparkii');
    expect(pkg.author).toEqual({ name: company });
    expect(pkg.scripts.dist).toContain('electron-builder --win nsis');
    expect(pkg.scripts.dist).toContain('--config electron-builder.config.mjs');
    expect(pkg.scripts.dist).not.toContain('appx');
  });

  it('builds only an unsigned per-user NSIS installer', async () => {
    const config = await loadConfig();

    expect(config.productName).toBe('Sparkii');
    expect(config.copyright).toBe(`Copyright © 2026 ${company}`);
    expect(config.artifactName).toBe('Sparkii-${version}-win-${arch}.${ext}');
    expect(config.win.target).toEqual(['nsis']);
    expect(config.win.target).not.toContain('appx');
    expect(config.appx).toBeUndefined();
    expect(config.nsis.oneClick).toBe(true);
    expect(config.nsis.perMachine).toBe(false);
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(config.nsis.allowToChangeInstallationDirectory).toBeUndefined();
    expect(config.win.icon).toBe('build/icon.ico');   // R9 · D-5：这条在 yml→mjs 迁移时被丢掉，补回
    expect(config.extraMetadata).toEqual({
      name: 'sparkii-desktop',
      main: 'dist-electron/main/index.js',
    });
  });

  it('更新源占位与 publisherName 缺省：不依赖是否已构建（I-45）', async () => {
    // 产物侧的同名断言（test/update-artifacts.test.ts:154）是 it.skipIf(产物存在)，
    // 没构建时会静默跳过 ⇒ 这条从配置侧恒实跑，保证「没构建也不是没人查」。
    const config = await loadConfig();
    const publish = config.publish as { provider?: string; url?: string } | undefined;
    expect(publish?.provider).toBe('generic');
    expect(publish?.url).toBe('http://localhost/sparkii-updates/');
    expect(publish?.url).not.toMatch(/\d+\.\d+\.\d+\.\d+/);            // 不含真实 IPv4
    const win = config.win as { publisherName?: unknown };
    expect(win.publisherName).toBeUndefined();                          // §5.5：不写 ⇒ NsisUpdater 跳过签名校验的口径成立
  });
});
