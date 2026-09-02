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
});
