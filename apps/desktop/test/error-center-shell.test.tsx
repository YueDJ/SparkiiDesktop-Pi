import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ErrorProvider, createMemoryErrorStore, Shell, useErrors } from '@sparkii/ui';

afterEach(cleanup);

function Controls() {
  const { reportError, unreadCount } = useErrors();
  return (
    <div>
      <span data-testid="unread">{unreadCount}</span>
      <button onClick={() => reportError('boom', { source: '系统设置' })}>触发报错</button>
    </div>
  );
}

const renderShell = () => render(
  <ErrorProvider store={createMemoryErrorStore()}>
    <Controls />
    <Shell
      active="general"
      agents={[{ id: 'general', name: '通用智能体', status: 'idle' }]}
      sessions={{}}
      pendingApprovals={0}
      statusText="就绪"
      onNavigate={vi.fn()}
      onNewSession={vi.fn()}
    >
      <div data-testid="surface">surface</div>
    </Shell>
  </ErrorProvider>,
);

describe('ErrorCenter through Shell', () => {
  it('closes the toast and marks all read from the drawer', () => {
    renderShell();
    fireEvent.click(screen.getByText('触发报错'));
    expect(screen.getByTestId('unread').textContent).toBe('1');
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(document.querySelector('.ui-error-toast-close') as HTMLButtonElement);
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /报错中心/ }));
    fireEvent.click(screen.getByRole('button', { name: '全部标为已读' }));
    expect(screen.getByTestId('unread').textContent).toBe('0');
  });

  it('dismisses the toast when opening the error center and marks all read', () => {
    renderShell();
    fireEvent.click(screen.getByText('触发报错'));
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /报错中心/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全部标为已读' }));
    expect(screen.getByTestId('unread').textContent).toBe('0');
  });
});
