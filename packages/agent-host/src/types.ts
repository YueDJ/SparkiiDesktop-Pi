export interface SessionSaddle {
  tools: string[];
  skillsDir?: string;
  cwd?: string;
  systemPrompt?: string;
  workspaceRoot?: string;
}

export interface PiProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyAuth: boolean;
  oauthAuth: boolean;
}

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
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'configure_session'; saddle: SessionSaddle }
  | { type: 'set_session_name'; name: string }
  | { type: 'set_api_key'; provider: string; apiKey: string }
  | { type: 'remove_api_key'; provider: string }
  | { type: 'complete'; provider: string; modelId: string; text: string }
  | { type: 'list_models'; provider?: string }
  | { type: 'list_providers' };

export interface RpcResponse { id?: string; type: 'response'; command: string; success: boolean; data?: unknown; error?: string }

export type NormalizedEvent =
  | { type: 'message'; role: 'user' | 'assistant'; delta?: string; text?: string }
  | { type: 'tool_call'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolName: string; result: unknown }
  | { type: 'agent_start' } | { type: 'agent_end' }
  | { type: 'compaction_start' } | { type: 'compaction_end' }
  | { type: 'unknown'; raw: unknown };
