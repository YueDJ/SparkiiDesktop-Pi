import type { SparkiiApi } from '../../src/types/sparkii-api.js';

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
    exportReport: (input) => invoke('exportReport', input),
    prompt: (text) => invoke('prompt', text) as Promise<{ ok: boolean }>,
    listPendingApprovals: () => invoke('listPendingApprovals'),
    decideApproval: (id, approved, note) => invoke('decideApproval', id, approved, note),
    queryAudit: (filter) => invoke('queryAudit', filter),
    on: (channel, cb) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(`sparkii:event:${channel}`, listener);
      return () => ipc.removeListener(`sparkii:event:${channel}`, listener as any);
    },
  };
}
