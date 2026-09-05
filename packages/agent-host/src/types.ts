export interface SessionSaddle {
  tools: string[];
  skillsDir?: string;
  cwd?: string;
  systemPrompt?: string;
  workspaceRoot?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

export interface PiProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyAuth: boolean;
  oauthAuth: boolean;
}

export interface ImageContent {
  type: 'image';
  mimeType: string;
  data: string;
}

export type RpcCommand =
  | { type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp'; images?: ImageContent[] }
  | { type: 'steer'; message: string; images?: ImageContent[] }
  | { type: 'follow_up'; message: string; images?: ImageContent[] }
  | { type: 'clear_queue' }
  | { type: 'set_steering_mode'; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
  | { type: 'abort' }
  | { type: 'new_session' }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'get_session_entries' }
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
  | { type: 'set_thinking_level'; level: string }
  | { type: 'get_thinking_level' }
  | { type: 'list_thinking_levels' }
  | { type: 'append_workflow_entry'; customType: string; data: unknown }
  | { type: 'list_providers' };

export interface RpcResponse { id?: string; type: 'response'; command: string; success: boolean; data?: unknown; error?: string }

export type NormalizedEvent = { type: string; [key: string]: unknown };
