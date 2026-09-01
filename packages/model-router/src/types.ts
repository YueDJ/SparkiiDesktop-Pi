export type ModelTask = 'chat' | 'extract' | 'report' | 'default' | 'coding' | 'title';
export interface ModelTarget { provider: string; modelId: string; }
export type ModelCapability = 'chat' | 'reasoning' | 'longContext' | 'vision' | 'fast' | 'toolCall' | 'thinking';
export interface ModelDescriptor {
  provider: string;
  modelId: string;
  capabilities: ModelCapability[];
  thinkingLevels?: string[];
}
export interface ModelRequirement {
  requires: string[];
  prefers?: string[];
}
