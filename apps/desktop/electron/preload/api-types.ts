import type { RuntimePoolSnapshot } from '@sparkii/agent-host';

export interface ProviderEntryInfo {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  baseUrl: string;
  apiKeyAuth: boolean;
  oauthAuth: boolean;
  api?: 'openai-completions' | 'anthropic-messages';
}

export type ChatQueueName = 'steering' | 'followUp';

export type ChatQueueMutation =
  | { action: 'edit'; queue: ChatQueueName; index: number; text: string }
  | { action: 'delete'; queue: ChatQueueName; index: number }
  | { action: 'move'; queue: ChatQueueName; fromIndex: number; toIndex: number }
  | { action: 'transfer'; queue: ChatQueueName; index: number; targetQueue: ChatQueueName };

export interface ChatQueueState {
  streaming: boolean;
  steering: string[];
  followUp: string[];
  isCompacting?: boolean;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
}

export interface DraftPromptContext {
  profileId?: string;
  workspacePath?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
}

export interface ChatAttachment {
  path: string;
  name: string;
  size?: number;
  type?: string;
}

export interface ErrorRecord {
  id: string;
  message: string;
  source: string;
  createdAt: number;
  read: boolean;
}

export interface SparkiiApi {
  getLocalSubject(): Promise<{ userId: string; roles: string[] }>;
  chooseDocument(): Promise<{ path?: string }>;
  runWorkflow(id: string, input: Record<string, unknown>): Promise<{ ok: boolean }>;
  prompt(text: string): Promise<{ ok: boolean }>;
  openChatSession(sessionId: string): Promise<{ messages: unknown[]; entries?: unknown[] }>;
  listChatSessions(profileId?: string): Promise<unknown[]>;
  getChatSession(sessionId: string): Promise<unknown>;
  promptSession(sessionId: string | null, text: string, options?: { behavior?: 'steer' | 'followUp' }, attachments?: ChatAttachment[], context?: DraftPromptContext): Promise<{ ok: boolean; sessionId?: string; behavior?: 'prompt' | 'steer' | 'followUp' }>;
  abortChat(sessionId: string): Promise<{ ok: boolean; cleared?: { steering: string[]; followUp: string[] } }>;
  getChatState(sessionId: string): Promise<ChatQueueState>;
  queueMutate(sessionId: string, mutation: ChatQueueMutation): Promise<{ ok: boolean; steering: string[]; followUp: string[] }>;
  setChatTitle(sessionId: string, title: string): Promise<{ ok: boolean }>;
  setSessionPinned(sessionId: string, pinned: boolean, profileId?: string): Promise<{ ok: boolean }>;
  setSessionArchived(sessionId: string, archived: boolean, profileId?: string): Promise<{ ok: boolean }>;
  setSessionOrder(sessionId: string, sortOrder: number | null, profileId?: string): Promise<{ ok: boolean }>;
  setChatModel(sessionId: string, model: string | null): Promise<{ ok: boolean }>;
  setChatThinkingLevel(sessionId: string, level: string | null): Promise<{ ok: boolean }>;
  setChatWorkspace(sessionId: string, path: string | null): Promise<{ ok: boolean }>;
  chooseWorkspace(): Promise<{ path?: string }>;
  getPathForFile(file: File): string;
  getModelOptions(): Promise<{ defaultModel: string | null; models: string[]; provider: string }>;
  listThinkingLevels(providerId: string, modelId: string): Promise<string[]>;
  deleteChatSession(sessionId: string): Promise<{ ok: boolean }>;
  getRuntimePool(): Promise<RuntimePoolSnapshot>;
  cancelQueuedSession(queueId: string): Promise<{ ok: boolean }>;
  releaseSessionSlot(sessionId: string): Promise<{ ok: boolean }>;
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
  listErrors(): Promise<ErrorRecord[]>;
  appendError(rec: { id: string; message: string; source: string; createdAt: number }): Promise<ErrorRecord>;
  clearError(id: string): Promise<{ ok: boolean }>;
  clearErrors(): Promise<{ ok: boolean }>;
  markAllErrorsRead(): Promise<{ ok: boolean }>;
  windowMinimize(): Promise<boolean>;
  windowToggleMaximize(): Promise<boolean>;
  windowClose(): Promise<boolean>;
  windowIsMaximized(): Promise<boolean>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
}
