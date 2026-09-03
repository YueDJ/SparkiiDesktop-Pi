export interface RiskFinding {
  id: string;
  title: string;
  level: 'high' | 'mid' | 'low';
  clause?: string;
  position?: string;
  ruleId?: string;
  ruleText?: string;
  reason?: string;
  advice?: string;
}

export interface ReportBlock { heading: string; body: string; }
export interface FormattedReport { title: string; blocks: ReportBlock[]; riskTable?: unknown; }

export interface ClauseGroup {
  category: string;
  clauses: { text: string; position: string }[];
}

export interface StepItem { id: string; label: string; state: 'done' | 'active' | 'pending'; }
export interface WorkflowLike { status: string; step?: string; }

const STEPS: Array<Pick<StepItem, 'id' | 'label'>> = [
  { id: 'upload', label: '上传' },
  { id: 'load', label: '解析' },
  { id: 'search', label: '检索' },
  { id: 'extract', label: '抽取' },
  { id: 'compare', label: '比对' },
  { id: 'report', label: '报告' },
];

const LEVEL_RE = /(高|high)/i;
const MID_RE = /(中|mid)/i;
const LOW_RE = /(低|low)/i;
const LEVEL_ONLY_RE = /^(高|中|低)(风险)?$|^(high|medium|low)$/i;

function pickTitle(row: unknown): string | undefined {
  if (typeof row === 'string') return row.trim() || undefined;
  if (!row || typeof row !== 'object') return undefined;
  for (const v of Object.values(row as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t && !/^\d+$/.test(t) && !LEVEL_ONLY_RE.test(t)) return t;
  }
  return undefined;
}

function pickLevel(row: unknown): RiskFinding['level'] {
  if (typeof row === 'string') {
    if (LEVEL_RE.test(row)) return 'high';
    if (LOW_RE.test(row)) return 'low';
    if (MID_RE.test(row)) return 'mid';
    return 'mid';
  }
  if (!row || typeof row !== 'object') return 'mid';
  for (const v of Object.values(row as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (LEVEL_RE.test(v)) return 'high';
    if (MID_RE.test(v)) return 'mid';
    if (LOW_RE.test(v)) return 'low';
  }
  return 'mid';
}

function pickAdvice(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (/建议|advice|suggestion/i.test(k) && typeof v === 'string') return v.trim();
  }
  return undefined;
}

function structuredLevel(row: Record<string, unknown>): RiskFinding['level'] | undefined {
  const l = typeof row.level === 'string' ? row.level.trim() : '';
  if (/^高|^high/i.test(l)) return 'high';
  if (/^中|^mid/i.test(l)) return 'mid';
  if (/^低|^low/i.test(l)) return 'low';
  return undefined;
}

function extractJsonValue(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }
  const brace = trimmed.indexOf('{');
  const bracket = trimmed.indexOf('[');
  const start = brace < 0 ? bracket : bracket < 0 ? brace : Math.min(brace, bracket);
  if (start < 0) return undefined;
  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

export function parseRiskFindings(rows: unknown): RiskFinding[] {
  if (!rows) return [];
  if (typeof rows === 'string') {
    const extracted = extractJsonValue(rows);
    return extracted !== undefined ? parseRiskFindings(extracted) : [];
  }
  if (!Array.isArray(rows) && typeof rows === 'object') {
    const rec = rows as Record<string, unknown>;
    if (Array.isArray(rec.riskFindings)) return parseRiskFindings(rec.riskFindings);
    if (Array.isArray(rec.comparisons)) return parseRiskFindings(rec.comparisons);
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((row, i) => {
    const rec = row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
    const stLevel = rec ? structuredLevel(rec) : undefined;
    const title = (typeof rec?.title === 'string' && rec.title.trim() ? rec.title.trim() : undefined)
      ?? (typeof rec?.条款 === 'string' && rec.条款.trim() ? rec.条款.trim() : undefined)
      ?? pickTitle(row) ?? `发现 #${i + 1}`;
    const level = stLevel ?? pickLevel(row);
    const advice = (typeof rec?.advice === 'string' && rec.advice.trim() ? rec.advice.trim() : undefined)
      ?? (typeof rec?.建议 === 'string' && rec.建议.trim() ? rec.建议.trim() : undefined)
      ?? pickAdvice(row);
    const id = (typeof rec?.id === 'string' && rec.id.trim() ? rec.id.trim() : undefined) ?? `f${i}`;
    return {
      id,
      title,
      level,
      clause: typeof rec?.clause === 'string' ? rec.clause : undefined,
      position: typeof rec?.position === 'string' ? rec.position : undefined,
      ruleId: typeof rec?.ruleId === 'string' ? rec.ruleId : undefined,
      ruleText: typeof rec?.ruleText === 'string' ? rec.ruleText : undefined,
      reason: typeof rec?.reason === 'string' ? rec.reason : undefined,
      advice,
    };
  });
}

export interface ExportTable {
  headers: string[];
  rows: string[][];
}

export interface ExportSection {
  heading: string;
  body?: string;
  table?: ExportTable;
}

export function captureReportHtml(root: Element): string {
  const clone = root.cloneNode(true) as HTMLElement;
  const walk = (live: Element, copy: Element) => {
    const cs = getComputedStyle(live);
    copy.setAttribute('style', [
      `color:${cs.color}`,
      `background-color:${cs.backgroundColor}`,
      `font-weight:${cs.fontWeight}`,
      `font-size:${cs.fontSize}`,
      `text-align:${cs.textAlign}`,
    ].join(';'));
    [...live.children].forEach((child, index) => {
      if (copy.children[index]) walk(child, copy.children[index]);
    });
  };
  walk(root, clone);
  return clone.outerHTML;
}

export function reportExportPath(workspacePath: string | null | undefined, title: string): string | undefined {
  const workspace = workspacePath?.trim();
  if (!workspace) return undefined;
  const safe = (title.replace(/[<>:"/\\|?*]/g, '').trim() || '合同审核报告');
  return `${workspace.replace(/[/\\]+$/, '')}/${safe}.docx`;
}

export function buildExportDocument(input: {
  title?: string;
  sections?: Array<{ heading: string; body: string }>;
  findings: RiskFinding[];
  reviewed?: Record<string, string>;
  workspacePath?: string | null;
}): { title: string; format: 'docx'; sections: ExportSection[]; path?: string } {
  const title = input.title?.trim() || '合同审核报告';
  const reviewed = input.reviewed ?? {};
  const reviewLabel = (id: string) => {
    const state = reviewed[id];
    if (state === 'confirmed') return '已确认';
    if (state === 'ignored') return '已忽略';
    if (state === 'escalated') return '已升级';
    return '未处理';
  };
  const high = input.findings.filter((f) => f.level === 'high');
  const mid = input.findings.filter((f) => f.level === 'mid');
  const low = input.findings.filter((f) => f.level === 'low');
  const groups: Array<{ heading: string; items: RiskFinding[] }> = [
    { heading: '高风险', items: high },
    { heading: '中风险', items: mid },
    { heading: '低风险', items: low },
  ];
  const findingRow = (f: RiskFinding): string[] => [
    [f.title, [f.clause, f.reason].filter(Boolean).join(' · ')].filter(Boolean).join('\n'),
    f.position ?? '—',
    reviewLabel(f.id),
  ];
  const narrative = (input.sections ?? []).filter((s) => s.heading && s.heading !== '风险明细');
  const sections: ExportSection[] = [
    {
      heading: '风险摘要',
      table: { headers: ['高风险', '中风险', '低风险'], rows: [[String(high.length), String(mid.length), String(low.length)]] },
    },
    ...narrative,
    ...groups.filter((g) => g.items.length).map((g) => ({
      heading: `${g.heading}（${g.items.length}）`,
      table: { headers: ['风险项', '位置', '复核'], rows: g.items.map(findingRow) },
    })),
  ];
  const workspace = input.workspacePath?.trim();
  const safe = title.replace(/[<>:"/\\|?*]/g, '').trim() || '合同审核报告';
  const path = workspace
    ? `${workspace.replace(/[/\\]+$/, '')}/${safe}.docx`
    : undefined;
  return { title, format: 'docx', sections, ...(path ? { path } : {}) };
}

export function formatReport(report: unknown): FormattedReport | null {
  if (!report) return null;
  if (typeof report === 'string') {
    const extracted = extractJsonValue(report);
    if (extracted !== undefined && typeof extracted === 'object') return formatReport(extracted);
    return { title: '报告', blocks: [{ heading: '', body: report }] };
  }
  if (typeof report === 'object') {
    const r = report as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title : '报告';
    const sections = Array.isArray(r.sections) ? r.sections : [];
    const blocks = sections.map((s) => ({
      heading: String((s as Record<string, unknown>)?.heading ?? ''),
      body: String((s as Record<string, unknown>)?.body ?? ''),
    }));
    const riskTable = r.riskTable && typeof r.riskTable === 'object' ? r.riskTable : undefined;
    if (blocks.length === 0) return { title, blocks: [{ heading: '', body: JSON.stringify(report, null, 2) }], riskTable };
    return { title, blocks, riskTable };
  }
  return null;
}

export function parseClauseGroups(rows: unknown): ClauseGroup[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const rec = (row ?? {}) as Record<string, unknown>;
    const category = typeof rec.category === 'string' ? rec.category : typeof rec.分类 === 'string' ? rec.分类 : '';
    const clauses = Array.isArray(rec.clauses)
      ? rec.clauses.map((c) => {
        const cr = (c ?? {}) as Record<string, unknown>;
        return {
          text: typeof cr.text === 'string' ? cr.text : typeof cr.条 === 'string' ? cr.条 : '',
          position: typeof cr.position === 'string' ? cr.position : typeof cr.位置 === 'string' ? cr.位置 : '',
        };
      })
      : [];
    return { category, clauses };
  });
}

export function stepStatus(workflow: WorkflowLike): StepItem[] {
  if (workflow.status === 'done') return STEPS.map((s) => ({ ...s, state: 'done' as const }));
  if (workflow.status !== 'running') return STEPS.map((s, i) => ({ ...s, state: i === 0 ? 'active' : 'pending' }));
  const idx = STEPS.findIndex((s) => s.id === workflow.step);
  return STEPS.map((s, i) => ({
    ...s,
    state: idx < 0 ? 'active' : i < idx ? 'done' : i === idx ? 'active' : 'pending',
  }));
}
