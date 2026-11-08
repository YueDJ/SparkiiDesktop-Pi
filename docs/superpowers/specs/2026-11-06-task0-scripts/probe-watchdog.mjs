/*
 * Task 0 / B-gate watchdog measurement orchestrator.
 *
 * Scenarios (all in an isolated temp dir, using a FAKE installer):
 *   S1 success  : parent exits after 800ms; watchdog must wait, then spawn,
 *                 capturing exitCode 7 and writing install-result.json once.
 *   S2 failure  : installer exits 3; watchdog must record ok:false, exitCode:3.
 *   S3 timeout  : parent stays alive 2s; watchdog timeout 300ms; installer must
 *                 NOT be spawned and result must be reason:'main-process-timeout'.
 *
 * No real NSIS, no /S, no UAC prompt, no writes outside the temp directory.
 * Run from repo root:
 *   node docs/superpowers/specs/2026-11-06-task0-scripts/probe-watchdog.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'sparkii-task0-watchdog-'));
const watchdog = join(here, 'watchdog.mjs');
const fakeInstaller = join(here, 'fake-installer.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake "main process" that stays alive for `lifeMs` then exits. */
function spawnParent(lifeMs) {
  const script = `setTimeout(() => process.exit(0), ${lifeMs});`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  // Attach the exit listener immediately: the watchdog may finish AFTER the
  // parent has already exited, so a late listener would never fire.
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, at: Date.now() }));
  });
  return { child, exited };
}

function runWatchdog(opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      watchdog,
      '--parent-pid', String(opts.parentPid),
      '--sentinel', opts.sentinel,
      '--installer', fakeInstaller,
      '--result', opts.result,
      '--timeout-ms', String(opts.timeoutMs ?? 5000),
      '--installer-arg', '--parent-pid', '--installer-arg', String(opts.parentPid),
      '--installer-arg', '--marker', '--installer-arg', opts.marker,
      '--installer-arg', '--exit-code', '--installer-arg', String(opts.exitCode),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => resolve({ code, err }));
  });
}

async function scenario(name, { lifeMs, timeoutMs, exitCode }) {
  const dir = join(tmp, name);
  const fs = await import('node:fs/promises');
  await fs.mkdir(dir, { recursive: true });
  const sentinel = join(dir, 'pending-update.json');
  const result = join(dir, 'install-result.json');
  const marker = join(dir, 'fake-installer-marker.json');
  writeFileSync(sentinel, `${JSON.stringify({
    phase: 'installing', targetVersion: '0.2.0', packageSha512: 'FAKE',
  }, null, 2)}\n`, 'utf8');
  const { child: parent, exited: parentExited } = spawnParent(lifeMs);
  const parentSpawnAt = Date.now();
  const watchdogRun = await runWatchdog({
    parentPid: parent.pid, sentinel, result, marker, timeoutMs, exitCode,
  });
  // Wait for the fake parent to finish too (timeout scenario).
  const parentDeath = await parentExited;
  const parentDeathAt = parentDeath.at;
  const resultJson = existsSync(result) ? JSON.parse(readFileSync(result, 'utf8')) : null;
  const markerJson = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
  return {
    name,
    parentPid: parent.pid,
    parentSpawnAt,
    parentDeathAt,
    watchdogExitCode: watchdogRun.code,
    watchdogStderr: watchdogRun.err.trim(),
    resultWritten: resultJson !== null,
    result: resultJson,
    installerSpawned: markerJson !== null,
    installerMarker: markerJson,
    installerStartedAfterParentGone: markerJson
      ? markerJson.parentGone === true && markerJson.startedAt >= parentSpawnAt + lifeMs - 150
      : null,
  };
}

(async () => {
  const report = {
    task: 'task0-watchdog-probe',
    ranAt: new Date().toISOString(),
    node: process.version,
    isolation: 'temp dir + fake installer script only; no NSIS /S, no real data',
  };
  try {
    report.success = await scenario('success', { lifeMs: 800, timeoutMs: 5000, exitCode: 0 });
    report.installerFailure = await scenario('failure', { lifeMs: 400, timeoutMs: 5000, exitCode: 3 });
    report.timeout = await scenario('timeout', { lifeMs: 1200, timeoutMs: 300, exitCode: 0 });
    report.assertions = {
      successExitCodeZero: report.success.result?.exitCode === 0,
      successParentGoneBeforeSpawn: report.success.installerStartedAfterParentGone === true,
      failureExitCodePropagated: report.installerFailure.result?.exitCode === 3,
      failureMarkedNotOk: report.installerFailure.result?.ok === false,
      timeoutNoInstaller: report.timeout.installerSpawned === false,
      timeoutWritesFailedResult: report.timeout.result?.reason === 'main-process-timeout',
      singleWriter: [report.success, report.installerFailure, report.timeout]
        .every((s) => s.result?.writer === 'watchdog'),
    };
    report.pass = Object.values(report.assertions).every(Boolean);
  } catch (e) {
    report.error = String(e && e.stack || e);
    report.pass = false;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 1;
})();
