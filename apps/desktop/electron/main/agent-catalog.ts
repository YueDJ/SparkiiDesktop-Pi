export type AgentKnowledge = {
  enabled: boolean;
  picker: 'hidden' | 'session';
  backend: 'bm25' | 'sparkiirag';
};

export interface AgentCatalogEntry {
  id: string;
  name: string;
  displayName?: string;
  sortOrder?: number;
  surfaceType?: string;
  capabilities?: { tools?: string[] };
  knowledge?: AgentKnowledge;
}

export interface AgentListItem {
  id: string;
  name: string;
  surfaceType?: string;
  knowledge?: AgentKnowledge;
  /** 由 `manifest.capabilities.tools` 是否含任一 `ontology.*` 派生。 */
  declaresOntologyTools: boolean;
}

/** 声明了任一 `ontology.*` 工具（`manifest.capabilities.tools` 含 `ontology.` 前缀）。 */
export function declaresOntologyTools(tools?: string[]): boolean {
  return Array.isArray(tools) && tools.some((tool) => tool.startsWith('ontology.'));
}

export function sortAgents(entries: AgentCatalogEntry[]): AgentListItem[] {
  return [...entries]
    .sort((a, b) => {
      const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return ao - bo || a.id.localeCompare(b.id);
    })
    .map((entry) => ({
      id: entry.id,
      name: entry.displayName ?? entry.name,
      surfaceType: entry.surfaceType,
      declaresOntologyTools: declaresOntologyTools(entry.capabilities?.tools),
      ...(entry.knowledge ? { knowledge: entry.knowledge } : {}),
    }));
}
