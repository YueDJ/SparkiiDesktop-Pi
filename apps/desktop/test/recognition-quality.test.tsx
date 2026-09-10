import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RecognitionQuality } from '@sparkii/ui';

afterEach(cleanup);

describe('RecognitionQuality', () => {
  it('renders structure mid quality as 识别质量 中 · 78%', () => {
    render(
      <RecognitionQuality
        engine="structure"
        quality={{
          score: 0.78,
          level: 'mid',
          pages: [{ page: 1, score: 0.78, level: 'mid' }],
        }}
      />,
    );
    const el = screen.getByTestId('recognition-quality');
    expect(el.textContent).toContain('识别质量');
    expect(el.textContent).toContain('中');
    expect(el.textContent).toContain('78%');
  });

  it('renders native without quality as 电子文本 without a percent', () => {
    render(<RecognitionQuality engine="native" />);
    const el = screen.getByTestId('recognition-quality');
    expect(el.textContent).toContain('电子文本');
    expect(el.textContent).not.toMatch(/\d+%/);
    expect(el.textContent).not.toContain('识别质量');
  });

  it('shows the low-quality warning sentence', () => {
    render(
      <RecognitionQuality
        engine="structure"
        quality={{ score: 0.42, level: 'low', pages: [] }}
      />,
    );
    expect(screen.getByTestId('recognition-quality').textContent).toContain('部分文字可能不准确，请对照原文。');
  });

  it('lists page scores when expanded', () => {
    render(
      <RecognitionQuality
        engine="structure"
        quality={{
          score: 0.78,
          level: 'mid',
          pages: [
            { page: 1, score: 0.78, level: 'mid' },
            { page: 2, score: 0.91, level: 'high' },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText('按页'));
    expect(screen.getByText('第 1 页 · 78%')).toBeTruthy();
    expect(screen.getByText('第 2 页 · 91%')).toBeTruthy();
  });

  it('does not mention worker, OCR, or Paddle in the document', () => {
    render(
      <RecognitionQuality
        engine="structure"
        quality={{ score: 0.78, level: 'mid', pages: [{ page: 1, score: 0.78, level: 'mid' }] }}
      />,
    );
    expect(document.body.textContent).not.toMatch(/worker|sidecar|OCR|Paddle/i);
    const src = readFileSync(new URL('../../../packages/ui/src/patterns/RecognitionQuality.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/worker|sidecar|OCR|Paddle|JSON-RPC|Python/i);
  });
});
