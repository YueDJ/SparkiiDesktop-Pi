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
    expect((globalThis as any).window.sparkii.on).not.toHaveBeenCalled();
    expect((globalThis as any).window.sparkii.openChatSession).not.toHaveBeenCalled();
  });

  it('connects the live pipe only after a sessionId is bound', async () => {
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({ entries: [], streaming: true }),
        on,
      },
    };
    const { rerender } = renderHook(
      ({ sid }: { sid: string | null }) => useAgentSession('contract-review', sid, 'live'),
      { initialProps: { sid: null as string | null } },
    );
    expect(on).not.toHaveBeenCalled();

    rerender({ sid: 'ws1' });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(on).toHaveBeenCalledWith('chat-event', expect.any(Function));
    expect((globalThis as any).window.sparkii.openChatSession).toHaveBeenCalledWith('ws1');
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

  it('pairs a live tool execution start with its end in session.entries', async () => {
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
      chatCb({ sessionId: 's1', type: 'tool_execution_start', toolName: 'bash', toolCallId: 'c1', args: { command: 'ls' } });
    });
    await act(async () => {
      chatCb({ sessionId: 's1', type: 'tool_execution_end', toolName: 'bash', toolCallId: 'c1', result: { exitCode: 0 } });
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
      chatCb({ sessionId: 's1', type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '检查一下结果' }] } });
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ kind: 'message', role: 'user', text: '检查一下结果' });
  });

  it('applies chat-event custom rows even when mode is history', async () => {
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({ entries: [] }),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'history'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({
        sessionId: 's1',
        type: 'entry_appended',
        entry: { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { ok: true } } },
      });
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.result).toMatchObject({ review: { ok: true } });
  });

  it('derives result and timeline from the open snapshot', async () => {
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({
          entries: [
            { type: 'custom', id: 'c0', customType: 'workflow_step_start', data: { stepId: 'review' } },
            { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { ok: true } } },
          ],
        }),
        on: vi.fn().mockReturnValue(() => {}),
      },
    };
    const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'history'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.result).toMatchObject({ review: { ok: true } });
    expect(result.current.status).toBe('done');
    expect(result.current.meta.currentStep).toBe('review');
  });

  it('subscribes to chat-event before asking for the snapshot', () => {
    const order: string[] = [];
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn(() => { order.push('open'); return new Promise(() => {}); }),
        on: vi.fn((channel: string) => { order.push(`on:${channel}`); return () => {}; }),
      },
    };
    renderHook(() => useAgentSession('contract-review', 's1', 'live'));
    expect(order.indexOf('on:chat-event')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('on:chat-event')).toBeLessThan(order.indexOf('open'));
  });

  it('does not paint chat-events until the open snapshot is applied', async () => {
    let resolveOpen: (v: unknown) => void = () => {};
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn(() => new Promise((resolve) => { resolveOpen = resolve; })),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'live'));
    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({
        sessionId: 's1',
        type: 'entry_appended',
        entry: { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' } },
      });
    });
    expect(result.current.entries).toEqual([]);

    await act(async () => {
      resolveOpen({
        entries: [{ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '请审核' }] } }],
        streamingMessage: null,
        streaming: false,
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.entries.map((e) => e.kind)).toEqual(['message', 'custom']);
    expect(result.current.entries[1]).toMatchObject({ customType: 'workflow_step_start' });
  });

  it('folds the snapshot streamingMessage into the slot the buffered tick replaces', async () => {
    let resolveOpen: (v: unknown) => void = () => {};
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn(() => new Promise((resolve) => { resolveOpen = resolve; })),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('general', 's1', 'live'));
    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({ sessionId: 's1', type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '第3条存在期限不对齐' }] } });
    });
    await act(async () => {
      resolveOpen({
        entries: [],
        streamingMessage: { role: 'assistant', content: [{ type: 'text', text: '第3条' }] },
        streaming: true,
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ kind: 'message', text: '第3条存在期限不对齐', streaming: true });
    expect(result.current.streaming).toBe(true);
  });

  it('takes the spinner from snapshot.streaming, not from having a streamingMessage', async () => {
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({
          entries: [],
          streamingMessage: { role: 'assistant', content: [{ type: 'text', text: '半句' }] },
          streaming: false,
        }),
        on: vi.fn().mockReturnValue(() => {}),
      },
    };
    const { result } = renderHook(() => useAgentSession('general', 's1', 'live'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.streaming).toBe(false);
    expect(result.current.entries[0]).toMatchObject({ kind: 'message', text: '半句', streaming: false });
  });

  it('drops snapshot and buffer when the session changes mid-open', async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn((sid: string) => new Promise((resolve) => { resolvers[sid] = resolve; })),
        on,
      },
    };
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useAgentSession('contract-review', sid, 'live'),
      { initialProps: { sid: 's1' } },
    );
    const firstCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      firstCb({
        sessionId: 's1',
        type: 'entry_appended',
        entry: { type: 'custom', id: 'old', customType: 'workflow_step_start', data: { stepId: 'load' } },
      });
    });

    rerender({ sid: 's2' });
    await act(async () => {
      resolvers.s1({ entries: [{ type: 'custom', id: 's1row', customType: 'workflow_step_end', data: { stepId: 'load', output: { from: 's1' } } }] });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.entries).toEqual([]);

    await act(async () => {
      resolvers.s2({ entries: [{ type: 'custom', id: 's2row', customType: 'workflow_step_end', data: { stepId: 'review', output: { from: 's2' } } }] });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.result).toEqual({ review: { from: 's2' } });
  });

  it('reopens the session after a successful compaction_end and keeps only the new tree', async () => {
    let opens = 0;
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn(async () => {
          opens += 1;
          return opens === 1
            ? { entries: [{ type: 'custom', id: 'a', customType: 'workflow_step_end', data: { stepId: 'load', output: { n: 1 } } }], streaming: false }
            : { entries: [{ type: 'custom', id: 'b', customType: 'workflow_step_end', data: { stepId: 'review', output: { n: 2 } } }], streaming: false };
        }),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'live'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.result).toEqual({ load: { n: 1 } });

    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({ sessionId: 's1', type: 'compaction_end', aborted: false, willRetry: false, result: { tokensBefore: 150000 } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(opens).toBe(2);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.result).toEqual({ review: { n: 2 } });
  });

  it('does not reopen when the compaction aborted or will retry', async () => {
    let opens = 0;
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn(async () => { opens += 1; return { entries: [], streaming: false }; }),
        on,
      },
    };
    renderHook(() => useAgentSession('general', 's1', 'live'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({ sessionId: 's1', type: 'compaction_end', aborted: true });
      chatCb({ sessionId: 's1', type: 'compaction_end', willRetry: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(opens).toBe(1);
  });

  it('stops the spinner on session_unbound without clearing the timeline', async () => {
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({
          entries: [{ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '请审核' }] } }],
          streaming: true,
        }),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('general', 's1', 'live'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.streaming).toBe(true);

    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => { chatCb({ sessionId: 's1', type: 'session_unbound' }); });
    expect(result.current.streaming).toBe(false);
    expect(result.current.entries).toHaveLength(1);
  });

  it('does not reopen or clear the timeline when only the mode changes', async () => {
    const openChatSession = vi.fn().mockResolvedValue({
      entries: [{ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '请审核' }] } }],
      streaming: false,
    });
    (globalThis as any).window = { sparkii: { openChatSession, on: vi.fn().mockReturnValue(() => {}) } };
    const { result, rerender } = renderHook(
      ({ mode }: { mode: 'live' | 'history' }) => useAgentSession('general', 's1', mode),
      { initialProps: { mode: 'history' as const } },
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.entries).toHaveLength(1);

    rerender({ mode: 'live' });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(openChatSession).toHaveBeenCalledTimes(1);
    expect(result.current.entries).toHaveLength(1);
  });

  it('reaches the contract cards from a step row buffered before the snapshot', async () => {
    let resolveOpen: (v: unknown) => void = () => {};
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn(() => new Promise((resolve) => { resolveOpen = resolve; })),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'live'));
    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({
        sessionId: 's1',
        type: 'entry_appended',
        entry: { type: 'custom', id: 'c3', customType: 'workflow_step_start', data: { stepId: 'review' } },
      });
      chatCb({
        sessionId: 's1',
        type: 'entry_appended',
        entry: {
          type: 'custom',
          id: 'c4',
          customType: 'workflow_step_end',
          data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', level: 'high' }] } },
        },
      });
    });
    expect(result.current.result).toBeUndefined();

    await act(async () => {
      resolveOpen({ entries: [], streamingMessage: null, streaming: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.result).toEqual({ review: { riskFindings: [{ id: 'r1', level: 'high' }] } });
    expect(result.current.status).toBe('done');
    expect(result.current.meta.currentStep).toBe('review');
  });

  it('leaves an empty session when the snapshot read fails', async () => {
    const on = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockRejectedValue(new Error('session file gone')),
        on,
      },
    };
    const { result } = renderHook(() => useAgentSession('general', 's1', 'live'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.entries).toEqual([]);
    expect(result.current.streaming).toBe(false);

    const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
    await act(async () => {
      chatCb({ sessionId: 's1', type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '再来' }] } });
    });
    expect(result.current.entries).toHaveLength(1);
  });
});
