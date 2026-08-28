export interface ProviderEntryInfo {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  baseUrl: string;
  apiKeyAuth: boolean;
  oauthAuth: boolean;
  api?: 'openai-completions' | 'anthropic-messages';
}

export interface SparkiiApi {
  getLocalSubject(): Promise<{ userId: string; roles: string[] }>;
  getProfile(): Promise<unknown>;
  chooseDocument(): Promise<{ path?: string }>;
  runWorkflow(id: string, input: Record<string, unknown>): Promise<{ ok: boolean }>;
  prompt(text: string): Promise<{ ok: boolean }>;
  newChatSession(profileId: string): Promise<{ sessionId: string; workspacePath: string; model: string | null }>;
  openChatSession(sessionId: string): Promise<{ messages: unknown[] }>;
  listChatSessions(profileId?: string): Promise<unknown[]>;
  getChatSession(sessionId: string): Promise<unknown>;
  getChatMessages(sessionId: string): Promise<unknown[]>;
  promptSession(sessionId: string, text: string): Promise<{ ok: boolean }>;
  abortChat(sessionId: string): Promise<{ ok: boolean }>;
  setChatTitle(sessionId: string, title: string): Promise<{ ok: boolean }>;
  setChatModel(sessionId: string, model: string | null): Promise<{ ok: boolean }>;
  setChatThinkingLevel(sessionId: string, level: string | null): Promise<{ ok: boolean }>;
  setChatWorkspace(sessionId: string, path: string | null): Promise<{ ok: boolean }>;
  chooseWorkspace(): Promise<{ path?: string }>;
  getPathForFile(file: File): string;
  getModelOptions(): Promise<{ defaultModel: string | null; models: string[]; provider: string }>;
  listThinkingLevels(providerId: string, modelId: string): Promise<string[]>;
  deleteChatSession(sessionId: string): Promise<{ ok: boolean }>;
  listAgents(): Promise<Array<{ id: string; name: string }>>;
  listPendingApprovals(): Promise<unknown[]>;
  decideApproval(id: string, approved: boolean, note?: string): Promise<unknown>;
  queryAudit(filter: object): Promise<unknown[]>;
  getSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<unknown>;
  getApiKey(provider: string): Promise<string | null>;
  listProviders(): Promise<ProviderEntryInfo[]>;
  listModels(provider: string, apiKey?: string | null): Promise<{ ok: boolean; models?: string[]; httpStatus?: number; reason?: string; error?: string }>;
  testConnection(provider: string, apiKey?: string | null): Promise<{ ok: boolean; latencyMs?: number; httpStatus?: number; reason?: string; error?: string }>;
  diagnostics(): Promise<{ logs: string; audit: string }>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
}
