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

  it('approval item has no leading status dot', () => {
    const onOpen = vi.fn();
    render(<ApprovalItem summary="导出报告" risk="write" toolName="export" sessionId="s1" countdownText="120s" onOpenDetail={onOpen} />);
    expect(screen.queryByText('●')).toBeNull();
    fireEvent.click(screen.getByText('详情'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('settings layout renders nav and content', () => {
    render(<SettingsLayout nav={<button>大模型连接</button>}><span>内容</span></SettingsLayout>);
    expect(screen.getByText('大模型连接')).toBeTruthy();
    expect(screen.getByText('内容')).toBeTruthy();
  });
});
