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
  knowledge?: AgentKnowledge;
}

export interface AgentListItem {
  id: string;
  name: string;
  surfaceType?: string;
  knowledge?: AgentKnowledge;
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
      ...(entry.knowledge ? { knowledge: entry.knowledge } : {}),
    }));
}
