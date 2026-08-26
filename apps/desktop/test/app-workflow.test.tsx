import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { App } from '../src/App.js';

function localSubject(username: string) {
  return { userId: username, roles: ['admin', 'reviewer'] as const };
}

describe('local subject', () => {
  it('grants full roles without login', () => {
    expect(localSubject('alice').roles).toEqual(['admin', 'reviewer']);
  });
});

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
    getLocalSubject: vi.fn().mockResolvedValue({ userId: 'alice', roles: ['admin', 'reviewer'] }),
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
    // 以 OS 用户作为单一本地主体,直接进入工作台首页
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-contract'));
    await screen.findByTestId('review');
    fireEvent.click(screen.getByTestId('review'));
    expect(api.runWorkflow).toHaveBeenCalledWith('contract-review', { documents: [] });
    act(() => channels['workflow']({ type: 'step_started', stepId: 'load' }));
    expect(screen.getByText('审核中：load')).toBeTruthy();
    act(() => channels['workflow']({ type: 'workflow_completed' }));
    expect(screen.getByText('审核完成')).toBeTruthy();
  });
});
