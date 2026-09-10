import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DocumentPreview, formatFileSize, kindLabel } from '../agents/contract-review/surface/DocumentPreview.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DocumentPreview', () => {
  it('renders txt bytes', () => {
    const bytes = new TextEncoder().encode('第七条 付款条件').buffer;
    render(<DocumentPreview kind="txt" bytes={bytes} />);
    expect(screen.getByTestId('document-preview').getAttribute('data-kind')).toBe('txt');
    expect(screen.getByTestId('document-preview').textContent).toContain('第七条 付款条件');
  });

  it('renders image bytes with a blob url', () => {
    const createObjectURL = vi.fn(() => 'blob:image-preview');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const { unmount } = render(<DocumentPreview kind="image" bytes={bytes} />);
    const preview = screen.getByTestId('document-preview');
    expect(preview.getAttribute('data-kind')).toBe('image');
    const img = preview.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('blob:image-preview');
    expect(createObjectURL).toHaveBeenCalled();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image-preview');
  });

  it('labels kinds and sizes without page counts', () => {
    expect(kindLabel('pdf')).toBe('PDF');
    expect(kindLabel('docx')).toBe('Word');
    expect(kindLabel('txt')).toBe('TXT');
    expect(kindLabel('image')).toBe('图片');
    expect(formatFileSize(2048)).toMatch(/KB/);
    expect(formatFileSize(2.3 * 1024 * 1024)).toBe('2.3 MB');
  });
});
