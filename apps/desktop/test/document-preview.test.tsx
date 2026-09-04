import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentPreview, formatFileSize, kindLabel } from '../agents/contract-review/surface/DocumentPreview.js';

describe('DocumentPreview', () => {
  it('renders txt bytes', () => {
    const bytes = new TextEncoder().encode('第七条 付款条件').buffer;
    render(<DocumentPreview kind="txt" bytes={bytes} />);
    expect(screen.getByTestId('document-preview').getAttribute('data-kind')).toBe('txt');
    expect(screen.getByTestId('document-preview').textContent).toContain('第七条 付款条件');
  });

  it('labels kinds and sizes without page counts', () => {
    expect(kindLabel('pdf')).toBe('PDF');
    expect(kindLabel('docx')).toBe('Word');
    expect(kindLabel('txt')).toBe('TXT');
    expect(formatFileSize(2048)).toMatch(/KB/);
    expect(formatFileSize(2.3 * 1024 * 1024)).toBe('2.3 MB');
  });
});
