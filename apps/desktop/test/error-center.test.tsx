import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { ErrorProvider, useErrors, createMemoryErrorStore } from '@sparkii/ui';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness() {
  const { records, unreadCount, reportError, markAllRead, clearAll } = useErrors();
  return (
    <div>
      <span data-testid="unread">{unreadCount}</span>
      <span data-testid="count">{records.length}</span>
      <button onClick={() => reportError('boom', { source: '系统设置' })}>报错</button>
      <button onClick={markAllRead}>已读</button>
      <button onClick={clearAll}>清空</button>
      <ul>{records.map((r) => <li key={r.id}>{r.message}</li>)}</ul>
    </div>
  );
}

const renderCenter = () => render(
  <ErrorProvider store={createMemoryErrorStore()}>
    <Harness />
  </ErrorProvider>,
);

describe('ErrorCenter', () => {
  it('reports an error into the list and shows a toast', () => {
    renderCenter();
    fireEvent.click(screen.getByText('报错'));
    expect(screen.getByTestId('unread').textContent).toBe('1');
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getAllByText('boom').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain('boom');
  });

  it('marks all read without deleting records', () => {
    renderCenter();
    fireEvent.click(screen.getByText('报错'));
    fireEvent.click(screen.getByText('已读'));
    expect(screen.getByTestId('unread').textContent).toBe('0');
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('clears all records', () => {
    renderCenter();
    fireEvent.click(screen.getByText('报错'));
    fireEvent.click(screen.getByText('清空'));
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('auto-dismisses the toast after five seconds', () => {
    vi.useFakeTimers();
    renderCenter();
    act(() => fireEvent.click(screen.getByText('报错')));
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('closes the toast when the close button is clicked', () => {
    renderCenter();
    fireEvent.click(screen.getByText('报错'));
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
