import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalDialog } from '../src/approval/ApprovalDialog.js';

describe('ApprovalDialog', () => {
  it('renders pending proposal summary', () => {
    render(<ApprovalDialog proposal={{ id: 'p1', summary: '导出报告', risk: 'write', payloadHash: 'h' } as any} onDecide={() => {}} />);
    expect(screen.getByText('导出报告')).toBeTruthy();
  });
});
