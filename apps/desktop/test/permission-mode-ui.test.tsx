import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  PermissionModeSelect,
  PermissionModeProvider,
} from '../src/trust/PermissionModeSelect.js';

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
      <PermissionModeSelect />
    </PermissionModeProvider>,
  );
}

describe('PermissionModeSelect', () => {
  it('shows the selected mode in one trigger and switches from its menu', async () => {
    const api = makeApi();
    renderBar(api);
    const trigger = await screen.findByTestId('permission-mode-trigger');
    expect(trigger.textContent).toContain('每次询问');
    expect(screen.queryByRole('button', { name: '自动审查' })).toBeNull();
    expect(screen.queryByText(/Host Git Bash/)).toBeNull();
    expect(screen.queryByText(/网络由宿主进程决定/)).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /自动审查/ }));
    await waitFor(() => expect(api.setChatPermissionMode).toHaveBeenCalledWith('s1', 'auto_review'));
    await waitFor(() => expect(screen.getByTestId('permission-mode-trigger').textContent).toContain('自动审查'));
  });

  it('marks the active mode in the menu and never shows reviewer internals', async () => {
    const api = makeApi({
      getPermissionModeState: vi.fn(async () => state({
        mode: 'auto_review',
        lastReview: { decision: 'allow', risk: 'low', reason: '普通测试命令' },
      })),
    });
    renderBar(api);
    const trigger = await screen.findByTestId('permission-mode-trigger');
    expect(trigger.textContent).toContain('自动审查');
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: /自动审查/ }).getAttribute('data-current')).toBe('true');
    expect(screen.queryByText(/普通测试命令/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/pid|worker|queue|模型请求/i);
  });

  it('uses distinct icons for manual confirmation and automatic review', async () => {
    const api = makeApi();
    renderBar(api);
    const trigger = await screen.findByTestId('permission-mode-trigger');
    expect(trigger.querySelector('[data-permission-icon="user"]')).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: /每次询问/ })
      .querySelector('[data-permission-icon="user"]')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /自动审查/ })
      .querySelector('[data-permission-icon="shield"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: /自动审查/ }));
    await waitFor(() => expect(screen.getByTestId('permission-mode-trigger')
      .querySelector('[data-permission-icon="shield"]')).toBeTruthy());
  });

  it('disables Auto review when the profile does not allow it and never switches on its own', async () => {
    const api = makeApi({
      getPermissionModeState: vi.fn(async () => state({ allowedModes: ['ask'] })),
    });
    renderBar(api);
    fireEvent.click(await screen.findByTestId('permission-mode-trigger'));
    const auto = screen.getByRole('menuitem', { name: /自动审查/ });
    expect((auto as HTMLButtonElement).disabled).toBe(true);
    expect(api.setChatPermissionMode).not.toHaveBeenCalled();
  });

  it('keeps a draft choice local until the first prompt', async () => {
    const api = makeApi();
    renderBar(api, null);
    fireEvent.click(await screen.findByTestId('permission-mode-trigger'));
    fireEvent.click(screen.getByRole('menuitem', { name: /自动审查/ }));
    await waitFor(() => expect(screen.getByTestId('permission-mode-trigger').textContent).toContain('自动审查'));
    expect(api.setChatPermissionMode).not.toHaveBeenCalled();
  });

  it('falls back to Ask when Main rejects the change', async () => {
    const api = makeApi({
      setChatPermissionMode: vi.fn(async () => ({ ok: false, error: 'permission mode auto_review is not allowed' })),
    });
    renderBar(api);
    fireEvent.click(await screen.findByTestId('permission-mode-trigger'));
    fireEvent.click(screen.getByRole('menuitem', { name: /自动审查/ }));
    await waitFor(() => expect(screen.getByTestId('permission-mode-trigger').textContent).toContain('每次询问'));
  });
});
