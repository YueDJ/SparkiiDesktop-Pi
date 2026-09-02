import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSession } from '../src/surface/use-agent-session.js';

describe('useAgentSession', () => {
  beforeEach(() => {
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi
          .fn()
          .mockResolvedValue({ entries: [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }] }),
        on: vi.fn().mockReturnValue(() => {}),
      },
    };
  });

  it('loads and normalizes history entries in history mode', async () => {
    const { result } = renderHook(() => useAgentSession('general', 's1', 'history'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.entries.length).toBeGreaterThan(0);
    expect(result.current.meta.currentStep).toBeNull();
  });

  it('starts empty when no session', () => {
    const { result } = renderHook(() => useAgentSession('general', null, 'live'));
    expect(result.current.entries).toEqual([]);
  });

  it('populates meta.inputs from the loaded session', async () => {
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({ entries: [], inputs: [{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }] }),
        on: vi.fn().mockReturnValue(() => {}),
      },
    };
    const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'history'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.meta.inputs).toEqual([{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }]);
  });

  it('marks input files that no longer exist during history replay', async () => {
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({
          entries: [],
          inputs: [{ path: 'C:/gone/contract.pdf', name: 'contract.pdf', missing: true }],
        }),
        on: vi.fn().mockReturnValue(() => {}),
      },
    };
    const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'history'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.meta.inputs).toEqual([{ path: 'C:/gone/contract.pdf', name: 'contract.pdf', missing: true }]);
  });

  it('pairs a live tool_call with its tool_result in session.entries', async () => {
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({ entries: [] }),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('general', 's1', 'live'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({ sessionId: 's1', type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } });
    });
    await act(async () => {
      chatCb({ sessionId: 's1', type: 'tool_result', toolName: 'bash', toolCallId: 'c1', result: { exitCode: 0 } });
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ kind: 'tool', toolName: 'bash', result: { exitCode: 0 } });
  });

  it('keeps a live user message in session.entries (JSONL truth source)', async () => {
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({ entries: [] }),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('general', 's1', 'live'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({ sessionId: 's1', type: 'message', role: 'user', text: '检查一下结果' });
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ kind: 'message', role: 'user', text: '检查一下结果' });
  });
});
