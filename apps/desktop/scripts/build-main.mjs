/*
 * Build the Electron main / preload / pi-runtime bundles.
 *
 * Replaces the four chained `esbuild` CLI calls in the old `build:main` script.
 * The reason is portability of the §5.4 build-time injection:
 * `__SPARKII_UPDATE_URL__` must default to an EMPTY STRING when
 * SPARKII_UPDATE_URL is unset (=> automatic checks disabled), on both POSIX sh
 * and Windows cmd.exe. Shell-based `--define:K="$VAR"` cannot do that on
 * cmd.exe (an unset %VAR% is left as the literal "%VAR%"). Using esbuild's JS
 * API with JSON.stringify() gives an exact, shell-independent string constant.
 *
 * Run from apps/desktop:  node scripts/build-main.mjs
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const CREATE_REQUIRE_BANNER =
  "import { createRequire as nodeCreateRequire } from 'module'; const require = nodeCreateRequire(import.meta.url);";

// §5.4: build-time default update source URL; runtime settings.update.baseUrl
// overrides it. Empty string means "auto check disabled until the user fills
// in an address". Never put a real server IP in the repository.
const updateUrl = process.env.SPARKII_UPDATE_URL ?? '';

// §6.3 / §8.3: release public keys are compiled in. The private key never
// enters the repo or the build machine's env; the publisher points this at a
// public-key JSON produced by scripts/release-keys.mjs. Unset => empty map =>
// every manifest fails verification (fail closed), never "accept unsigned".
const releaseKeysFile = process.env.SPARKII_RELEASE_KEYS_FILE ?? '';
let releaseKeys = '';
if (releaseKeysFile) {
  releaseKeys = readFileSync(releaseKeysFile, 'utf8');
  if (!releaseKeys.trim()) {
    throw new Error(`SPARKII_RELEASE_KEYS_FILE is empty: ${releaseKeysFile}`);
  }
}

const define = {
  __SPARKII_UPDATE_URL__: JSON.stringify(updateUrl),
  __SPARKII_RELEASE_PUBLIC_KEYS__: JSON.stringify(releaseKeys),
};

const esm = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron', 'better-sqlite3'],
  banner: { js: CREATE_REQUIRE_BANNER },
  define,
};

const entries = [
  { entryPoints: ['electron/main/index.ts'], ...esm, outfile: 'dist-electron/main/index.js' },
  {
    entryPoints: ['electron/preload/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    define,
    outfile: 'dist-electron/preload/index.cjs',
  },
  {
    entryPoints: ['electron/pi-runtime/utility-entry.ts'],
    ...esm,
    outfile: 'dist-electron/pi-runtime/utility-entry.js',
  },
  {
    entryPoints: ['electron/pi-runtime/fork-entry.ts'],
    ...esm,
    outfile: 'dist-electron/pi-runtime/fork-entry.js',
  },
];

for (const entry of entries) {
  await build(entry);
  console.log(`bundled ${entry.outfile}`);
}
console.log(`__SPARKII_UPDATE_URL__ = ${JSON.stringify(updateUrl)}`);
console.log(`__SPARKII_RELEASE_PUBLIC_KEYS__ = ${releaseKeys ? `inlined from ${releaseKeysFile}` : '(unset => verification fails closed)'}`);
