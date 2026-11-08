/*
 * Task 0 ONLY measurement config. It is a byte-for-byte stand-in for the
 * planned production `apps/desktop/electron-builder.config.mjs` (design §5.4):
 * every key of the existing electron-builder.yml is migrated here, plus
 * `publish: generic` and `win.verifyUpdateCodeSignature: false`.
 *
 * It is NOT the production config and is NOT used by `pnpm dist`. It exists so
 * that Task 0 can measure `--config ... --publish never` artifact generation
 * without starting A-gate implementation before the §5.2 decision.
 *
 * Reproduce from apps/desktop:
 *   node ../../node_modules/electron-builder/out/cli/cli.js \
 *     --win nsis --publish never \
 *     --config ../../docs/superpowers/specs/2026-11-06-task0-scripts/electron-builder.task0.config.mjs
 */

export const PLACEHOLDER_UPDATE_URL = 'http://localhost/sparkii-updates/';

export default {
  appId: 'com.sparkii.desktop',
  productName: 'Sparkii',
  copyright: 'Copyright © 2026 深圳宇岳向上科技有限公司',
  artifactName: 'Sparkii-${version}-win-${arch}.${ext}',
  directories: { output: 'out' },
  files: ['dist/**', 'dist-electron/**', 'dist-electron/pi-runtime/**', 'package.json'],
  asar: true,
  extraResources: [
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
  ],
  win: { icon: 'build/icon.ico', target: ['nsis'], verifyUpdateCodeSignature: false },
  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    include: 'build/installer.nsh',
  },
  extraMetadata: { name: 'sparkii-desktop', main: 'dist-electron/main/index.js' },
  publish: { provider: 'generic', url: PLACEHOLDER_UPDATE_URL },
};
