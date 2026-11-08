/*
 * Task 0 measurement watchdog (standalone, NOT shipped code).
 *
 * Reproduces the §7.7 / §9 B-gate contract:
 *   1. wait for the main process PID to disappear (do NOT install before that)
 *   2. only then spawn the installer
 *   3. capture exitCode and write install-result.json ONCE (single writer)
 *
 * No real NSIS installer, no /S, no user data. The "installer" is a Node
 * script with a deterministic exit code, run inside a temp directory.
 *
 * Usage:
 *   node watchdog.mjs --parent-pid <pid> --sentinel <path> \
 *     --installer <path> --result <path> --timeout-ms <n> \
 *     --installer-arg <arg> ...
 */
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function parseArgs(argv) {
  const out = { installerArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--installer-arg') { out.installerArgs.push(argv[++i]); continue; }
    const key = a.replace(/^--/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const parentPid = Number(args.parentPid);
const timeoutMs = Number(args.timeoutMs ?? 60_000);
const resultPath = args.result;
const sentinelPath = args.sentinel;
const installerPath = args.installer;

/** Windows: process.kill(pid, 0) throws ESRCH once the PID is gone. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

/** Atomic single write: no other process writes install-result.json. */
function writeResult(payload) {
  const tmp = `${resultPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, resultPath);
}

async function main() {
  let sentinel = {};
  try { sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8')); } catch { /* tolerate */ }

  const startedAt = Date.now();
  let parentGoneAt = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidAlive(parentPid)) { parentGoneAt = Date.now(); break; }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (parentGoneAt === null) {
    writeResult({
      ok: false, exitCode: null, reason: 'main-process-timeout',
      waitedMs: Date.now() - startedAt, targetVersion: sentinel.targetVersion ?? null,
      writtenAt: new Date().toISOString(), writer: 'watchdog',
    });
    return 2;
  }

  const installer = spawn(process.execPath, [installerPath, ...args.installerArgs], {
    detached: false, stdio: 'ignore', windowsHide: true,
  });
  const exitCode = await new Promise((resolve) => {
    installer.on('exit', (code, signal) => resolve(code ?? (signal ? -1 : 0)));
    installer.on('error', () => resolve(-1));
  });
  writeResult({
    ok: exitCode === 0, exitCode,
    targetVersion: sentinel.targetVersion ?? null,
    packageSha512: sentinel.packageSha512 ?? null,
    parentGoneAt: new Date(parentGoneAt).toISOString(),
    writtenAt: new Date().toISOString(), writer: 'watchdog',
  });
  return 0;
}

const code = await main();
// Sanity: confirm the result file exists before the watchdog exits.
if (!existsSync(resultPath)) {
  console.error('watchdog did not write install-result.json');
  process.exitCode = 3;
} else {
  process.exitCode = code;
}
void join; void dirname;
