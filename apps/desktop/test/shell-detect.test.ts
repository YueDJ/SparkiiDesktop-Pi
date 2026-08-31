import { describe, it, expect } from 'vitest';
import { resolveShellChoice } from '../electron/main/shell-detect.js';

describe('resolveShellChoice', () => {
  it('returns a null shell when the profile has no bash tool', () => {
    expect(resolveShellChoice(['read'], undefined, null)).toEqual({
      shell: null,
      degraded: false,
      bashPath: null,
    });
  });

  it('prefers bash for a new session when Git Bash exists', () => {
    expect(resolveShellChoice(['read', 'bash', 'edit'], undefined, 'C:/Program Files/Git/bin/bash.exe'))
      .toMatchObject({ shell: 'bash', degraded: false });
  });

  it('falls back to powershell for a new session when Git Bash is absent', () => {
    expect(resolveShellChoice(['read', 'bash'], undefined, null))
      .toMatchObject({ shell: 'powershell', degraded: false });
  });

  it('keeps a persisted powershell choice even if Git Bash appears later', () => {
    expect(resolveShellChoice(['bash'], 'powershell', 'C:/Program Files/Git/bin/bash.exe'))
      .toMatchObject({ shell: 'powershell', degraded: false });
  });

  it('degrades a persisted bash choice to powershell when Git Bash is gone', () => {
    expect(resolveShellChoice(['bash'], 'bash', null))
      .toMatchObject({ shell: 'powershell', degraded: true });
  });

  it('keeps a persisted bash choice when Git Bash is still present', () => {
    expect(resolveShellChoice(['bash'], 'bash', 'C:/Program Files/Git/bin/bash.exe'))
      .toMatchObject({ shell: 'bash', degraded: false });
  });
});
