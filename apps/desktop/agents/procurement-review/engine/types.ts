export type Dim = 'qty' | 'price' | 'time' | 'compliance' | 'completeness';
export type Level = 'high' | 'mid';
export type SourceKind = 'pull' | 'upload';
export type PolicyKb = 'default' | null;

export interface Cite {
  label: string;
  refs: Array<{ kind: string; id?: string; text?: string }>;
}

export interface PlanLine {
  id: string;
  code: string | null;
  name: string;
  qty: number | null;
  unit: string | null;
  unitPrice: number | null;
  requestDate?: string;
  applicant?: string;
}

export interface JoinedLine extends PlanLine {
  stockQty: number | null;
  usageQty: number | null;
  medianPrice: number | null;
  dealCount: number;
  transitQty: number | null;
  transitRef: string | null;
  qtyOpen: boolean;
  priceOpen: boolean;
  timeOpen: boolean;
}

export interface FactTables {
  stock: Array<{ code: string; qty: number; asOf: string; source: SourceKind }>;
  usage: Array<{ code: string; qty: number; days: number; source: SourceKind }>;
  deals: Array<{ code: string; unitPrice: number; at: string; qty?: number; vendor?: string; source: SourceKind }>;
  transit: Array<{ code: string; qty: number; ref: string; at?: string; source: SourceKind }>;
}

export interface Rules {
  qty: { coverMonthsHigh: number; stockDaysMin: number; coverMonthsLow: number };
  price: { highPct: number; midPct: number; minSamples: number; staleMonths: number };
  time: { defaultWindowDays: number };
  stockStaleDays: number;
}

export interface RuleHit {
  id: string;
  rowId: string;
  dim: Dim;
  level: Level;
  ruleId: string;
  metrics: Record<string, number | string | null>;
  cite: Cite;
}

export interface Conflict {
  code: string;
  field: 'stock' | 'usage' | 'deal' | 'transit' | 'planQty' | 'planPrice';
  pull: number | string;
  upload: number | string;
}

export interface EvaluationSnapshot {
  lines: JoinedLine[];
  hits: RuleHit[];
  closed: { qty: boolean; price: boolean; time: boolean; compliance: boolean };
  conflicts: Conflict[];
  banner?: string;
}

export interface PackInput {
  plan: PlanLine[];
  facts: FactTables;
  rules: Rules;
  policyKb: PolicyKb;
  ranges: { usageDays: 30 | 90 | 180; priceMonths: 6 | 12 | 24; transitDays: 15 | 30 | 60 };
  asOf: string;
}
