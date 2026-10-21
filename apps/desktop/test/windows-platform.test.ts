import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWindowsPathProbe,
  windowsPathKey,
  windowsProtectedRoots,
  type WindowsPlatformOptions,
} from '../electron/main/security/windows-platform.js';

const baseOptions: WindowsPlatformOptions = {
  home: 'C:/Users/me',
  windowsDir: 'C:/Windows',
  programFiles: 'C:/Program Files',
  programFilesX86: 'C:/Program Files (x86)',
  programData: 'C:/ProgramData',
  appData: 'C:/Users/me/AppData/Roaming',
  localAppData: 'C:/Users/me/AppData/Local',
  dataDir: 'C:/Users/me/AppData/Roaming/Sparkii/data',
  volumes: ['C:/', 'D:/'],
};

describe('windowsProtectedRoots', () => {
  it('marks system, program, app data, credentials, and Sparkii roots as closures', () => {
    const roots = windowsProtectedRoots(baseOptions);
    expect(roots).toEqual(expect.arrayContaining([
      { path: 'C:/Windows', policy: 'closure' },
      { path: 'C:/Program Files', policy: 'closure' },
      { path: 'C:/Program Files (x86)', policy: 'closure' },
      { path: 'C:/ProgramData', policy: 'closure' },
      { path: 'C:/Users/me/AppData/Roaming', policy: 'closure' },
      { path: 'C:/Users/me/AppData/Local', policy: 'closure' },
      { path: 'C:/Users/me/AppData/Roaming/Sparkii/data', policy: 'closure' },
      { path: 'C:/Users/me/.ssh', policy: 'closure' },
      { path: 'C:/Users/me/.aws', policy: 'closure' },
      { path: 'C:/Users/me', policy: 'boundary' },
      { path: 'C:/', policy: 'boundary' },
      { path: 'D:/', policy: 'boundary' },
    ]));
  });
});

describe('windowsPathKey', () => {
  it('normalizes case, separators, trailing separators, and extended drive prefixes', () => {
    expect(windowsPathKey('C:\\Work\\Project\\')).toBe('c:/work/project');
    expect(windowsPathKey('\\\\?\\C:\\Work\\Project')).toBe('c:/work/project');
    expect(windowsPathKey('\\\\?\\UNC\\server\\share\\folder')).toBe('//server/share/folder');
    expect(windowsPathKey('C:\\')).toBe('c:/');
  });
});

describe.skipIf(process.platform !== 'win32')('createWindowsPathProbe', () => {
  it('canonicalizes existing objects and gives stable identities through case aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sparkii-win-probe-'));
    const file = join(root, 'Sample.txt');
    await writeFile(file, 'x');
    const probe = createWindowsPathProbe({
      ...baseOptions,
      home: root,
      dataDir: join(root, 'data'),
    });

    const first = await probe.inspect(file);
    const alias = await probe.inspect(file.toUpperCase());
    expect(first.canonicalPath.toLowerCase()).toBe(file.toLowerCase());
    expect(alias.identity).toBe(first.identity);
    expect(await probe.isSameObject(file, file.toUpperCase())).toBe(true);
  });

  it('checks descendant boundaries by segment rather than sibling prefixes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'sparkii-win-boundary-'));
    const project = join(parent, 'project');
    const sibling = join(parent, 'project-copy');
    await mkdir(project);
    await mkdir(sibling);
    const probe = createWindowsPathProbe({
      ...baseOptions,
      home: parent,
      dataDir: join(parent, 'data'),
    });

    expect(await probe.isSameOrDescendant(project, join(project, 'src', 'a.ts'))).toBe(true);
    expect(await probe.isSameOrDescendant(project, sibling)).toBe(false);
  });

  it('resolves a missing target through its nearest existing ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sparkii-win-missing-'));
    const target = join(root, 'not-created', 'project');
    const probe = createWindowsPathProbe({
      ...baseOptions,
      home: root,
      dataDir: join(root, 'data'),
    });

    const inspected = await probe.inspect(target);
    expect(inspected.exists).toBe(false);
    expect(inspected.isDirectory).toBe(false);
    expect(inspected.nearestExistingAncestor.toLowerCase()).toBe(root.toLowerCase());
    expect(inspected.identity).toContain('missing:');
    expect(await probe.isSameOrDescendant(root, target)).toBe(true);
  });

  it('resolves a junction alias to the same object identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sparkii-win-junction-'));
    const real = join(root, 'real');
    const link = join(root, 'link');
    await mkdir(real);
    await symlink(real, link, 'junction');
    const probe = createWindowsPathProbe({
      ...baseOptions,
      home: root,
      dataDir: join(root, 'data'),
    });

    const direct = await probe.inspect(real);
    const alias = await probe.inspect(link);
    expect(alias.canonicalPath.toLowerCase()).toBe(real.toLowerCase());
    expect(alias.identity).toBe(direct.identity);
    expect(alias.isReparsePoint).toBe(true);
  });

  it('rejects relative paths, device paths, and alternate data streams', async () => {
    const probe = createWindowsPathProbe(baseOptions);
    await expect(probe.inspect('relative\\path')).rejects.toThrow(/absolute/i);
    await expect(probe.inspect('\\\\.\\C:\\Windows')).rejects.toThrow(/device/i);
    await expect(probe.inspect('C:\\Windows\\file.txt:secret')).rejects.toThrow(/stream/i);
  });
});
