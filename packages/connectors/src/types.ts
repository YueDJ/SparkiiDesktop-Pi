export type SideEffect = 'read' | 'write' | 'high-risk';
export type JSONSchema = Record<string, unknown>;
export interface ToolContext { profileId: string; sessionId: string; actor: string; requestId: string; }
export interface ToolResult { ok: boolean; data?: unknown; error?: { code: string; message: string }; }
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
export interface ToolDef { name: string; description: string; params: JSONSchema; sideEffect: SideEffect; handler: ToolHandler; }
export interface Connector { id: string; tools: ToolDef[]; init(cfg: unknown): Promise<void>; }
export class ConnectorError extends Error {
  constructor(public code: 'CONNECTOR_UNSUPPORTED' | 'CONNECTOR_IO' | 'CONNECTOR_DENIED', message: string) {
    super(message);
  }
}
