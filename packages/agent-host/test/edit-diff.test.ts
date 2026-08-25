import { describe, it, expect } from 'vitest';
import { computeEditDiff } from '../src/edit-diff.js';

describe('computeEditDiff', () => {
  it('shows added lines for a new file', () => {
    const d = computeEditDiff('', 'hello\nworld\n', 'a.txt');
    expect(d).toContain('--- a/a.txt');
    expect(d).toContain('+hello');
    expect(d).toContain('+world');
  });
  it('marks removed and added lines', () => {
    const d = computeEditDiff('old line\nkeep\n', 'new line\nkeep\n', 'b.txt');
    expect(d).toContain('-old line');
    expect(d).toContain('+new line');
    expect(d).toContain(' keep');
  });
  it('is empty-ish for identical content', () => {
    const d = computeEditDiff('same\n', 'same\n', 'c.txt');
    expect(d).toContain('--- a/c.txt');
    expect(d).not.toContain('+same');
  });
});
