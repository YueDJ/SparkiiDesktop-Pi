/**
 * Diagram conversion — deterministic, renderer-safe (product §7).
 *
 * Model emits a structured graph JSON (no pixel coordinates). This module:
 *  1. validates/normalizes the graph schema;
 *  2. lays out nodes deterministically (layered TB/LR, no external layout lib);
 *  3. renders an SVG string (Chinese labels via system font);
 *  4. emits draw.io mxGraph XML (`.drawio` editable source).
 * PNG rendering + source-XML embedding is done by the generic P7 render IPC
 * in the main process (see render-diagram-service.ts) — not here.
 */
export interface GraphNode {
  id: string;
  label: string;
  group?: string;
  items?: string[];
  icon?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}
export interface DiagramSpec {
  type: 'architecture' | 'topology' | 'flowchart' | 'sequence';
  title: string;
  layout: 'TB' | 'LR';
  nodes: GraphNode[];
  edges: GraphEdge[];
  style?: { palette?: string; language?: string };
}

const PALETTE: Record<string, { fill: string; stroke: string; text: string }> = {
  blue: { fill: '#EFF6FF', stroke: '#2563EB', text: '#1E293B' },
  green: { fill: '#F0FDF4', stroke: '#15803D', text: '#1E293B' },
  orange: { fill: '#FFF7ED', stroke: '#C2410C', text: '#1E293B' },
};

export function normalizeSpec(input: unknown): DiagramSpec | null {
  const s = input as Partial<DiagramSpec>;
  if (!s || !Array.isArray(s.nodes) || !Array.isArray(s.edges)) return null;
  if (!s.nodes.length) return null;
  const nodes: GraphNode[] = s.nodes.map((n, i) => ({
    id: String(n.id ?? `n${i}`),
    label: String(n.label ?? ''),
    ...(n.group ? { group: String(n.group) } : {}),
    ...(Array.isArray(n.items) ? { items: n.items.map(String) } : {}),
    ...(n.icon ? { icon: String(n.icon) } : {}),
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = s.edges
    .filter((e) => ids.has(String(e.from)) && ids.has(String(e.to)))
    .map((e) => ({ from: String(e.from), to: String(e.to), ...(e.label ? { label: String(e.label) } : {}) }));
  const requestedPalette = s.style?.palette ?? 'blue';
  const palette = PALETTE[requestedPalette] ? requestedPalette : 'blue';
  return {
    type: (s.type && ['architecture', 'topology', 'flowchart', 'sequence'].includes(s.type) ? s.type : 'architecture') as DiagramSpec['type'],
    title: String(s.title ?? '架构图'),
    layout: s.layout === 'LR' ? 'LR' : 'TB',
    nodes,
    edges,
    style: { palette, language: s.style?.language ?? 'zh-CN' },
  };
}

interface Placed { node: GraphNode; x: number; y: number; w: number; h: number }

/** Simple layered layout: group by `group`, else single row/column, deterministic order. */
export function layout(spec: DiagramSpec): Placed[] {
  const W = 240;
  const H = spec.nodes.some((n) => n.items?.length) ? 110 : 70;
  const gap = 40;
  const groups = new Map<string, GraphNode[]>();
  for (const n of spec.nodes) {
    const g = n.group ?? '_';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(n);
  }
  const groupKeys = [...groups.keys()];
  const placed: Placed[] = [];
  groupKeys.forEach((g, gi) => {
    const list = groups.get(g)!;
    list.forEach((n, ni) => {
      const x = spec.layout === 'LR' ? 60 + gi * (W + gap) : 60 + ni * (W + gap);
      const y = spec.layout === 'LR' ? 60 + ni * (H + gap) : 80 + gi * (H + gap);
      placed.push({ node: n, x, y, w: W, h: H });
    });
  });
  return placed;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render the diagram to an SVG string (viewBox sized to content). */
export function toSvg(spec: DiagramSpec): string {
  const c = PALETTE[spec.style?.palette ?? 'blue'] ?? PALETTE.blue;
  const placed = layout(spec);
  const maxX = Math.max(...placed.map((p) => p.x + p.w), 400) + 60;
  const maxY = Math.max(...placed.map((p) => p.y + p.h), 300) + 60;
  const pos = new Map(placed.map((p) => [p.node.id, p]));
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="24" y="36" font-family="Microsoft YaHei, sans-serif" font-size="20" font-weight="bold" fill="${c.text}">${esc(spec.title)}</text>`,
    `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${c.stroke}"/></marker></defs>`,
  ];
  for (const e of spec.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h / 2;
    const x2 = b.x + b.w / 2;
    const y2 = b.y + b.h / 2;
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c.stroke}" stroke-width="2" marker-end="url(#arrow)"/>`);
    if (e.label) {
      parts.push(`<text x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2 - 6}" font-family="Microsoft YaHei, sans-serif" font-size="13" fill="#475569">${esc(e.label)}</text>`);
    }
  }
  for (const p of placed) {
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="10" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`);
    parts.push(`<text x="${p.x + p.w / 2}" y="${p.y + 30}" font-family="Microsoft YaHei, sans-serif" font-size="16" font-weight="bold" text-anchor="middle" fill="${c.text}">${esc(p.node.label)}</text>`);
    (p.node.items ?? []).slice(0, 4).forEach((item, i) => {
      parts.push(`<text x="${p.x + p.w / 2}" y="${p.y + 52 + i * 18}" font-family="Microsoft YaHei, sans-serif" font-size="12" text-anchor="middle" fill="#475569">${esc(item)}</text>`);
    });
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/** Emit draw.io mxGraph XML (editable source, `.drawio`). */
export function toDrawioXml(spec: DiagramSpec): string {
  const placed = layout(spec);
  const cells = placed.map((p, i) => {
    const value = p.node.items?.length
      ? `${esc(p.node.label)}&#10;${p.node.items.map(esc).join('&#10;')}`
      : esc(p.node.label);
    return `<mxCell id="n${i}" value="${value}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#EFF6FF;strokeColor=#2563EB;" vertex="1" parent="1"><mxGeometry x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" as="geometry"/></mxCell>`;
  });
  const edges = spec.edges.map((e, i) => {
    const idxFrom = placed.findIndex((p) => p.node.id === e.from);
    const idxTo = placed.findIndex((p) => p.node.id === e.to);
    if (idxFrom < 0 || idxTo < 0) return '';
    return `<mxCell id="e${i}" value="${esc(e.label ?? '')}" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;" edge="1" parent="1" source="n${idxFrom}" target="n${idxTo}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
  });
  return [
    `<mxfile host="Sparkii" agent="bid-writing" version="1">`,
    `<diagram id="${esc(spec.title)}" name="${esc(spec.title)}">`,
    `<mxGraphModel dx="800" dy="600" grid="0"><root>`,
    `<mxCell id="0"/><mxCell id="1" parent="0"/>`,
    ...cells,
    ...edges.filter(Boolean),
    `</root></mxGraphModel></diagram></mxfile>`,
  ].join('');
}
