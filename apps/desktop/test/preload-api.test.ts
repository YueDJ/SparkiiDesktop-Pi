import { describe, it, expect } from 'vitest';
import { buildApi } from '../electron/preload/api.js';

describe('sparkii api shape', () => {
  it('exposes the expected method names', () => {
    const names = [
      'login', 'getProfile', 'chooseDocument', 'runWorkflow', 'prompt', 'listPendingApprovals', 'decideApproval', 'queryAudit', 'getSettings', 'saveSettings', 'listModels', 'testModel', 'diagnostics', 'on',
      'newChatSession', 'openChatSession', 'listChatSessions', 'getChatSession', 'getChatMessages', 'promptSession', 'abortChat', 'setChatTitle', 'setChatModel', 'setChatWorkspace', 'chooseWorkspace', 'getModelOptions', 'deleteChatSession', 'listAgents',
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
    void api.newChatSession('general');
    void api.listChatSessions();
    void api.getModelOptions();
    void api.listAgents();
    void api.promptSession('s1', 'hi');
    expect(calls).toEqual([
      'sparkii:newChatSession', 'sparkii:listChatSessions', 'sparkii:getModelOptions',
      'sparkii:listAgents', 'sparkii:promptSession',
    ]);
  });
});
