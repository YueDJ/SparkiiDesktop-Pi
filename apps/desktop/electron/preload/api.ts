import type { ProviderEntryInfo, SparkiiApi } from './api-types.js';

export type IpcLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (e: unknown, payload: unknown) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
};

export function buildApi(ipc: IpcLike): SparkiiApi {
  const invoke = (name: string, ...args: unknown[]) => ipc.invoke(`sparkii:${name}`, ...args);
  return {
    getLocalSubject: () => invoke('getLocalSubject') as Promise<{ userId: string; roles: string[] }>,
    getProfile: () => invoke('getProfile'),
    chooseDocument: () => invoke('chooseDocument') as Promise<{ path?: string }>,
    runWorkflow: (id, input) => invoke('runWorkflow', id, input) as Promise<{ ok: boolean }>,
    prompt: (text) => invoke('prompt', text) as Promise<{ ok: boolean }>,
    newChatSession: (profileId) => invoke('newChatSession', profileId) as Promise<{ sessionId: string; workspacePath: string; model: string | null }>,
    openChatSession: (sessionId) => invoke('openChatSession', sessionId) as Promise<{ messages: unknown[] }>,
    listChatSessions: (profileId) => invoke('listChatSessions', profileId) as Promise<unknown[]>,
    getChatSession: (sessionId) => invoke('getChatSession', sessionId),
    getChatMessages: (sessionId) => invoke('getChatMessages', sessionId) as Promise<unknown[]>,
    promptSession: (sessionId, text) => invoke('promptSession', sessionId, text) as Promise<{ ok: boolean }>,
    abortChat: (sessionId) => invoke('abortChat', sessionId) as Promise<{ ok: boolean }>,
    setChatTitle: (sessionId, title) => invoke('setChatTitle', sessionId, title) as Promise<{ ok: boolean }>,
    setChatModel: (sessionId, model) => invoke('setChatModel', sessionId, model) as Promise<{ ok: boolean }>,
    setChatWorkspace: (sessionId, path) => invoke('setChatWorkspace', sessionId, path) as Promise<{ ok: boolean }>,
    chooseWorkspace: () => invoke('chooseWorkspace') as Promise<{ path?: string }>,
    getModelOptions: () => invoke('getModelOptions') as Promise<{ defaultModel: string | null; models: string[] }>,
    deleteChatSession: (sessionId) => invoke('deleteChatSession', sessionId) as Promise<{ ok: boolean }>,
    listAgents: () => invoke('listAgents') as Promise<Array<{ id: string; name: string }>>,
    listPendingApprovals: () => invoke('listPendingApprovals') as Promise<unknown[]>,
    decideApproval: (id, approved, note) => invoke('decideApproval', id, approved, note),
    queryAudit: (filter) => invoke('queryAudit', filter) as Promise<unknown[]>,
    getSettings: () => invoke('getSettings'),
    saveSettings: (settings) => invoke('saveSettings', settings),
    getApiKey: (provider) => invoke('getApiKey', provider) as Promise<string | null>,
    listProviders: () => invoke('listProviders') as Promise<ProviderEntryInfo[]>,
    listModels: (provider, apiKey) => invoke('listModels', provider, apiKey) as Promise<{ ok: boolean; models?: string[]; httpStatus?: number; reason?: string; error?: string }>,
    testConnection: (provider, apiKey) => invoke('testConnection', provider, apiKey) as Promise<{ ok: boolean; latencyMs?: number; httpStatus?: number; reason?: string; error?: string }>,
    diagnostics: () => invoke('diagnostics') as Promise<{ logs: string; audit: string }>,
    on: (channel, cb) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(`sparkii:event:${channel}`, listener);
      return () => ipc.removeListener(`sparkii:event:${channel}`, listener as any);
    },
  };
}
