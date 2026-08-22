import { describe, it, expect } from 'vitest';
import { ping } from '../src/index.js';

describe('smoke', () => {
  it('ping returns pong', () => {
    expect(ping()).toBe('pong');
  });
});
