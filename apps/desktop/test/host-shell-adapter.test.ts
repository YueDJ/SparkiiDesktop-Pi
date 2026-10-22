import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOST_SHELL_ENV_ALLOWLIST,
  buildHostShellEnvironment,
  createHostShellAdapter,
  resolveHelperPath,
} from '../electron/main/security/host-shell.js';

describe('buildHostShellEnvironment', () => {
  it('drops credentials from environment', () => {
    const env = buildHostShellEnvironment(
      { SystemRoot: 'C:/Windows', DEEPSEEK_API_KEY: 'secret' },
      'C:/portable-git',
      'C:/task/scratch',
    );
    expect(env.PATH).toContain('C:/portable-git/bin');
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(env.HOME).toBe('C:/task/scratch/home');
  });

  it('keeps only allowlisted system values and never the inherited profile', () => {
    const env = buildHostShellEnvironment({
      SystemRoot: 'C:/Windows',
      ComSpec: 'C:/Windows/system32/cmd.exe',
      TEMP: 'C:/Windows/Temp',
      TMP: 'C:/Windows/Temp',
      APPDATA: 'C:/Users/me/AppData/Roaming',
      LOCALAPPDATA: 'C:/Users/me/AppData/Local',
      LANG: 'zh_CN.UTF-8',
      KNOWLEDGE_TOKEN: 'kb-secret',
      Authorization: 'Bearer abc',
      USERPROFILE: 'C:/Users/me',
      PATH: 'C:/Users/me/tools',
      npm_config_token: 'registry-secret',
    }, 'C:/portable-git', 'C:/task/scratch');

    expect(Object.keys(env).sort()).toEqual([...HOST_SHELL_ENV_ALLOWLIST].sort());
    expect(env).not.toHaveProperty('KNOWLEDGE_TOKEN');
    expect(env).not.toHaveProperty('Authorization');
    expect(env).not.toHaveProperty('npm_config_token');
    expect(env).not.toHaveProperty('USERPROFILE');
    // The inherited PATH is replaced, not appended to, so user tool dirs leak nothing.
    expect(env.PATH).not.toContain('C:/Users/me/tools');
    expect(env.APPDATA).toBe('C:/task/scratch/appdata');
    expect(env.LOCALAPPDATA).toBe('C:/task/scratch/localappdata');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('falls back to a drive root when the parent environment lacks SystemRoot', () => {
    const env = buildHostShellEnvironment({}, 'C:/portable-git', 'C:/task/scratch');
    expect(env.SystemRoot).toBe('C:/Windows');
    expect(env.PATH).toContain('C:/task/scratch/bin');
  });
});

describe('createHostShellAdapter probe', () => {
  function stubRoot() {
    return mkdtempSync(join(tmpdir(), 'host-shell-'));
  }

  it('reports host semantics without sandbox claims', async () => {
    const root = stubRoot();
    const bashPath = join(root, 'bash.exe');
    const helperPath = join(root, 'HostShellRunner.exe');
    writeFileSync(bashPath, 'stub');
    writeFileSync(helperPath, 'stub');
    const adapter = createHostShellAdapter({ bashPath, helperPath, platform: 'win32' });
    const report = await adapter.probe();
    expect(report).toMatchObject({
      status: 'available',
      backend: 'host-git-bash',
      executionBoundary: 'host',
      version: 'host-job-v1',
    });
    const text = report.limitations.join(' ');
    expect(text).toMatch(/宿主|host/i);
    expect(text).toMatch(/网络|network/i);
    // The report must never claim isolation it does not provide.
    expect(JSON.stringify(report)).not.toMatch(/appcontainer|沙箱内|sandboxed/i);
  });

  it('reports unavailable when the host helper is missing', async () => {
    const root = stubRoot();
    const adapter = createHostShellAdapter({
      bashPath: join(root, 'bash.exe'),
      helperPath: join(root, 'HostShellRunner.exe'),
      platform: 'win32',
    });
    await expect(adapter.probe()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('reports unavailable on a non-Windows platform', async () => {
    const root = stubRoot();
    writeFileSync(join(root, 'bash.exe'), 'stub');
    const adapter = createHostShellAdapter({
      bashPath: join(root, 'bash.exe'),
      helperPath: join(root, 'HostShellRunner.exe'),
      platform: 'linux',
    });
    await expect(adapter.probe()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('resolves the packaged helper under the resources path', () => {
    expect(resolveHelperPath({ resourcesPath: 'C:/pkg/Sparkii/resources' }))
      .toBe(join('C:/pkg/Sparkii/resources', 'windows-sandbox', 'HostShellRunner.exe'));
  });
});
