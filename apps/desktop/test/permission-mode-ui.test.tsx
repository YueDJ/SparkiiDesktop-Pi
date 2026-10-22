import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  PermissionModeBar,
  PermissionModeProvider,
} from '../src/trust/PermissionModeBar.js';

afterEach(cleanup);

function state(over: Record<string, unknown> = {}) {
  return {
    mode: 'ask',
    allowedModes: ['ask', 'auto_review'],
    taskActive: true,
    hostShellAvailable: true,
    reviewerAvailable: true,
    limitations: ['Host process is not an OS sandbox'],
    ...over,
  };
}

function makeApi(over: Record<string, unknown> = {}) {
  return {
    getPermissionModeState: vi.fn(async () => state()),
    setChatPermissionMode: vi.fn(async () => ({ ok: true, mode: 'auto_review' })),
    on: vi.fn(() => () => {}),
    ...over,
  };
}

function renderBar(api: ReturnType<typeof makeApi>, sessionId: string | null = 's1') {
  return render(
    <PermissionModeProvider api={api as never} agentId="general" sessionId={sessionId}>
      <PermissionModeBar />
    </PermissionModeProvider>,
  );
}

describe('PermissionModeBar', () => {
  it('offers only Ask and Auto review and shows Host semantics', async () => {
    const api = makeApi();
    renderBar(api);
    expect(await screen.findByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Auto review' })).toBeTruthy();
    expect(screen.queryByText(/Full access/i)).toBeNull();
    expect(screen.queryByText(/yolo/i)).toBeNull();
    expect(screen.getByText(/Host Git Bash/)).toBeTruthy();
    expect(screen.getByText(/非沙箱/)).toBeTruthy();
    expect(screen.getByText(/网络由宿主进程决定/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Auto review' }));
    await waitFor(() => expect(api.setChatPermissionMode).toHaveBeenCalledWith('s1', 'auto_review'));
  });

  it('marks the active mode and never shows reviewer internals', async () => {
    const api = makeApi({
      getPermissionModeState: vi.fn(async () => state({
        mode: 'auto_review',
        lastReview: { decision: 'allow', risk: 'low', reason: '普通测试命令' },
      })),
    });
    renderBar(api);
    const auto = await screen.findByRole('button', { name: 'Auto review' });
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Ask' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/最近审查：allow \/ low \/ 普通测试命令/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/pid|worker|queue|模型请求/i);
  });

  it('disables Auto review when the profile does not allow it and never switches on its own', async () => {
    const api = makeApi({
      getPermissionModeState: vi.fn(async () => state({ allowedModes: ['ask'] })),
    });
    renderBar(api);
    const auto = await screen.findByRole('button', { name: 'Auto review' });
    expect((auto as HTMLButtonElement).disabled).toBe(true);
    expect(api.setChatPermissionMode).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Ask' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('reports a missing host shell and an unavailable reviewer honestly', async () => {
    const api = makeApi({
      getPermissionModeState: vi.fn(async () => state({
        mode: 'auto_review',
        hostShellAvailable: false,
        reviewerAvailable: false,
      })),
    });
    renderBar(api);
    expect(await screen.findByText(/命令执行未启用/)).toBeTruthy();
    expect(screen.getByText(/已回退到人工审批/)).toBeTruthy();
    expect(screen.queryByText(/无网络/)).toBeNull();
    expect(screen.queryByText(/沙箱内/)).toBeNull();
  });

  it('keeps a draft choice local until the first prompt', async () => {
    const api = makeApi();
    renderBar(api, null);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto review' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Auto review' })
      .getAttribute('aria-pressed')).toBe('true'));
    expect(api.setChatPermissionMode).not.toHaveBeenCalled();
  });

  it('falls back to Ask when Main rejects the change', async () => {
    const api = makeApi({
      setChatPermissionMode: vi.fn(async () => ({ ok: false, error: 'permission mode auto_review is not allowed' })),
    });
    renderBar(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto review' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ask' })
      .getAttribute('aria-pressed')).toBe('true'));
  });
});
