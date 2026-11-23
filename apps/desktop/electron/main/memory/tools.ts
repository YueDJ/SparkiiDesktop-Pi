import type { ActionExecutionResult, ProposalDecision, RuntimeActionRequest } from '@sparkii/agent-host';
import type { ProposalRequest } from '@sparkii/approval';
import type { MemoryService } from './service.js';

export interface MemoryToolDeps {
  service: MemoryService;
  audit: {
    append(event: {
      actor: string; action: string; resource: string; decision: string; ruleId: string;
      payloadSummary: string; sessionId: string;
    }): Promise<unknown>;
  };
  actor: string;
  sessionId: string;
  profileId: string;
  workspacePath?: string;
  workspaceKind?: 'auto' | 'user';
  propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
}

const ALLOW = { decision: 'allow' as const, ruleId: 'memory.trusted-branch', reason: '平台可信分支' };
const DENY = { decision: 'deny' as const, ruleId: 'memory.trusted-branch', reason: '记忆工具不可用' };

function result(request: RuntimeActionRequest, value: unknown): ActionExecutionResult {
  return { requestId: request.requestId, status: 'executed', decision: ALLOW, result: value };
}

/**
 * 平台可信分支：不经过 action-normalizer、不扩展 CapabilityKind、不登记
 * DEFAULT_TOOL_DESCRIPTORS。dataDir 本就是 closure 保护根，平台是唯一可信写者。
 */
export async function handleMemoryToolAction(request: RuntimeActionRequest, deps: MemoryToolDeps): Promise<ActionExecutionResult> {
  const args = request.args ?? {};
  const settings = deps.service.getSettings();
  if (!settings.enabled) {
    return { requestId: request.requestId, status: 'denied', decision: DENY, error: { code: 'MEMORY_DISABLED', message: '记忆功能已关闭' } };
  }
  const record = async (action: string, decision: string, summary: string) => {
    await deps.audit.append({
      actor: deps.actor,
      action,
      resource: 'memory',
      decision,
      ruleId: 'memory.trusted-branch',
      payloadSummary: summary.slice(0, 512),
      sessionId: deps.sessionId,
    }).catch(() => {});
  };

  try {
    if (request.toolName === 'memory_remember') {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('请说明要记住的内容');
      const scope = String(args.scope ?? 'user');
      const entry = deps.service.addMemory({
        scope,
        text,
        pinned: args.pinned === true,
        sessionId: deps.sessionId,
        excerpt: text,
        workspacePath: deps.workspacePath,
        workspaceKind: deps.workspaceKind,
      });
      await record('memory.remember', 'allowed', `${scope}:${entry.id}`);
      return result(request, { ok: true, id: entry.id, text: entry.text });
    }
    if (request.toolName === 'memory_forget') {
      const query = String(args.query ?? args.text ?? '').trim();
      if (!query) throw new Error('请说明要忘记的内容');
      const hits = deps.service.store.search(query, { limit: 5, includeHistory: true })
        .filter((hit) => hit.kind === 'memory');
      if (!hits.length) return result(request, { ok: false, reason: '未找到匹配的记忆' });
      const lines = hits.map((h) => `- ${h.id} ${h.text}`);
      const decision = await deps.propose({
        requestId: request.requestId,
        toolName: 'memory_forget',
        targetSystem: 'memory',
        summary: `删除 ${hits.length} 条记忆：${query}`,
        preview: { kind: 'text', lines },
        payload: { ids: hits.map((h) => h.id), query, sessionId: deps.sessionId },
        risk: 'high-risk',
        executionMode: 'caller',
      });
      if (!decision.approved) {
        await record('memory.forget', 'denied', query);
        return result(request, { ok: false, reason: '用户未批准删除' });
      }
      let removed = 0;
      for (const hit of hits) {
        if (!deps.service.store.rowFor(hit.id)) continue;
        deps.service.deleteMemory(hit.id, { mode: 'normal' });
        removed += 1;
      }
      await record('memory.forget', 'allowed', `${query}:${removed}`);
      return result(request, { ok: true, removed });
    }
    if (request.toolName === 'memory_search') {
      const hits = deps.service.searchMemory(String(args.query ?? ''), {
        limit: Math.min(20, Math.max(1, Number(args.limit ?? 10))),
        includeHistory: args.includeHistory === true,
      });
      await record('memory.search', 'allowed', String(args.query ?? ''));
      return result(request, { ok: true, hits });
    }
    return {
      requestId: request.requestId,
      status: 'denied',
      decision: DENY,
      error: { code: 'UNKNOWN_MEMORY_TOOL', message: `未知记忆工具：${request.toolName}` },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await record(request.toolName, 'failed', message);
    return {
      requestId: request.requestId,
      status: 'failed',
      decision: DENY,
      error: { code: 'MEMORY_TOOL_FAILED', message },
    };
  }
}
