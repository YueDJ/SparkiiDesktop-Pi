import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Markdown } from '../src/workbench/Markdown.js';

afterEach(cleanup);

describe('Markdown', () => {
  it('renders paragraphs and inline code', () => {
    render(<Markdown text={'hello **world**\n\n`code`'} />);
    expect(screen.getByText(/hello/)).toBeTruthy();
    expect(screen.getByText('world').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
  });

  it('renders code blocks with a copy button', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    const block = screen.getByTestId('code-block');
    expect(block.textContent).toContain('const a = 1;');
    fireEvent.click(screen.getByTestId('copy-btn'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 1;');
  });
});
