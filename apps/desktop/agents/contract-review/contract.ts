export interface RiskFinding {
  id: string;
  title: string;
  level: 'high' | 'mid' | 'low';
  advice?: string;
}

export interface ReportBlock { heading: string; body: string; }
export interface FormattedReport { title: string; blocks: ReportBlock[]; }

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

export function parseRiskFindings(rows: unknown): RiskFinding[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, i) => {
    const title = pickTitle(row) ?? `发现 #${i + 1}`;
    const level = pickLevel(row);
    const advice = pickAdvice(row);
    return { id: `f${i}`, title, level, advice };
  });
}

export function formatReport(report: unknown): FormattedReport | null {
  if (!report) return null;
  if (typeof report === 'string') return { title: '报告', blocks: [{ heading: '', body: report }] };
  if (typeof report === 'object') {
    const r = report as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title : '报告';
    const sections = Array.isArray(r.sections) ? r.sections : [];
    const blocks = sections.map((s) => ({
      heading: String((s as Record<string, unknown>)?.heading ?? ''),
      body: String((s as Record<string, unknown>)?.body ?? ''),
    }));
    if (blocks.length === 0) return { title, blocks: [{ heading: '', body: JSON.stringify(report, null, 2) }] };
    return { title, blocks };
  }
  return null;
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
