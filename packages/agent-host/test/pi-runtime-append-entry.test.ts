import { describe, expect, it, vi } from 'vitest';
import { createPiRuntime, type PiRuntimeSession, type PiRuntimeSessionHost } from '../src/pi-runtime.js';
import { commandEnvelope, type PiRuntimeEnvelope } from '../src/pi-runtime-transport.js';

function fakeSession(): PiRuntimeSession & { emit: (event: unknown) => void } {
  const listeners = new Set<(event: unknown) => void>();
  return {
    emit: (event) => listeners.forEach((cb) => cb(event)),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    setSteeringMode: vi.fn(async () => {}),
    setFollowUpMode: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setAutoRetry: vi.fn(async () => {}),
    setAutoCompaction: vi.fn(async () => {}),
    setSessionName: vi.fn(async () => {}),
    appendWorkflowEntry: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => {}),
    removeApiKey: vi.fn(async () => {}),
    complete: vi.fn(async () => ''),
    listModels: vi.fn(async () => []),
    setThinkingLevel: vi.fn(),
    getThinkingLevel: vi.fn(() => ''),
    getAvailableThinkingLevels: vi.fn(() => []),
    listProviders: vi.fn(async () => []),
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onRuntimeError: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getMessages: () => [],
    getSessionEntries: () => [],
    getState: () => ({ streaming: false }),
    dispose: vi.fn(),
  } as any;
}

describe('append_workflow_entry command', () => {
  it('routes workflow entry to the Pi session', async () => {
    const session = fakeSession();
    const host: PiRuntimeSessionHost = {
      current: () => session,
      newSession: vi.fn(async () => {}),
      switchSession: vi.fn(async () => {}),
      configureSaddle: vi.fn(async () => {}),
    };
    const sent: PiRuntimeEnvelope[] = [];
    const transport = {
      postMessage: (envelope: PiRuntimeEnvelope) => sent.push(envelope),
      onMessage: (cb: (envelope: PiRuntimeEnvelope) => void) => {
        queueMicrotask(() => cb(commandEnvelope('1', { type: 'append_workflow_entry', customType: 'workflow_state', data: { action: 'risk_confirmed' } })));
      },
    };

    createPiRuntime({ host, transport });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(session.appendWorkflowEntry).toHaveBeenCalledWith('workflow_state', { action: 'risk_confirmed' });
  });
});
