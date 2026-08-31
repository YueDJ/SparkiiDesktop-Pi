import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { join } from 'node:path';

const USER_DATA = 'C:/Users/Me/AppData/Roaming/Sparkii';

vi.mock('electron', () => ({
  app: {
    getName: () => 'Sparkii',
    getPath: (name: string) => (name === 'userData' ? USER_DATA : ''),
  },
}));

import { DATA_APP_DIR, dataDirFor, defaultDataDir } from '../electron/main/paths.js';

describe('data directory resolution', () => {
  const prevLocalAppData = process.env.LOCALAPPDATA;

  beforeEach(() => {
    process.env.LOCALAPPDATA = 'C:/Users/Me/AppData/Local';
  });

  it('defaults to %LOCALAPPDATA%\\SparkiiDesktop\\data', () => {
    expect(defaultDataDir()).toBe(join('C:/Users/Me/AppData/Local', DATA_APP_DIR, 'data'));
  });

  it('falls back to roaming SparkiiDesktop/data when LOCALAPPDATA is unset', () => {
    delete process.env.LOCALAPPDATA;
    expect(defaultDataDir()).toBe(join('C:/Users/Me/AppData/Roaming', DATA_APP_DIR, 'data'));
  });

  it('keeps per-user isolation helper with sanitized id', () => {
    expect(dataDirFor('a b/c')).toBe(join('C:/Users/Me/AppData/Local', DATA_APP_DIR, 'data', 'a_b_c'));
  });

  afterAll(() => {
    if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocalAppData;
  });
});
