import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ToolCard } from '../src/workbench/ToolCard.js';

afterEach(cleanup);

describe('ToolCard', () => {
  it('shows running state before result', () => {
    render(<ToolCard toolName="bash" input={{ command: 'ls' }} />);
    expect(screen.getByText(/运行中/)).toBeTruthy();
    expect(screen.getByText(/ls/)).toBeTruthy();
  });

  it('shows awaiting approval state', () => {
    render(<ToolCard toolName="write" input={{ path: 'C:/ws/a.txt' }} awaitingApproval />);
    expect(screen.getByText(/等待审批/)).toBeTruthy();
  });

  it('expands details and renders diff from result', () => {
    render(<ToolCard toolName="edit" input={{ path: 'a.txt' }} result={{ details: { diff: '--- a/a.txt\n+++ b/a.txt\n+hi' } }} />);
    expect(screen.getByText(/完成/)).toBeTruthy();
    fireEvent.click(screen.getByText('详情 ▸'));
    expect(screen.getByTestId('diff-view')).toBeTruthy();
  });
});
