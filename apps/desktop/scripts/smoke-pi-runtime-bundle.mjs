import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(desktopRoot, 'dist-electron', 'pi-runtime');
const forkEntry = join(runtimeDir, 'fork-entry.js');
const utilityEntry = join(runtimeDir, 'utility-entry.js');
const tempDir = mkdtempSync(join(tmpdir(), 'sparkii-pi-bundle-smoke-'));
const childEnv = {
  ...process.env,
  PI_CODING_AGENT_DIR: tempDir,
  SPARKII_PI_CWD: tempDir,
  SPARKII_WORKSPACE_ROOT: tempDir,
};

function timeoutError(message) {
  return new Error(`Pi bundle smoke timed out: ${message}`);
}

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw timeoutError(description);
}

function sendToFork(child, messages, id, command) {
  child.send({ direction: 'main-to-runtime', id, command });
  return waitFor(
    () => messages.find((envelope) => 'id' in envelope && envelope.id === id && 'response' in envelope),
    `${command.type} response`,
  );
}

async function smokeForkEntry() {
  const child = fork(forkEntry, [], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stderr = '';
  child.on('message', (message) => messages.push(message));
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitFor(
      () => messages.some((message) => message?.direction === 'runtime-to-main' && message.ready === true),
      'fork ready',
    );
    const state = await sendToFork(child, messages, 'fork-state', { type: 'get_state' });
    if (!state.response?.success) throw new Error(`fork get_state failed: ${state.response?.error ?? 'unknown'}`);
    const aborted = await sendToFork(child, messages, 'fork-abort', { type: 'abort' });
    if (!aborted.response?.success) throw new Error(`fork abort failed: ${aborted.response?.error ?? 'unknown'}`);

    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(timeoutError('fork exit')), 10_000)),
    ]);
  } catch (error) {
    child.kill();
    if (stderr.trim()) process.stderr.write(stderr);
    throw error;
  }
}

async function smokeUtilityEntry() {
  const messages = [];
  const listeners = [];
  const parentPort = {
    on(event, listener) {
      if (event === 'message') listeners.push(listener);
    },
    postMessage(message) {
      messages.push(message);
    },
  };
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
  });

  await import(`${pathToFileURL(utilityEntry).href}?smoke=${Date.now()}`);
  await waitFor(
    () => messages.some((message) => message?.direction === 'runtime-to-main' && message.ready === true),
    'utility ready',
  );
  if (listeners.length === 0) throw new Error('utility did not install a message listener');

  const id = 'utility-state';
  const commandEvent = { data: { direction: 'main-to-runtime', id, command: { type: 'get_state' } } };
  for (const listener of listeners) listener(commandEvent);
  const state = await waitFor(
    () => messages.find((message) => 'id' in message && message.id === id && 'response' in message),
    'utility get_state response',
  );
  if (!state.response?.success) throw new Error(`utility get_state failed: ${state.response?.error ?? 'unknown'}`);
}

try {
  await smokeForkEntry();
  await smokeUtilityEntry();
  console.log('Pi runtime bundle smoke passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
