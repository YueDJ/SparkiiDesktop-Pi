import { describe, expect, it, vi } from 'vitest';
import { appendCustomEntryAndEmit } from '../src/pi-sdk-runtime.js';
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

describe('appendCustomEntryAndEmit', () => {
  it('emits entry_appended with a custom entry after append', () => {
    const listeners = new Set<(event: unknown) => void>();
    const entries = new Map<string, unknown>();
    const session = {
      sessionManager: {
        appendCustomEntry: (customType: string, data: unknown) => {
          const id = 'entry-1';
          entries.set(id, { type: 'custom', customType, data, id, parentId: null, timestamp: 1 });
          return id;
        },
        getEntry: (id: string) => entries.get(id),
      },
      _emit: (event: unknown) => listeners.forEach((cb) => cb(event)),
    };

    const received: unknown[] = [];
    listeners.add((event) => received.push(event));

    appendCustomEntryAndEmit(session, 'workflow_step_start', { stepId: 'load', startedAt: 1 });

    expect(received).toEqual([
      {
        type: 'entry_appended',
        entry: {
          type: 'custom',
          customType: 'workflow_step_start',
          data: { stepId: 'load', startedAt: 1 },
          id: 'entry-1',
          parentId: null,
          timestamp: 1,
        },
      },
    ]);
  });
});

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
