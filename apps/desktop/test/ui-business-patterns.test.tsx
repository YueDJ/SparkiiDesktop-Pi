import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RiskBadge, ApprovalItem, SettingsLayout } from '@sparkii/ui';

afterEach(cleanup);

describe('ui business patterns', () => {
  it('risk badge maps high risk to high class', () => {
    render(<RiskBadge risk="high-risk" />);
    expect(screen.getByText('高风险').className).toContain('ui-risk-badge--high');
  });

  it('risk badge normalizes chinese risk labels', () => {
    render(<RiskBadge risk="高风险" />);
    expect(screen.getByText('高风险').className).toContain('ui-risk-badge--high');
  });

  it('approval item is a dumb row of title plus optional slots', () => {
    const onOpen = vi.fn();
    render(<ApprovalItem title="导出报告" onOpenDetail={onOpen} />);
    expect(screen.getByText('导出报告')).toBeTruthy();
    expect(screen.queryByText('export')).toBeNull();
    expect(screen.queryByText(/会话/)).toBeNull();
    expect(screen.queryByText('120s')).toBeNull();
    expect(screen.queryByText('中风险')).toBeNull();
    expect(screen.queryByText('●')).toBeNull();
    fireEvent.click(screen.getByText('详情'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('approval item renders badge and countdown only when given', () => {
    render(
      <ApprovalItem
        title="永久删除"
        badge={<span>高风险</span>}
        countdown="4:32"
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByText('高风险')).toBeTruthy();
    expect(screen.getByText('4:32')).toBeTruthy();
  });

  it('settings layout renders nav and content', () => {
    render(<SettingsLayout nav={<button>大模型连接</button>}><span>内容</span></SettingsLayout>);
    expect(screen.getByText('大模型连接')).toBeTruthy();
    expect(screen.getByText('内容')).toBeTruthy();
  });
});
