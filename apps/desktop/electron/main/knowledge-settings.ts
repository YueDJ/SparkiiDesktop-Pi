import { ONTO_VECTOR_SIMILARITY_WEIGHT, normalizeOntoBaseUrl } from '@sparkii/connectors';
import { loadSettings, saveSettings, type AppSettings } from './settings.js';
import {
  DEFAULT_RAG_BASE_URL,
  patchRagSettings,
  ragFromSettings,
  type AgentKnowledgeBinding,
} from './rag-settings.js';

/** 远端知识后端（`bm25` 是本地语料，不走设置块与凭据）。 */
export type KnowledgeBackendId = 'sparkiirag' | 'sparkiionto';

export const KNOWLEDGE_BACKENDS: readonly KnowledgeBackendId[] = ['sparkiirag', 'sparkiionto'];

export function isKnowledgeBackendId(value: unknown): value is KnowledgeBackendId {
  return KNOWLEDGE_BACKENDS.includes(String(value ?? '').trim() as KnowledgeBackendId);
}

export const DEFAULT_KNOWLEDGE_BASE_URL = DEFAULT_RAG_BASE_URL;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.2;

export type KnowledgeBackendSettings = {
  baseUrl: string;
  similarityThreshold: number;
  /** Onto 只接受常量（服务端忽略该字段，见 `SparkiiOntoClient`）。 */
  vectorSimilarityWeight: number;
  bindings: AgentKnowledgeBinding[];
  /** 读配置宽容：已存 URL 缺失或非法时回落默认值并置位，**不抛错**。 */
  invalidBaseUrl?: true;
};

export type KnowledgeBaseUrlCheck = { ok: true; baseUrl: string } | { ok: false; reason: string };

export type KnowledgeSettingsPartial = {
  baseUrl?: string;
  similarityThreshold?: number;
  vectorSimilarityWeight?: number;
  bindings?: AgentKnowledgeBinding[];
  /** 凭据（Onto 的 API token / RAG 的 API Key）：**不落 settings.json**，只写 Keyring。 */
  apiKey?: string;
};

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBindings(value: unknown): AgentKnowledgeBinding[] {
  if (!Array.isArray(value)) return [];
  const out: AgentKnowledgeBinding[] = [];
  for (const item of value) {
    const rec = (item ?? {}) as Record<string, unknown>;
    if (typeof rec.agentId !== 'string' || typeof rec.defaultDatasetId !== 'string') continue;
    if (!rec.agentId || !rec.defaultDatasetId) continue;
    out.push({ agentId: rec.agentId, defaultDatasetId: rec.defaultDatasetId });
  }
  return out;
}

/** 读配置宽容：缺失/空白/非法都回落默认地址，并标记 `invalidBaseUrl`。 */
function urlFlag(stored: string): { invalidBaseUrl?: true } {
  if (!stored.trim()) return { invalidBaseUrl: true };
  return normalizeOntoBaseUrl(stored).ok ? {} : { invalidBaseUrl: true };
}

/**
 * 按后端取一份"知识后端设置"（读宽容：永不抛错，非法 URL 回落默认值）。
 * `sparkiirag` 的字段完全沿用既有 `ragFromSettings`（行为不变），`sparkiionto` 读 `settings.sparkiionto`。
 */
export function knowledgeBackendSettings(
  backend: KnowledgeBackendId,
  settings: AppSettings,
): KnowledgeBackendSettings {
  if (backend === 'sparkiirag') {
    const rag = ragFromSettings(settings);
    const stored = typeof settings.rag?.baseUrl === 'string' ? settings.rag.baseUrl : '';
    return {
      baseUrl: rag.baseUrl,
      similarityThreshold: rag.similarityThreshold,
      vectorSimilarityWeight: rag.vectorSimilarityWeight,
      bindings: rag.bindings,
      ...urlFlag(stored),
    };
  }
  const onto = settings.sparkiionto ?? {};
  const stored = typeof onto.baseUrl === 'string' ? onto.baseUrl : '';
  const check = normalizeOntoBaseUrl(stored);
  return {
    baseUrl: check.ok ? check.baseUrl : DEFAULT_KNOWLEDGE_BASE_URL,
    similarityThreshold: asNumber(onto.similarityThreshold, DEFAULT_SIMILARITY_THRESHOLD),
    vectorSimilarityWeight: ONTO_VECTOR_SIMILARITY_WEIGHT,
    bindings: asBindings(onto.bindings),
    ...urlFlag(stored),
  };
}

/** 写配置严格：非空、http/https、无 userinfo/query/hash。 */
export function checkKnowledgeBaseUrl(raw: unknown): KnowledgeBaseUrlCheck {
  return normalizeOntoBaseUrl(typeof raw === 'string' ? raw : String(raw ?? ''));
}

/**
 * 写入某个后端自己的配置块（两个后端互不覆盖）。
 * `sparkiirag` 仍然走既有 `patchRagSettings`（逐字节保持既有持久化行为）。
 */
export async function patchKnowledgeSettings(
  dataDir: string,
  backend: KnowledgeBackendId,
  partial: KnowledgeSettingsPartial,
): Promise<KnowledgeBackendSettings> {
  if (backend === 'sparkiirag') {
    await patchRagSettings(dataDir, {
      baseUrl: partial.baseUrl,
      similarityThreshold: partial.similarityThreshold,
      vectorSimilarityWeight: partial.vectorSimilarityWeight,
      bindings: partial.bindings,
    });
    return knowledgeBackendSettings('sparkiirag', await loadSettings(dataDir));
  }

  const prev = await loadSettings(dataDir);
  const current = knowledgeBackendSettings('sparkiionto', prev);
  let baseUrl = current.baseUrl;
  if (typeof partial.baseUrl === 'string' && partial.baseUrl.trim()) {
    const check = checkKnowledgeBaseUrl(partial.baseUrl);
    if (!check.ok) throw new Error(`知识库地址无效：${check.reason}`);
    baseUrl = check.baseUrl;
  }
  await saveSettings(dataDir, {
    ...prev,
    sparkiionto: {
      baseUrl,
      similarityThreshold: partial.similarityThreshold ?? current.similarityThreshold,
      bindings: partial.bindings ?? current.bindings,
    },
  });
  return knowledgeBackendSettings('sparkiionto', await loadSettings(dataDir));
}
