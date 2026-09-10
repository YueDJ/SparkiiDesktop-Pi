import type { ErrorRecord, ProviderEntryInfo, SparkiiApi } from './api-types.js';
import type { RuntimePoolSnapshot } from '@sparkii/agent-host';
import { webUtils } from 'electron';

export type IpcLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (e: unknown, payload: unknown) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
};

export function buildApi(ipc: IpcLike): SparkiiApi {
  const invoke = (name: string, ...args: unknown[]) => ipc.invoke(`sparkii:${name}`, ...args);
  return {
    getLocalSubject: () => invoke('getLocalSubject') as Promise<{ userId: string; roles: string[] }>,
    chooseDocument: (opts) => invoke('chooseDocument', opts) as Promise<{ path?: string }>,
    readDocumentBytes: (path, sessionId) => invoke('readDocumentBytes', path, sessionId) as Promise<import('./api-types.js').ReadDocumentBytesResult>,
    runWorkflow: (id, input) => invoke('runWorkflow', id, input) as Promise<{ ok: boolean; sessionId?: string }>,
    prompt: (text) => invoke('prompt', text) as Promise<{ ok: boolean }>,
    openChatSession: (sessionId) => invoke('openChatSession', sessionId) as Promise<import('./api-types.js').OpenChatSessionResult>,
    listChatSessions: (profileId) => invoke('listChatSessions', profileId) as Promise<unknown[]>,
    getChatSession: (sessionId) => invoke('getChatSession', sessionId),
    promptSession: (sessionId, text, options, attachments, context) => invoke('promptSession', sessionId, text, options, attachments, context) as Promise<{ ok: boolean; sessionId?: string; behavior?: 'prompt' | 'steer' | 'followUp' }>,
    abortChat: (sessionId) => invoke('abortChat', sessionId) as Promise<{ ok: boolean; cleared?: { steering: string[]; followUp: string[] } }>,
    getChatState: (sessionId) => invoke('getChatState', sessionId) as Promise<import('./api-types.js').ChatQueueState>,
    queueMutate: (sessionId, mutation) => invoke('queueMutate', sessionId, mutation) as Promise<{ ok: boolean; steering: string[]; followUp: string[] }>,
    setChatTitle: (sessionId, title, source) => invoke('setChatTitle', sessionId, title, source) as Promise<{ ok: boolean; reason?: 'locked' }>,
    completeText: (sessionId, text) => invoke('completeText', sessionId, text) as Promise<{ ok: boolean; text?: string }>,
    setSessionPinned: (sessionId, pinned, profileId) => invoke('setSessionPinned', sessionId, pinned, profileId) as Promise<{ ok: boolean }>,
    setSessionArchived: (sessionId, archived, profileId) => invoke('setSessionArchived', sessionId, archived, profileId) as Promise<{ ok: boolean }>,
    setSessionOrder: (sessionId, sortOrder, profileId) => invoke('setSessionOrder', sessionId, sortOrder, profileId) as Promise<{ ok: boolean }>,
    setChatModel: (sessionId, model) => invoke('setChatModel', sessionId, model) as Promise<{ ok: boolean }>,
    setChatThinkingLevel: (sessionId, level) => invoke('setChatThinkingLevel', sessionId, level) as Promise<{ ok: boolean }>,
    setChatWorkspace: (sessionId, path) => invoke('setChatWorkspace', sessionId, path) as Promise<{ ok: boolean }>,
    updateWorkflowState: (sessionId, entry) => invoke('updateWorkflowState', sessionId, entry) as Promise<{ ok: boolean }>,
    requestExportReport: (sessionId, summary) => invoke('requestExportReport', sessionId, summary) as Promise<{ ok: boolean; approved: boolean }>,
    chooseWorkspace: () => invoke('chooseWorkspace') as Promise<{ path?: string }>,
    listUserSkills: () => invoke('listUserSkills') as ReturnType<SparkiiApi['listUserSkills']>,
    listAgentSkills: (agentId) => invoke('listAgentSkills', agentId) as ReturnType<SparkiiApi['listAgentSkills']>,
    previewUserSkill: (sourceDir) => invoke('previewUserSkill', sourceDir) as ReturnType<SparkiiApi['previewUserSkill']>,
    chooseSkillFolder: () => invoke('chooseSkillFolder') as Promise<{ path?: string }>,
    importUserSkill: (opts) => invoke('importUserSkill', opts) as ReturnType<SparkiiApi['importUserSkill']>,
    uninstallUserSkill: (opts) => invoke('uninstallUserSkill', opts) as ReturnType<SparkiiApi['uninstallUserSkill']>,
    openUserSkillsDir: () => invoke('openUserSkillsDir') as ReturnType<SparkiiApi['openUserSkillsDir']>,
    getPathForFile: (file) => webUtils.getPathForFile(file),
    getModelOptions: (agentId) => invoke('getModelOptions', agentId) as Promise<{ defaultModel: string | null; models: string[]; provider: string; supportsImages?: Record<string, boolean>; modelRequirements?: { requires: string[]; prefers?: string[] }; compatibleModels?: string[]; incompatibleModels?: string[] }>,
    listThinkingLevels: (providerId, modelId) => invoke('listThinkingLevels', providerId, modelId) as Promise<string[]>,
    deleteChatSession: (sessionId) => invoke('deleteChatSession', sessionId) as Promise<{ ok: boolean }>,
    getRuntimePool: () => invoke('getRuntimePool') as Promise<RuntimePoolSnapshot>,
    getDocumentParse: () => invoke('getDocumentParse') as ReturnType<SparkiiApi['getDocumentParse']>,
    stopDocumentParse: () => invoke('stopDocumentParse') as Promise<void>,
    releaseDocumentParse: () => invoke('releaseDocumentParse') as Promise<void>,
    cancelDocumentParseLoad: () => invoke('cancelDocumentParseLoad') as Promise<void>,
    cancelQueuedSession: (queueId) => invoke('cancelQueuedSession', queueId) as Promise<{ ok: boolean }>,
    releaseSessionSlot: (sessionId) => invoke('releaseSessionSlot', sessionId) as Promise<{ ok: boolean }>,
    listAgents: () => invoke('listAgents') as Promise<Array<{ id: string; name: string }>>,
    listPendingApprovals: () => invoke('listPendingApprovals') as Promise<unknown[]>,
    decideApproval: (id, approved, note) => invoke('decideApproval', id, approved, note),
    queryAudit: (filter) => invoke('queryAudit', filter) as Promise<unknown[]>,
    getSettings: () => invoke('getSettings'),
    saveSettings: (settings) => invoke('saveSettings', settings),
    saveRagSettings: (partial) => invoke('saveRagSettings', partial) as Promise<{ ok: true }>,
    saveDocumentParseSettings: (partial) => invoke('saveDocumentParseSettings', partial) as Promise<{ ok: true }>,
    listDocumentParseModules: () => invoke('listDocumentParseModules') as ReturnType<SparkiiApi['listDocumentParseModules']>,
    retryDocumentParse: () => invoke('retryDocumentParse') as Promise<{ ok: true }>,
    importDocumentParseModule: (path) => invoke('importDocumentParseModule', path) as Promise<{ ok: boolean; error?: string }>,
    downloadDocumentParseModule: (id) => invoke('downloadDocumentParseModule', id) as Promise<{ ok: boolean; error?: string }>,
    testRagConnection: (apiKey) => invoke('testRagConnection', apiKey) as Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>,
    listRagDatasets: (apiKey) => invoke('listRagDatasets', apiKey) as Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>,
    setSessionKnowledge: (sessionId, selection) => invoke('setSessionKnowledge', sessionId, selection) as Promise<{ ok: boolean; error?: string }>,
    openRagDocument: (args) => invoke('openRagDocument', args) as Promise<{ ok: boolean; path?: string; error?: string }>,
    getApiKey: (provider) => invoke('getApiKey', provider) as Promise<string | null>,
    listProviders: () => invoke('listProviders') as Promise<ProviderEntryInfo[]>,
    listModels: (provider, apiKey) => invoke('listModels', provider, apiKey) as Promise<{ ok: boolean; models?: string[]; httpStatus?: number; reason?: string; error?: string }>,
    testConnection: (provider, apiKey) => invoke('testConnection', provider, apiKey) as Promise<{ ok: boolean; latencyMs?: number; httpStatus?: number; reason?: string; error?: string }>,
    diagnostics: () => invoke('diagnostics') as Promise<{ logs: string; audit: string }>,
    listErrors: () => invoke('listErrors') as Promise<ErrorRecord[]>,
    appendError: (rec) => invoke('appendError', rec) as Promise<ErrorRecord>,
    clearError: (id) => invoke('clearError', id) as Promise<{ ok: boolean }>,
    clearErrors: () => invoke('clearErrors') as Promise<{ ok: boolean }>,
    markAllErrorsRead: () => invoke('markAllErrorsRead') as Promise<{ ok: boolean }>,
    windowMinimize: () => invoke('windowMinimize') as Promise<boolean>,
    windowToggleMaximize: () => invoke('windowToggleMaximize') as Promise<boolean>,
    windowClose: () => invoke('windowClose') as Promise<boolean>,
    windowIsMaximized: () => invoke('windowIsMaximized') as Promise<boolean>,
    on: (channel, cb) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(`sparkii:event:${channel}`, listener);
      return () => ipc.removeListener(`sparkii:event:${channel}`, listener as any);
    },
  };
}
