import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, renderHook, act, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApprovalInboxProvider, useSessionApprovals, useApprovalInbox } from '../src/trust/ApprovalInbox.js';
import { InlineApprovalCard } from '../src/trust/InlineApprovalCard.js';

afterEach(cleanup);

function proposal(over: Record<string, unknown> = {}) {
  return {
    id: 'p1', requestId: 'r1', sessionId: 's1', risk: 'write', status: 'pending',
    toolName: 'write', targetSystem: 'general', summary: '写入 a.txt', payload: {}, payloadHash: 'h',
    profileId: 'general', createdAt: Date.now(),
    ...over,
  };
}

function makeApi(over: Record<string, unknown> = {}) {
  return {
    listPendingApprovals: async () => [] as unknown[],
    decideApproval: async () => ({}),
    on: () => () => {},
    ...over,
  };
}

function wrapper(api: ReturnType<typeof makeApi>) {
  return ({ children }: { children: ReactNode }) => (
    <ApprovalInboxProvider api={api as never}>{children}</ApprovalInboxProvider>
  );
}

describe('ApprovalInbox', () => {
  it('useSessionApprovals only returns own routine pending', async () => {
    const api = makeApi({
      listPendingApprovals: async () => [
        proposal({ id: 'a', requestId: 'ra', sessionId: 's1', risk: 'write' }),
        proposal({ id: 'b', requestId: 'rb', sessionId: 's2', risk: 'write' }),
        proposal({ id: 'c', requestId: 'rc', sessionId: 's1', risk: 'high-risk' }),
      ],
    });
    const { result } = renderHook(() => useSessionApprovals('s1'), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.waiting.map((p) => p.id)).toEqual(['a']));
  });

  it('claim and release toggle the claimed set', async () => {
    const api = makeApi({ listPendingApprovals: async () => [proposal()] });
    const { result } = renderHook(() => useApprovalInbox(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.proposals.size).toBe(1));
    act(() => result.current.claim('p1'));
    expect(result.current.claimed.has('p1')).toBe(true);
    act(() => result.current.release('p1'));
    expect(result.current.claimed.has('p1')).toBe(false);
  });

  it('decide optimistically removes and notifies on success', async () => {
    const onDecided = vi.fn();
    const api = makeApi({
      listPendingApprovals: async () => [proposal()],
      decideApproval: async () => ({}),
    });
    const { result } = renderHook(() => useApprovalInbox(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.proposals.size).toBe(1));
    const off = result.current.onDecided(onDecided);
    let res: Awaited<ReturnType<typeof result.current.decide>> | undefined;
    await act(async () => { res = await result.current.decide('p1', true); });
    expect(res).toEqual({ ok: true, status: 'approved' });
    expect(result.current.proposals.has('p1')).toBe(false);
    expect(onDecided).toHaveBeenCalled();
    off();
  });

  it('decide refetches to roll back on failure', async () => {
    const api = makeApi({
      listPendingApprovals: async () => [proposal()],
      decideApproval: async () => { throw new Error('NOT_PENDING'); },
    });
    const { result } = renderHook(() => useApprovalInbox(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.proposals.size).toBe(1));
    let res: Awaited<ReturnType<typeof result.current.decide>> | undefined;
    await act(async () => { res = await result.current.decide('p1', true); });
    expect(res?.ok).toBe(false);
    await waitFor(() => expect(result.current.proposals.has('p1')).toBe(true));
  });

  it('InlineApprovalCard claims on mount', async () => {
    const api = makeApi({ listPendingApprovals: async () => [proposal()] });
    function Probe() {
      const { claimed } = useApprovalInbox();
      return <span data-testid="claimed">{claimed.has('p1') ? 'yes' : 'no'}</span>;
    }
    render(
      <ApprovalInboxProvider api={api as never}>
        <InlineApprovalCard proposal={proposal() as never} />
        <Probe />
      </ApprovalInboxProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('claimed').textContent).toBe('yes'));
  });

  it('passes task scope for process.exec only', async () => {
    const decideApproval = vi.fn(async () => ({}));
    const api = makeApi({
      listPendingApprovals: async () => [],
      decideApproval,
    });
    render(
      <ApprovalInboxProvider api={api as never}>
        <InlineApprovalCard proposal={proposal({
          toolName: 'bash',
          targetSystem: 'platform:process.exec',
        }) as never} />
      </ApprovalInboxProvider>,
    );
    expect(await screen.findByRole('button', { name: '允许一次' })).toBeTruthy();
    expect(screen.getByText('宿主执行，非沙箱')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '本任务允许 Shell' }));
    await waitFor(() => expect(decideApproval)
      .toHaveBeenCalledWith('p1', true, undefined, 'task'));
  });

  it('offers no task scope for an external write', async () => {
    const decideApproval = vi.fn(async () => ({}));
    const api = makeApi({
      listPendingApprovals: async () => [],
      decideApproval,
    });
    render(
      <ApprovalInboxProvider api={api as never}>
        <InlineApprovalCard proposal={proposal({
          toolName: 'report.export',
          targetSystem: 'report',
        }) as never} />
      </ApprovalInboxProvider>,
    );
    expect(await screen.findByRole('button', { name: '允许' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '本任务允许 Shell' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('p1', true, undefined, undefined));
  });

  it('offers no task scope for a high-risk shell command', async () => {
    const api = makeApi({ listPendingApprovals: async () => [] });
    render(
      <ApprovalInboxProvider api={api as never}>
        <InlineApprovalCard proposal={proposal({
          toolName: 'bash',
          targetSystem: 'platform:process.exec',
          risk: 'high-risk',
        }) as never} />
      </ApprovalInboxProvider>,
    );
    expect(await screen.findByRole('button', { name: '拒绝' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '本任务允许 Shell' })).toBeNull();
  });
});
