export type RpcCommand =
  | { type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'new_session' }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'switch_session'; sessionPath: string };

export interface RpcResponse { id?: string; type: 'response'; command: string; success: boolean; data?: unknown }

export type NormalizedEvent =
  | { type: 'message'; role: 'user' | 'assistant'; delta?: string; text?: string }
  | { type: 'tool_call'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolName: string; result: unknown }
  | { type: 'agent_start' } | { type: 'agent_end' }
  | { type: 'compaction_start' } | { type: 'compaction_end' }
  | { type: 'unknown'; raw: unknown };
