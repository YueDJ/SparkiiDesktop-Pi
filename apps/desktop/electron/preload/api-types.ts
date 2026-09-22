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
  workspaceKind?: 'auto' | 'user';
  model?: string | null;
  thinkingLevel?: string | null;
}

export type ChooseDocumentOptions = { extensions?: string[] };

export type DocumentKind = 'pdf' | 'docx' | 'txt' | 'image';

export type ReadDocumentBytesResult =
  | { kind: DocumentKind; fileName: string; fileSize: number; bytes: ArrayBuffer }
  | { error: 'missing' | 'unsupported' | 'too_large' | 'denied' };

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

export interface OpenChatSessionResult {
  /** 已提交条目：进程活着时是 `getBranch()`，已释放时是 JSONL 正文（不含 header）。 */
  entries?: unknown[];
  /** 未入树的那句 assistant 全文；进程已释放时恒为 null。 */
  streamingMessage?: unknown | null;
  /** 来自 `get_state.isStreaming`；气泡是否转圈只看这个字段。 */
  streaming?: boolean;
  inputs?: Array<{ path: string; name?: string; missing?: boolean }>;
}

export type KnowledgeSelection =
  | { mode: 'ids'; datasetIds: string[] }
  | { mode: 'all' };

/** 远端知识后端的判别值（`bm25` 是本地语料，不经凭据与网络）。 */
export type KnowledgeBackendId = 'sparkiirag' | 'sparkiionto';

export type KnowledgeAgentBinding = { agentId: string; defaultDatasetId: string };

/** `sparkii:saveKnowledgeSettings` 的写入载荷：URL 写严格，空 token 不覆盖已存凭据。 */
export type KnowledgeSettingsPartial = {
  baseUrl?: string;
  similarityThreshold?: number;
  vectorSimilarityWeight?: number;
  bindings?: KnowledgeAgentBinding[];
  apiKey?: string;
};

/** 探活可带入未保存的临时值（设置页"测试连接"先测后存）。 */
export type KnowledgeProbeOverride = { baseUrl?: string; apiKey?: string | null };

export type KnowledgeProbeError = {
  code: string;
  message: string;
  reason: 'unreachable' | 'unauthorized' | 'forbidden' | 'unsupported' | 'unhealthy' | 'invalid_config';
};

export type KnowledgeProbeDataset = { id: string; name: string };

export type KnowledgeProbeResult = {
  ok: boolean;
  backend: KnowledgeBackendId;
  /** 归一化后的地址（探活实际使用的那个）。 */
  baseUrl?: string;
  /** 仅 Onto 的 `/info` 能力协商结果。 */
  info?: {
    product: string;
    version: string;
    api_version: string;
    deployment_profile: string;
    retrieval: { backend: string; semantic_embeddings: boolean };
    capabilities: Record<string, boolean>;
  };
  datasets?: KnowledgeProbeDataset[];
  error?: KnowledgeProbeError;
};

/** `sparkii:probeOntologyGraph` 的图谱自检结果（只读，失败不阻断保存）。 */
export type OntologyGraphProbeResult = {
  ok: boolean;
  nodeCount?: number;
  edgeCount?: number;
  nodeTypes?: Record<string, number>;
  error?: string;
};


export interface SparkiiApi {
  getLocalSubject(): Promise<{ userId: string; roles: string[] }>;
  chooseDocument(opts?: ChooseDocumentOptions): Promise<{ path?: string }>;
  readDocumentBytes(path: string, sessionId?: string | null): Promise<ReadDocumentBytesResult>;
  runWorkflow(id: string, input: Record<string, unknown>): Promise<{ ok: boolean; sessionId?: string }>;
  prompt(text: string): Promise<{ ok: boolean }>;
  openChatSession(sessionId: string): Promise<OpenChatSessionResult>;
  listChatSessions(profileId?: string): Promise<unknown[]>;
  getChatSession(sessionId: string): Promise<unknown>;
  promptSession(sessionId: string | null, text: string, options?: { behavior?: 'steer' | 'followUp' }, attachments?: ChatAttachment[], context?: DraftPromptContext): Promise<{ ok: boolean; sessionId?: string; behavior?: 'prompt' | 'steer' | 'followUp' }>;
  abortChat(sessionId: string): Promise<{ ok: boolean; cleared?: { steering: string[]; followUp: string[] } }>;
  getChatState(sessionId: string): Promise<ChatQueueState>;
  queueMutate(sessionId: string, mutation: ChatQueueMutation): Promise<{ ok: boolean; steering: string[]; followUp: string[] }>;
  setChatTitle(sessionId: string, title: string, source?: 'user' | 'agent'): Promise<{ ok: boolean; reason?: 'locked' }>;
  completeText(sessionId: string, text: string): Promise<{ ok: boolean; text?: string }>;
  setSessionPinned(sessionId: string, pinned: boolean, profileId?: string): Promise<{ ok: boolean }>;
  setSessionArchived(sessionId: string, archived: boolean, profileId?: string): Promise<{ ok: boolean }>;
  setSessionOrder(sessionId: string, sortOrder: number | null, profileId?: string): Promise<{ ok: boolean }>;
  setChatModel(sessionId: string, model: string | null): Promise<{ ok: boolean }>;
  setChatThinkingLevel(sessionId: string, level: string | null): Promise<{ ok: boolean }>;
  setChatWorkspace(sessionId: string, path: string | null): Promise<{ ok: boolean }>;
  updateWorkflowState(sessionId: string, entry: Record<string, unknown>): Promise<{ ok: boolean }>;
  requestExportReport(sessionId: string, summary: Record<string, unknown>): Promise<{ ok: boolean; approved: boolean }>;
  allocateAutoWorkspace(agentId: string): Promise<{ workspacePath: string }>;
  chooseWorkspace(opts?: { defaultPath?: string }): Promise<{ path?: string }>;
  openWorkspace(path: string): Promise<{ ok: boolean; error?: string }>;
  listUserSkills(): Promise<{
    agent: { id: string; name: string } | null;
    skills: Array<{ name: string; description: string; hasScripts: boolean; warnings: string[]; kind?: 'skill' | 'pack'; skillCount?: number }>;
  }>;
  listAgentSkills(agentId: string): Promise<{
    skills: Array<{ name: string; description: string; hasScripts: boolean; warnings: string[] }>;
  }>;
  previewUserSkill(sourceDir: string): Promise<
    | { ok: true; skill: { name: string; description: string; hasScripts: boolean; warnings: string[]; kind?: 'skill' | 'pack'; skillCount?: number }; destName: string }
    | { ok: false; reason: string; diagnostics?: string[] }
  >;
  chooseSkillFolder(): Promise<{ path?: string }>;
  importUserSkill(opts: { sourceDir: string; overwrite?: boolean }): Promise<
    { ok: true; name: string } | { ok: false; reason: string; name?: string; diagnostics?: string[] }
  >;
  uninstallUserSkill(opts: { name: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  openUserSkillsDir(): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
  getPathForFile(file: File): string;
  getModelOptions(agentId?: string): Promise<{ defaultModel: string | null; models: string[]; provider: string; supportsImages?: Record<string, boolean>; modelRequirements?: { requires: string[]; prefers?: string[] }; compatibleModels?: string[]; incompatibleModels?: string[] }>;
  listThinkingLevels(providerId: string, modelId: string): Promise<string[]>;
  deleteChatSession(sessionId: string): Promise<{ ok: boolean }>;
  getRuntimePool(): Promise<RuntimePoolSnapshot>;
  getDocumentParse(): Promise<{
    status: 'stopped' | 'starting' | 'parsing' | 'idle' | 'resident';
    fileName?: string;
    agentDisplayName?: string;
    page?: number;
    total?: number;
    idleRemainingSec?: number;
    waiting: Array<{ sessionId: string; agentDisplayName: string; fileName: string }>;
    circuitOpen?: boolean;
  }>;
  stopDocumentParse(): Promise<void>;
  releaseDocumentParse(): Promise<void>;
  cancelDocumentParseLoad(): Promise<void>;
  cancelQueuedSession(queueId: string): Promise<{ ok: boolean }>;
  releaseSessionSlot(sessionId: string): Promise<{ ok: boolean }>;
  listAgents(): Promise<Array<{
    id: string;
    name: string;
    surfaceType?: string;
    declaresOntologyTools?: boolean;
    knowledge?: { enabled: boolean; picker: 'hidden' | 'session'; backend: 'bm25' | 'sparkiirag' };
  }>>;
  probeOntologyGraph(): Promise<OntologyGraphProbeResult>;
  listPendingApprovals(): Promise<unknown[]>;
  decideApproval(id: string, approved: boolean, note?: string): Promise<unknown>;
  queryAudit(filter: object): Promise<unknown[]>;
  getSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<unknown>;
  saveRagSettings(partial: {
    baseUrl?: string;
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    bindings?: Array<{ agentId: string; defaultDatasetId: string }>;
    apiKey?: string;
  }): Promise<{ ok: true }>;
  saveKnowledgeSettings(backend: KnowledgeBackendId, partial: KnowledgeSettingsPartial): Promise<{ ok: boolean; error?: string }>;
  saveDocumentParseSettings(partial: { idleMinutes: number; keepResident: boolean }): Promise<{ ok: true }>;
  listDocumentParseModules(): Promise<Array<{
    id: string;
    label: string;
    bundled?: boolean;
    installed: boolean;
    canDownload: boolean;
  }>>;
  retryDocumentParse(): Promise<{ ok: true }>;
  importDocumentParseModule(path?: string): Promise<{ ok: boolean; error?: string }>;
  downloadDocumentParseModule(id: string): Promise<{ ok: boolean; error?: string }>;
  testRagConnection(apiKey?: string | null): Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>;
  listRagDatasets(apiKey?: string | null): Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>;
  testKnowledgeConnection(backend: KnowledgeBackendId, override?: KnowledgeProbeOverride): Promise<KnowledgeProbeResult>;
  listKnowledgeDatasets(backend: KnowledgeBackendId, override?: KnowledgeProbeOverride): Promise<KnowledgeProbeResult>;
  setSessionKnowledge(sessionId: string, selection: KnowledgeSelection): Promise<{ ok: boolean; error?: string }>;
  openRagDocument(args: { backend?: KnowledgeBackendId; datasetId: string; documentId: string; fileName?: string }): Promise<{ ok: boolean; path?: string; error?: string }>;
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
