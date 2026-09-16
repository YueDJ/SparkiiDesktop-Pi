import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AuditView } from '../src/audit/AuditView.js';

afterEach(cleanup);

function makeApi(rows: unknown[]) {
  return { queryAudit: vi.fn().mockResolvedValue(rows) } as any;
}

const ROWS = [
  { ts: 2000, action: 'proposal.approved', actor: 'admin', decision: 'approved', sessionId: 's1' },
  { ts: 1000, action: 'report.export', actor: 'admin', decision: 'denied', sessionId: 's2' },
];

describe('AuditView', () => {
  it('renders the timeline with executed and denied markers', async () => {
    render(<AuditView api={makeApi(ROWS)} />);
    expect(await screen.findByText('proposal.approved')).toBeTruthy();
    expect(screen.getAllByText('已执行').length).toBeGreaterThan(0);
    expect(screen.getAllByText('未执行').length).toBeGreaterThan(0);
    expect(document.querySelector('.adot')).toBeNull();
    expect(screen.queryByText('●')).toBeNull();
  });

  it('switches to the table view', async () => {
    render(<AuditView api={makeApi(ROWS)} />);
    await screen.findByText('proposal.approved');
    fireEvent.click(screen.getByText('表格'));
    expect(screen.getByText('时间')).toBeTruthy();
  });

  it('has no native select and filters from the in-page menu', async () => {
    const { container } = render(<AuditView api={makeApi(ROWS)} />);
    await screen.findByText('proposal.approved');
    expect(container.querySelector('select')).toBeNull();
    fireEvent.click(screen.getByLabelText('结果'));
    fireEvent.click(screen.getByRole('menuitem', { name: '未执行' }));
    expect(screen.queryByText('proposal.approved')).toBeNull();
    expect(screen.getByText('report.export')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('结果'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.body.querySelector('.ui-menu--fixed')).toBeNull();
  });

  it('exports the queried rows as JSONL', async () => {
    const onExport = vi.fn();
    render(<AuditView api={makeApi(ROWS)} onExport={onExport} />);
    await screen.findByText('proposal.approved');
    fireEvent.click(screen.getByText('导出'));
    expect(onExport).toHaveBeenCalled();
    expect(onExport.mock.calls[0][0]).toContain('proposal.approved');
    expect(onExport.mock.calls[0][0]).toContain('report.export');
  });
});
