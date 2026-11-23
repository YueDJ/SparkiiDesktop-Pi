import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from './runtime-actions.js';

export interface MemoryToolContext {
  requestAction(request: RuntimeActionRequest): Promise<ActionExecutionResult>;
}

function definition(
  name: string,
  label: string,
  description: string,
  parameters: Record<string, unknown>,
  ctx: MemoryToolContext,
): ToolDefinition<any, any, any> {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (toolCallId: string, params: Record<string, unknown>) => {
      const result = await ctx.requestAction({
        requestId: randomUUID(),
        toolCallId,
        toolName: name,
        args: params ?? {},
      });
      if (result.status !== 'executed') {
        const reason = result.error?.message ?? result.decision.reason;
        throw new Error(`${name}未执行:${result.status}:${reason}`);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.result ?? { ok: true }) }],
        details: result.result ?? {},
      };
    },
  } as ToolDefinition<any, any, any>;
}

/**
 * 平台可信分支的工具定义。仅在用户明确说「记住/忘掉」时由鞍附加；
 * 定义与 main 侧拦截必须同一批改动，否则未知工具会清空整盘工具。
 */
export function createMemoryToolDefinitions(ctx: MemoryToolContext): ToolDefinition<any, any, any>[] {
  return [
    definition(
      'memory_remember',
      '记住',
      '仅在用户明确要求“记住这个”时使用。把用户确认的稳定偏好写入记忆，不要自行记录对话内容。',
      {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的一句话陈述' },
          scope: { type: 'string', enum: ['user', 'agent', 'project'], description: '默认 user' },
          pinned: { type: 'boolean', description: '是否置顶' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      ctx,
    ),
    definition(
      'memory_forget',
      '忘掉',
      '仅在用户明确要求“忘掉/删除记忆”时使用。会先展示将删除的内容并征求用户批准。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要忘记的内容或关键词' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      ctx,
    ),
    definition(
      'memory_search',
      '回忆',
      '只读检索已确认的记忆与会话摘要。用户要求“回忆/想起”某个项目或偏好时使用；命中会强化该记忆。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词' },
          includeHistory: { type: 'boolean', description: '是否包含历史版本' },
          limit: { type: 'number', description: '最多返回条数' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      ctx,
    ),
  ];
}
