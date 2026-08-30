import { describe, it, expect, vi } from 'vitest';
import { buildApi } from '../electron/preload/api.js';

vi.mock('electron', () => ({
  webUtils: {
    getPathForFile: () => 'C:/mock/file',
  },
}));

describe('sparkii api shape', () => {
  it('exposes the expected method names', () => {
    const names = [
      'getLocalSubject', 'chooseDocument', 'runWorkflow', 'prompt', 'listPendingApprovals', 'decideApproval', 'queryAudit', 'getSettings', 'saveSettings', 'getApiKey', 'listModels', 'testConnection', 'listProviders', 'diagnostics', 'on',
      'openChatSession', 'listChatSessions', 'getChatSession', 'promptSession', 'abortChat', 'getChatState', 'queueMutate', 'setChatTitle', 'setChatModel', 'setChatThinkingLevel', 'setChatWorkspace', 'chooseWorkspace', 'getModelOptions', 'listThinkingLevels', 'deleteChatSession', 'setSessionPinned', 'setSessionArchived', 'setSessionOrder', 'listAgents',
      'getRuntimePool', 'cancelQueuedSession', 'releaseSessionSlot',
      'getPathForFile',
      'windowMinimize', 'windowToggleMaximize', 'windowClose', 'windowIsMaximized',
    ];
    const api = buildApi({ invoke: () => Promise.resolve(null), on: () => () => {}, removeListener: () => {} } as any);
    expect(Object.keys(api).sort()).toEqual([...names].sort());
    for (const n of names) expect(typeof (api as any)[n]).toBe('function');
  });

  it('exposes chat session and agent APIs', () => {
    const calls: string[] = [];
    const ipc = {
      invoke: (channel: string) => { calls.push(channel); return Promise.resolve({ ok: true }); },
      on: () => {},
      removeListener: () => {},
    };
    const api = buildApi(ipc as any);
    void api.listChatSessions();
    void api.getModelOptions();
    void api.setChatThinkingLevel('s1', 'high');
    void api.listThinkingLevels('deepseek', 'deepseek-v4-pro');
    void api.listAgents();
    void api.promptSession('s1', 'hi');
    expect(calls).toEqual([
      'sparkii:listChatSessions', 'sparkii:getModelOptions',
      'sparkii:setChatThinkingLevel', 'sparkii:listThinkingLevels', 'sparkii:listAgents', 'sparkii:promptSession',
    ]);
  });
});
