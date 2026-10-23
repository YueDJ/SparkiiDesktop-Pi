import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const company = '深圳宇岳向上科技有限公司';

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
    expect(pkg.scripts.dist).not.toContain('appx');
  });

  it('builds only an unsigned per-user NSIS installer', () => {
    const config = readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8');

    expect(config).toContain(`copyright: "Copyright © 2026 ${company}"`);
    expect(config).toContain('artifactName: "Sparkii-${version}-win-${arch}.${ext}"');
    expect(config).toMatch(/win:\s*\n\s+icon: build\/icon\.ico\s*\n\s+target:\s*\n\s+- nsis/);
    expect(config).not.toMatch(/^appx:/m);
    expect(config).toContain('oneClick: true');
    expect(config).toContain('perMachine: false');
    expect(config).toContain('deleteAppDataOnUninstall: false');
    expect(config).not.toContain('allowToChangeInstallationDirectory');
    expect(config).toMatch(/extraMetadata:\s*\n\s+name: sparkii-desktop/);
  });
});
