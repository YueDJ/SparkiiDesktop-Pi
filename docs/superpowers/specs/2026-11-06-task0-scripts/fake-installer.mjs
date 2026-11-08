/*
 * Task 0 FAKE installer. Never executes NSIS, never writes /S, never touches
 * %LOCALAPPDATA% or any real data directory. It only records when it started
 * and whether the main process PID was already gone, then exits with a chosen
 * code so the watchdog's exitCode propagation can be asserted.
 *
 * Usage: node fake-installer.mjs --parent-pid <pid> --marker <path> --exit-code <n>
 */
import { writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const key = a.replace(/^--/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    out[key] = argv[++i];
  }
  return out;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

const args = parseArgs(process.argv.slice(2));
const parentPid = Number(args.parentPid);
const parentGone = !pidAlive(parentPid);
writeFileSync(args.marker, `${JSON.stringify({
  startedAt: Date.now(),
  isoTime: new Date().toISOString(),
  parentPid,
  parentGone,
  note: 'fake installer: no NSIS, no /S, no real install',
}, null, 2)}\n`, 'utf8');
process.exit(Number(args.exitCode ?? 0));
