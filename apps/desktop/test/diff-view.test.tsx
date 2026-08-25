import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DiffView } from '../src/workbench/DiffView.js';

afterEach(cleanup);

describe('DiffView', () => {
  it('classifies header, added, removed and context lines', () => {
    const { container } = render(<DiffView diff={'--- a/a.txt\n+++ b/a.txt\n-old\n+new\n keep\n'} />);
    expect(container.querySelector('.diff-hdr')).toBeTruthy();
    const add = container.querySelector('.diff-add');
    expect(add?.textContent).toBe('+new');
    const del = container.querySelector('.diff-del');
    expect(del?.textContent).toBe('-old');
    expect(container.querySelector('.diff-ctx')?.textContent).toBe(' keep');
  });
  it('renders empty diff without crashing', () => {
    render(<DiffView diff="" />);
    expect(screen.getByTestId('diff-view')).toBeTruthy();
  });
});
