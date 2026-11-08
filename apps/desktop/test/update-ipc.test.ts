import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { service, readyState } = vi.hoisted(() => {
  const service = {
    getAppVersion: vi.fn(async () => '9.9.9'),
    getState: vi.fn(async () => ({ phase: 'idle' })),
    checkForUpdate: vi.fn(async () => ({ ok: true })),
    downloadUpdate: vi.fn(async () => ({ ok: true })),
    cancelDownload: vi.fn(async () => ({ ok: true })),
    installUpdate: vi.fn(async () => ({ ok: true })),
    clearDownloaded: vi.fn(async () => ({ ok: true })),
    deferUpdate: vi.fn(async () => ({ ok: true })),
    skipUpdate: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(async () => ({ baseUrl: '' })),
    saveSettings: vi.fn(async () => ({ ok: true })),
  };
  const readyState = { value: true };
  return { service, readyState };
});

vi.mock('electron', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    getHandlers: () => handlers,
    ipcMain: {
      handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn); },
    },
    app: {
      getPath: () => '',
      getVersion: () => '0.1.0',
      on: () => {},
      quit: () => {},
    },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    shell: { openPath: vi.fn(async () => '') },
    nativeImage: { createFromPath: vi.fn() },
    webUtils: { getPathForFile: () => '' },
  };
});

vi.mock('../electron/main/document-parse-supervisor.js', () => ({
  getDocumentParseSupervisor: () => ({
    failSession: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({ status: 'stopped', waiting: [] })),
    stopCurrent: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    beginQuit: vi.fn(async () => {}),
    setIdleMinutes: vi.fn(),
    setKeepResident: vi.fn(),
    clearCircuit: vi.fn(),
    setErrorReporter: vi.fn(),
  }),
}));

// service.js 由 G3 提供；此处注入假 UpdateService，验签门禁本身由 G3 实现，不在本测试 mock 掉。
vi.mock('../electron/main/update/service.js', () => ({
  getUpdateService: () => service,
  hasUpdateService: () => readyState.value,
}));

import { registerIpc } from '../electron/main/ipc.js';
import { buildApi } from '../electron/preload/api.js';

const NAMES = [
  'getAppVersion', 'getUpdateState', 'checkForUpdate', 'downloadUpdate',
  'cancelDownload', 'installUpdate', 'clearDownloaded', 'deferUpdate',
  'skipUpdate', 'getUpdateSettings', 'saveUpdateSettings',
] as const;

function fakeRuntime(dataDir: string) {
  return {
    profiles: new Map(),
    pool: { subscribe: () => () => {}, acquire: async () => ({ client: {} }), release: async () => {} },
    audit: { append: async () => {} },
    errors: { append: () => {} },
    subject: { userId: 'tester', roles: [] as string[] },
    security: undefined,
    chatSessions: { get: () => null, list: () => [] },
    dataDir,
    keyFor: async () => null,
    setKey: async () => {},
    knowledgeToken: async () => null,
    setKnowledgeToken: async () => {},
    agentOf: () => ({}),
  } as any;
}

describe('update IPC handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(async () => {
    vi.clearAllMocks();
    readyState.value = true;
    const dataDir = await mkdtemp(join(tmpdir(), 'update-ipc-'));
    const electron = (await import('electron')) as any;
    handlers = electron.getHandlers();
    handlers.clear();
    registerIpc(fakeRuntime(dataDir), () => null, {
      level: 'info', export: async () => '', log: async () => {},
    } as any);
  });

  it('registers all 11 handlers on sparkii:<name>', () => {
    for (const n of NAMES) {
      expect(handlers.has(`sparkii:${n}`)).toBe(true);
    }
  });

  it('delegates each handler to the matching UpdateService method', async () => {
    const e = {};
    await handlers.get('sparkii:getAppVersion')!(e);
    expect(service.getAppVersion).toHaveBeenCalledTimes(1);
    await handlers.get('sparkii:getUpdateState')!(e);
    expect(service.getState).toHaveBeenCalledTimes(1);
    await handlers.get('sparkii:checkForUpdate')!(e, true);
    expect(service.checkForUpdate).toHaveBeenCalledWith(true);
    await handlers.get('sparkii:downloadUpdate')!(e, { version: '0.3.0' });
    expect(service.downloadUpdate).toHaveBeenCalledWith({ version: '0.3.0' });
    await handlers.get('sparkii:cancelDownload')!(e);
    expect(service.cancelDownload).toHaveBeenCalledTimes(1);
    await handlers.get('sparkii:installUpdate')!(e, { version: '0.2.0' });
    expect(service.installUpdate).toHaveBeenCalledWith({ version: '0.2.0' });
    await handlers.get('sparkii:clearDownloaded')!(e, { version: '0.2.0' });
    expect(service.clearDownloaded).toHaveBeenCalledWith({ version: '0.2.0' });
    await handlers.get('sparkii:deferUpdate')!(e);
    expect(service.deferUpdate).toHaveBeenCalledTimes(1);
    await handlers.get('sparkii:skipUpdate')!(e, { version: '0.3.0' });
    expect(service.skipUpdate).toHaveBeenCalledWith({ version: '0.3.0' });
    await handlers.get('sparkii:getUpdateSettings')!(e);
    expect(service.getSettings).toHaveBeenCalledTimes(1);
    await handlers.get('sparkii:saveUpdateSettings')!(e, { autoCheck: false });
    expect(service.saveSettings).toHaveBeenCalledWith({ autoCheck: false });
  });

  it('rejects malformed version at the IPC boundary without calling the service', async () => {
    const bad = await handlers.get('sparkii:downloadUpdate')!({}, { version: '../evil' });
    expect(bad).toEqual({ ok: false, reason: 'POINTER_INVALID' });
    expect(service.downloadUpdate).not.toHaveBeenCalled();
    const bad2 = await handlers.get('sparkii:installUpdate')!({}, { version: '0.1;rm -rf' });
    expect(bad2).toEqual({ ok: false, reason: 'POINTER_INVALID' });
    expect(service.installUpdate).not.toHaveBeenCalled();
    const bad3 = await handlers.get('sparkii:skipUpdate')!({}, { version: 12 });
    expect(bad3).toEqual({ ok: false, reason: 'POINTER_INVALID' });
    expect(service.skipUpdate).not.toHaveBeenCalled();
    const bad4 = await handlers.get('sparkii:clearDownloaded')!({}, null);
    expect(bad4).toEqual({ ok: false, reason: 'POINTER_INVALID' });
    expect(service.clearDownloaded).not.toHaveBeenCalled();
  });

  it('returns DISABLED (and never throws) when the service is not initialized', async () => {
    readyState.value = false;
    const actionNames = [
      'checkForUpdate', 'downloadUpdate', 'cancelDownload', 'installUpdate',
      'clearDownloaded', 'deferUpdate', 'skipUpdate', 'saveUpdateSettings',
    ];
    for (const n of actionNames) {
      const r = await handlers.get(`sparkii:${n}`)!({}, { version: '0.3.0', autoCheck: false });
      expect(r).toEqual({ ok: false, reason: 'DISABLED' });
    }
    expect(service.checkForUpdate).not.toHaveBeenCalled();
    expect(service.downloadUpdate).not.toHaveBeenCalled();
    expect(service.saveSettings).not.toHaveBeenCalled();
    const state = await handlers.get('sparkii:getUpdateState')!({});
    expect(state.phase).toBe('disabled');
    const settings = await handlers.get('sparkii:getUpdateSettings')!({});
    expect(settings.baseUrl).toBe('');
    expect(await handlers.get('sparkii:getAppVersion')!({})).toBe('0.1.0');
  });
});

describe('preload buildApi update methods', () => {
  it('routes all 11 methods to sparkii:<name> with correct args', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const ipc = {
      invoke: (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args });
        return Promise.resolve({ ok: true });
      },
      on: () => {},
      removeListener: () => {},
    };
    const api = buildApi(ipc as any);
    await api.getAppVersion();
    await api.getUpdateState();
    await api.checkForUpdate(true);
    await api.downloadUpdate({ version: '0.3.0' });
    await api.cancelDownload();
    await api.installUpdate({ version: '0.2.0' });
    await api.clearDownloaded({ version: '0.2.0' });
    await api.deferUpdate();
    await api.skipUpdate({ version: '0.3.0' });
    await api.getUpdateSettings();
    await api.saveUpdateSettings({ autoCheck: false });

    expect(calls.map((c) => c.channel)).toEqual(NAMES.map((n) => `sparkii:${n}`));
    expect(calls[0].args).toEqual([]);
    expect(calls[2].args).toEqual([true]);
    expect(calls[3].args).toEqual([{ version: '0.3.0' }]);
    expect(calls[5].args).toEqual([{ version: '0.2.0' }]);
    expect(calls[8].args).toEqual([{ version: '0.3.0' }]);
    expect(calls[10].args).toEqual([{ autoCheck: false }]);
  });

  it('keeps the existing on(channel, cb) pass-through behavior', () => {
    const registered: string[] = [];
    const removed: string[] = [];
    const ipc = {
      invoke: () => Promise.resolve(null),
      on: (channel: string) => { registered.push(channel); },
      removeListener: (channel: string) => { removed.push(channel); },
    };
    const api = buildApi(ipc as any);
    const off = api.on('update-state', () => {});
    expect(registered).toEqual(['sparkii:event:update-state']);
    off();
    expect(removed).toEqual(['sparkii:event:update-state']);
  });
});
