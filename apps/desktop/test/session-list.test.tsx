import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionList, SESSION_PREVIEW_LIMIT, type SessionGroup } from '@sparkii/ui';

afterEach(cleanup);

function group(agentId: string, agentName: string, names: string[]): SessionGroup {
  return {
    agentId,
    agentName,
    sessions: names.map((name, i) => ({ id: `${agentId}-${i + 1}`, name })),
  };
}

describe('SessionList preview', () => {
  it('shows only the preview limit per agent and reveals the rest via 更多', () => {
    const generalNames = Array.from({ length: SESSION_PREVIEW_LIMIT + 3 }, (_, i) => `通用会话 ${i + 1}`);
    const contractNames = ['合同会话 1', '合同会话 2'];
    render(
      <SessionList
        groups={[
          group('general', '通用智能体', generalNames),
          group('contract-review', '合同审核智能体', contractNames),
        ]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('通用会话 1')).toBeTruthy();
    expect(screen.getByText(`通用会话 ${SESSION_PREVIEW_LIMIT}`)).toBeTruthy();
    expect(screen.queryByText(`通用会话 ${SESSION_PREVIEW_LIMIT + 1}`)).toBeNull();
    expect(screen.getByText('合同会话 1')).toBeTruthy();
    expect(screen.getByText('合同会话 2')).toBeTruthy();

    const more = screen.getByTestId('session-more-general');
    expect(more.textContent).toContain('更多');
    expect(screen.queryByTestId('session-more-contract-review')).toBeNull();

    fireEvent.click(more);
    expect(screen.getByText(`通用会话 ${SESSION_PREVIEW_LIMIT + 1}`)).toBeTruthy();
    expect(screen.getByText(`通用会话 ${SESSION_PREVIEW_LIMIT + 3}`)).toBeTruthy();
    expect(screen.getByTestId('session-more-general').textContent).toBe('收起');

    fireEvent.click(screen.getByTestId('session-more-general'));
    expect(screen.queryByText(`通用会话 ${SESSION_PREVIEW_LIMIT + 1}`)).toBeNull();
    expect(screen.getByTestId('session-more-general').textContent).toContain('更多');
  });

  it('does not truncate matching sessions while searching', () => {
    const names = Array.from({ length: SESSION_PREVIEW_LIMIT + 2 }, (_, i) => `会话 ${i + 1}`);
    render(
      <SessionList
        groups={[group('general', '通用智能体', names)]}
        filter={`会话 ${SESSION_PREVIEW_LIMIT + 2}`}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(`会话 ${SESSION_PREVIEW_LIMIT + 2}`)).toBeTruthy();
    expect(screen.queryByTestId('session-more-general')).toBeNull();
  });
});
