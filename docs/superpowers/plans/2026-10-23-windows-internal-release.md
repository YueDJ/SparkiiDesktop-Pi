# Windows Internal Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a versioned, unsigned Windows x64 NSIS installer for controlled internal distribution that installs per user without administrator rights and displays 深圳宇岳向上科技有限公司 as the company in application and installer metadata.

**Architecture:** Keep the existing Electron/Vite/esbuild pipeline and change only the release contract around it: one stable artifact name, one NSIS target, per-user installation, exact company metadata, pinned runtime inputs, and a hash manifest generated after the installer is final. Automatic updates, MSIX, AutoLaunch, and code signing remain out of scope.

**Tech Stack:** Electron 44, electron-builder 26, NSIS, pnpm 9 workspace, Vite, esbuild, Vitest, PowerShell.

**Spec:** User-approved packaging decisions recorded in this plan on 2026-10-23.

## Global Constraints

- Target Windows x64 only for this release.
- Deliver NSIS only; do not build MSIX/AppX.
- Install per user and do not require administrator rights.
- First release is intentionally unsigned; SmartScreen may show an unknown publisher.
- Use exactly `深圳宇岳向上科技有限公司` for the company name.
- Use exactly `Copyright © 2026 深圳宇岳向上科技有限公司` for copyright metadata.
- Keep product name `Sparkii` and application ID `com.sparkii.desktop`.
- Do not implement automatic update, code signing, MSIX, OS auto-start, or new network services.
- Do not delete `%LOCALAPPDATA%\SparkiiDesktop\data` during install, upgrade, or uninstall.
- A release artifact is not deliverable until its SHA256 is generated after packaging.

---

### Task 1: Lock Product Metadata And Per-User NSIS Contract

**Files:**
- Create: `apps/desktop/test/release-config.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron-builder.yml`

**Interfaces:**
- Consumes: electron-builder's `author.name` as the Windows `CompanyName`.
- Produces: `Sparkii-<version>-win-x64.exe` as the only Windows artifact.

- [ ] **Step 1: Write the failing release configuration test**

Create `apps/desktop/test/release-config.test.ts`:

```ts
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
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/release-config.test.ts
```

Expected: FAIL because the current author is `Sparkii`, the installer is assisted, and AppX is still enabled.

- [ ] **Step 3: Update desktop package metadata and release command**

In `apps/desktop/package.json`, replace:

```json
"author": "Sparkii",
```

with:

```json
"author": {
  "name": "深圳宇岳向上科技有限公司"
},
```

Change the `dist` script from:

```json
"dist": "pnpm ensure:runtime && pnpm build:renderer && pnpm build:main && node scripts/install-native-deps.mjs --rebuild && electron-builder --win nsis appx",
```

to:

```json
"dist": "pnpm ensure:runtime && pnpm build:renderer && pnpm build:main && node scripts/install-native-deps.mjs --rebuild && electron-builder --win nsis",
```

- [ ] **Step 4: Update electron-builder metadata and NSIS mode**

Add these top-level properties to `apps/desktop/electron-builder.yml`:

```yaml
copyright: "Copyright © 2026 深圳宇岳向上科技有限公司"
artifactName: "Sparkii-${version}-win-${arch}.${ext}"
```

Replace the existing `win`, `appx`, and `nsis` blocks with:

```yaml
win:
  icon: build/icon.ico
  target:
    - nsis
nsis:
  oneClick: true
  perMachine: false
  deleteAppDataOnUninstall: false
  include: build/installer.nsh
```

- [ ] **Step 5: Run the focused test**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/release-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the release contract**

```powershell
git add apps/desktop/package.json apps/desktop/electron-builder.yml apps/desktop/test/release-config.test.ts
git commit -m "build(desktop): define internal Windows release contract"
```

### Task 2: Show Company And Release Status In Settings

**Files:**
- Create: `apps/desktop/src/branding.ts`
- Modify: `apps/desktop/src/shell/SettingsView.tsx`
- Modify: `apps/desktop/test/settings-view.test.tsx`

**Interfaces:**
- Produces: `COMPANY_NAME`, `PRODUCT_NAME`, and `RELEASE_CHANNEL` string constants.
- Consumes: the existing settings navigation and `SettingsRow` UI primitive.

- [ ] **Step 1: Write the failing about-pane test**

Append to `apps/desktop/test/settings-view.test.tsx`:

```tsx
describe('SettingsView about pane', () => {
  it('shows the company and unsigned internal release status', () => {
    render(<SettingsView api={makeApi()} />);
    fireEvent.click(screen.getByText('关于'));

    expect(screen.getByText('深圳宇岳向上科技有限公司')).toBeTruthy();
    expect(screen.getByText('内部试用版（未签名）')).toBeTruthy();
    expect(screen.getByText(/SmartScreen/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/settings-view.test.tsx -t "about pane"
```

Expected: FAIL because the `关于` navigation item does not exist.

- [ ] **Step 3: Add shared branding constants**

Create `apps/desktop/src/branding.ts`:

```ts
export const COMPANY_NAME = '深圳宇岳向上科技有限公司';
export const PRODUCT_NAME = 'Sparkii';
export const RELEASE_CHANNEL = '内部试用版（未签名）';
```

- [ ] **Step 4: Add the about pane**

In `apps/desktop/src/shell/SettingsView.tsx`:

- import `COMPANY_NAME`, `PRODUCT_NAME`, and `RELEASE_CHANNEL` from `../branding.js`;
- append `'about'` to `PANES`;
- add `about: '关于'` to `PANE_LABELS`;
- render this pane before `audit`:

```tsx
{pane === 'about' && (
  <>
    <h3 className="settings-section-title">关于</h3>
    <SettingsRow label="产品"><span className="ui-kv">{PRODUCT_NAME}</span></SettingsRow>
    <SettingsRow label="公司"><span className="ui-kv">{COMPANY_NAME}</span></SettingsRow>
    <SettingsRow label="发布渠道"><span className="ui-kv">{RELEASE_CHANNEL}</span></SettingsRow>
    <div className="ui-muted settings-hint">
      当前安装包未购买代码签名证书；首次运行时 Windows SmartScreen 可能提示未知发布者。
    </div>
  </>
)}
```

- [ ] **Step 5: Run the focused and existing settings tests**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/settings-view.test.tsx apps/desktop/test/settings.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the visible company identity**

```powershell
git add apps/desktop/src/branding.ts apps/desktop/src/shell/SettingsView.tsx apps/desktop/test/settings-view.test.tsx
git commit -m "feat(desktop): show company identity in settings"
```

### Task 3: Pin The Portable Git Build Input

**Files:**
- Create: `apps/desktop/scripts/runtime-checksums.mjs`
- Create: `apps/desktop/test/runtime-checksums.test.ts`
- Modify: `apps/desktop/scripts/ensure-runtime.mjs`

**Interfaces:**
- Produces: `PORTABLE_GIT_ARCHIVE_SHA256: string`.
- Consumes: the existing `verifySha256(dest, expectedSha256)` helper in `ensure-runtime.mjs`.

- [ ] **Step 1: Write the failing checksum test**

Create `apps/desktop/test/runtime-checksums.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PORTABLE_GIT_ARCHIVE_SHA256 } from '../scripts/runtime-checksums.mjs';

describe('packaged runtime checksums', () => {
  it('pins the current Portable Git archive by SHA256', () => {
    expect(PORTABLE_GIT_ARCHIVE_SHA256).toBe(
      'ab00566336b5472120f9a52d34f2e79c5406535792acb0548001ffd0bd090e5d',
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/runtime-checksums.test.ts
```

Expected: FAIL because `runtime-checksums.mjs` does not exist.

- [ ] **Step 3: Add the pinned checksum**

Create `apps/desktop/scripts/runtime-checksums.mjs`:

```js
export const PORTABLE_GIT_ARCHIVE_SHA256 =
  'ab00566336b5472120f9a52d34f2e79c5406535792acb0548001ffd0bd090e5d';
```

- [ ] **Step 4: Verify both existing and downloaded archives**

In `apps/desktop/scripts/ensure-runtime.mjs`, import the checksum:

```js
import { PORTABLE_GIT_ARCHIVE_SHA256 } from './runtime-checksums.mjs';
```

Replace the archive preparation block with:

```js
if (!hasArchive) {
  console.log(`downloading ${URL}`);
  await download(URL, archivePath);
}

await verifySha256(archivePath, PORTABLE_GIT_ARCHIVE_SHA256);

if (!hasRuntime) {
  console.log(`extracting to ${portableGitDir}`);
  mkdirSync(portableGitDir, { recursive: true });
  extract(archivePath, portableGitDir);
}
```

- [ ] **Step 5: Run the checksum and runtime tests**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/runtime-checksums.test.ts apps/desktop/test/runtime-provision.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the pinned runtime**

```powershell
git add apps/desktop/scripts/runtime-checksums.mjs apps/desktop/test/runtime-checksums.test.ts apps/desktop/scripts/ensure-runtime.mjs
git commit -m "build(desktop): pin Portable Git archive"
```

### Task 4: Generate Final Release Integrity Files

**Files:**
- Create: `apps/desktop/scripts/create-release-manifest.mjs`
- Create: `apps/desktop/test/create-release-manifest.test.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Produces: `createReleaseManifest({ artifactPath, outputDir, version, commit, builtAt }): Promise<ReleaseManifest>`.
- Produces files in `apps/desktop/out/`: `release-manifest.json` and `SHA256SUMS.txt`.

- [ ] **Step 1: Write the failing manifest test**

Create `apps/desktop/test/create-release-manifest.test.ts`:

```ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReleaseManifest } from '../scripts/create-release-manifest.mjs';

describe('createReleaseManifest', () => {
  it('writes reproducible artifact metadata and SHA256SUMS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-release-'));
    const out = join(root, 'out');
    mkdirSync(out);
    const artifactPath = join(out, 'Sparkii-0.1.0-win-x64.exe');
    writeFileSync(artifactPath, 'installer');

    const manifest = await createReleaseManifest({
      artifactPath,
      outputDir: out,
      version: '0.1.0',
      commit: 'abc123',
      builtAt: '2026-10-23T00:00:00.000Z',
    });

    expect(manifest).toMatchObject({
      product: 'Sparkii',
      version: '0.1.0',
      platform: 'win-x64',
      commit: 'abc123',
      unsigned: true,
      artifact: 'Sparkii-0.1.0-win-x64.exe',
    });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(join(out, 'release-manifest.json'), 'utf8'))).toEqual(manifest);
    expect(readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8')).toBe(
      `${manifest.sha256}  Sparkii-0.1.0-win-x64.exe\n`,
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/create-release-manifest.test.ts
```

Expected: FAIL because the manifest module does not exist.

- [ ] **Step 3: Implement the manifest generator**

Create `apps/desktop/scripts/create-release-manifest.mjs` with:

- an exported async `createReleaseManifest({ artifactPath, outputDir, version, commit, builtAt })`;
- SHA256 computed from the final artifact bytes;
- atomic writes for `release-manifest.json` and `SHA256SUMS.txt`;
- a CLI main path that accepts `--artifact`, `--version`, and `--commit`, defaults `builtAt` to the current ISO time, and resolves the desktop output directory.

- [ ] **Step 4: Run the focused test**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/create-release-manifest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Append manifest generation after electron-builder**

Change `apps/desktop/package.json` `dist` so it ends with:

```json
"electron-builder --win nsis && node scripts/create-release-manifest.mjs"
```

- [ ] **Step 6: Commit release manifest generation**

```powershell
git add apps/desktop/scripts/create-release-manifest.mjs apps/desktop/test/create-release-manifest.test.ts apps/desktop/package.json
git commit -m "build(desktop): generate signed release manifest"
```

### Task 5: Build And Verify The Internal Installer

**Files:**
- Create: `docs/release-windows.md`
- Modify: `docs/deploy.md`

**Interfaces:**
- Consumes: the `dist` script and release manifest from earlier tasks.
- Produces: a versioned installer and SHA256 for controlled internal distribution.

- [ ] **Step 1: Document the release procedure**

Create `docs/release-windows.md` with these exact sections:

- prerequisites: Windows x64, Node >=22, pnpm >=9, C++ build tools only when native rebuild is required;
- build: `pnpm --dir apps/desktop dist`;
- expected output: `Sparkii-<version>-win-x64.exe`, `release-manifest.json`, `SHA256SUMS.txt`;
- install behavior: no elevation, per-user installation, first-run runtime extraction, data under `%LOCALAPPDATA%\SparkiiDesktop\data`;
- unsigned warning: SmartScreen may show an unknown publisher and this build must remain internal-only;
- release checks: hash, file version/company metadata, clean Windows 10/11 VM install, upgrade with data preserved, uninstall with data preserved.

- [ ] **Step 2: Correct the deployment document**

In `docs/deploy.md`, replace claims that MSIX is part of the current release with:

```md
当前内部试用版仅发布 Windows x64 NSIS 安装包。MSIX、代码签名和自动更新均不包含在首版范围内。
```

- [ ] **Step 3: Run the full automated verification**

Run:

```powershell
pnpm typecheck
.\node_modules\.bin\vitest.cmd run
```

Expected: all tests pass except the documented Windows ACL environment test in `windows-sandbox-spike.test.ts` when the host cannot grant runtime ACLs.

- [ ] **Step 4: Build from a cleaned output directory**

Resolve and remove only `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\out`, then run:

```powershell
pnpm --dir apps/desktop dist
```

Expected: exits zero and produces the NSIS installer plus manifest in `apps/desktop/out`.

- [ ] **Step 5: Verify artifact metadata and final hash**

Run:

```powershell
$artifact = Get-ChildItem -LiteralPath 'apps/desktop/out' -File |
  Where-Object { $_.Name -like 'Sparkii-*-win-x64.exe' } |
  Select-Object -First 1
$artifact.VersionInfo | Select-Object CompanyName,ProductName,FileVersion,LegalCopyright
Get-AuthenticodeSignature -LiteralPath $artifact.FullName |
  Select-Object Status,StatusMessage
Get-Content -LiteralPath 'apps/desktop/out/release-manifest.json'
```

Expected:

- `CompanyName` equals `深圳宇岳向上科技有限公司`;
- `ProductName` equals `Sparkii`;
- signature status is `NotSigned`, matching the approved release scope;
- manifest SHA256 matches `SHA256SUMS.txt`.

- [ ] **Step 6: Perform the manual clean-machine acceptance test**

On a Windows 10 or Windows 11 x64 test user profile without Node/pnpm/Visual Studio:

1. Install the unsigned package as a standard user.
2. Confirm no administrator prompt is required.
3. Launch Sparkii and wait for first-run runtime preparation.
4. Confirm the settings > 关于 pane shows the company and unsigned status.
5. Create test data, install the same version over itself, and confirm data remains.
6. Uninstall and confirm `%LOCALAPPDATA%\SparkiiDesktop\data` remains.

- [ ] **Step 7: Commit documentation**

```powershell
git add docs/release-windows.md docs/deploy.md
git commit -m "docs: document unsigned internal Windows release"
```
