import type { SparkiiApi } from './api-types.js';

export type IpcLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (e: unknown, payload: unknown) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
};

export function buildApi(ipc: IpcLike): SparkiiApi {
  const invoke = (name: string, ...args: unknown[]) => ipc.invoke(`sparkii:${name}`, ...args);
  return {
    login: (username, password) => invoke('login', username, password) as Promise<{ userId: string; roles: string[] }>,
    getProfile: () => invoke('getProfile'),
    chooseDocument: () => invoke('chooseDocument') as Promise<{ path?: string }>,
    runWorkflow: (id, input) => invoke('runWorkflow', id, input) as Promise<{ ok: boolean }>,
    prompt: (text) => invoke('prompt', text) as Promise<{ ok: boolean }>,
    listPendingApprovals: () => invoke('listPendingApprovals') as Promise<unknown[]>,
    decideApproval: (id, approved, note) => invoke('decideApproval', id, approved, note),
    queryAudit: (filter) => invoke('queryAudit', filter) as Promise<unknown[]>,
    getSettings: () => invoke('getSettings'),
    saveSettings: (settings) => invoke('saveSettings', settings),
    listModels: (baseUrl, apiKey) => invoke('listModels', baseUrl, apiKey) as Promise<{ ok: boolean; models?: string[]; error?: string }>,
    testModel: (baseUrl, apiKey) => invoke('testModel', baseUrl, apiKey) as Promise<{ ok: boolean; latencyMs?: number; error?: string }>,
    diagnostics: () => invoke('diagnostics') as Promise<{ logs: string; audit: string }>,
    on: (channel, cb) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(`sparkii:event:${channel}`, listener);
      return () => ipc.removeListener(`sparkii:event:${channel}`, listener as any);
    },
  };
}
