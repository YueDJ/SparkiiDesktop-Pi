import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { App } from '../src/App.js';

const HOME = {
  page: 'contract-review/home',
  layout: { type: 'grid', columns: 2 },
  widgets: [
    { id: 'upload', type: 'file-upload', bind: 'documents' },
    { id: 'review', type: 'action-button', action: 'run-workflow:contract-review' },
    { id: 'risk', type: 'table', bind: 'workflow.result.compare' },
    { id: 'report', type: 'doc-preview', bind: 'workflow.result.report' },
    { id: 'export', type: 'action-button', action: 'export-report' },
  ],
};

function makeApi() {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    login: vi.fn().mockResolvedValue({ userId: 'admin', roles: ['admin'] }),
    getProfile: vi.fn().mockResolvedValue({ pages: { home: HOME } }),
    listPendingApprovals: vi.fn().mockResolvedValue([]),
    chooseDocument: vi.fn(),
    runWorkflow: vi.fn().mockResolvedValue({ ok: true }),
    exportReport: vi.fn(),
    prompt: vi.fn().mockResolvedValue({ ok: true }),
    decideApproval: vi.fn(),
    queryAudit: vi.fn().mockResolvedValue([]),
  };
  (window as any).sparkii = api;
  return { api, channels };
}

describe('App workflow feedback', () => {
  it('shows workflow status from workflow events', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'admin123' } });
    fireEvent.click(screen.getByText('登录'));
    await screen.findByTestId('review');
    fireEvent.click(screen.getByTestId('review'));
    expect(api.runWorkflow).toHaveBeenCalledWith('contract-review', { documents: [] });
    act(() => channels['workflow']({ type: 'step_started', stepId: 'load' }));
    expect(screen.getByText('审核中：load')).toBeTruthy();
    act(() => channels['workflow']({ type: 'workflow_completed' }));
    expect(screen.getByText('审核完成')).toBeTruthy();
  });
});
