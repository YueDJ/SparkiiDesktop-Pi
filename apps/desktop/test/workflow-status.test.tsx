import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkflowStatus } from '../src/workbench/WorkflowStatus.js';

describe('WorkflowStatus', () => {
  it('renders running with step', () => {
    render(<WorkflowStatus state={{ status: 'running', step: 'load' }} />);
    expect(screen.getByText('审核中：load')).toBeTruthy();
  });
  it('renders failure with error', () => {
    render(<WorkflowStatus state={{ status: 'failed', error: 'boom' }} />);
    expect(screen.getByText('审核失败：boom')).toBeTruthy();
  });
  it('renders nothing when idle', () => {
    const { container } = render(<WorkflowStatus state={{ status: 'idle' }} />);
    expect(container.querySelector('[data-testid="workflow-status"]')).toBeNull();
  });
});
