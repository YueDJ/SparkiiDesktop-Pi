import { joinLines, subtractMonths } from './join.js';
import type {
  Conflict,
  EvaluationSnapshot,
  JoinedLine,
  PackInput,
  RuleHit,
} from './types.js';

function daysBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function stockAsOf(facts: PackInput['facts'], code: string): string | null {
  const upload = facts.stock.find((s) => s.code === code && s.source === 'upload');
  if (upload) return upload.asOf;
  const pull = facts.stock.find((s) => s.code === code && s.source === 'pull');
  return pull?.asOf ?? null;
}

function lastDealDate(facts: PackInput['facts'], code: string, priceCutoff: string): string | null {
  const dates = facts.deals
    .filter((d) => d.code === code && d.at >= priceCutoff)
    .map((d) => d.at)
    .sort();
  return dates.length > 0 ? dates[dates.length - 1]! : null;
}

function buildStockCite(
  line: JoinedLine,
  conflicts: Conflict[],
  stockDate: string | null,
  stale: boolean,
): string {
  const parts: string[] = [];
  const conflict = conflicts.find((c) => c.code === line.code && c.field === 'stock');
  if (conflict) {
    parts.push(`拉取库存 ${conflict.pull} · 上传库存 ${conflict.upload}`);
  } else if (line.stockQty !== null) {
    parts.push(`库存 ${line.stockQty}`);
  }
  if (stockDate) parts.push(`截至 ${stockDate}`);
  if (stale) parts.push('库存可能不是当天');
  return parts.join(' · ');
}

function evaluateQtyRules(
  line: JoinedLine,
  input: PackInput,
  conflicts: Conflict[],
  hits: RuleHit[],
): void {
  if (!line.qtyOpen || line.stockQty === null || line.usageQty === null || line.qty === null) return;

  const { usageDays } = input.ranges;
  const { coverMonthsHigh, stockDaysMin, coverMonthsLow } = input.rules.qty;
  const monthlyUsage = line.usageQty / (usageDays / 30);
  const coverMonths = (line.stockQty + line.qty) / monthlyUsage;
  const stockDays = line.stockQty / (line.usageQty / usageDays);

  const refDate = line.requestDate ?? input.asOf;
  const asOf = stockAsOf(input.facts, line.code!);
  const stale = asOf !== null && daysBetween(asOf, refDate) > input.rules.stockStaleDays;

  const baseMetrics = { coverMonths, stockDays };

  if (coverMonths > coverMonthsHigh && stockDays > stockDaysMin) {
    hits.push({
      id: `h-qty-${line.code}-over`,
      rowId: line.id,
      dim: 'qty',
      level: 'high',
      ruleId: 'qty.over-cover',
      metrics: baseMetrics,
      cite: { label: buildStockCite(line, conflicts, asOf, stale), refs: [] },
    });
  } else if (coverMonths < coverMonthsLow) {
    hits.push({
      id: `h-qty-${line.code}-under`,
      rowId: line.id,
      dim: 'qty',
      level: 'mid',
      ruleId: 'qty.under-cover',
      metrics: baseMetrics,
      cite: { label: buildStockCite(line, conflicts, asOf, stale), refs: [] },
    });
  }
}

function evaluatePriceRules(
  line: JoinedLine,
  input: PackInput,
  hits: RuleHit[],
): void {
  if (!line.priceOpen || line.unitPrice === null || line.medianPrice === null) return;

  const { highPct, midPct, minSamples, staleMonths } = input.rules.price;
  const priceCutoff = subtractMonths(input.asOf, input.ranges.priceMonths);
  const lastDeal = lastDealDate(input.facts, line.code!, priceCutoff);
  const refDate = line.requestDate ?? input.asOf;
  const staleCutoff = subtractMonths(refDate, staleMonths);
  const stale = lastDeal !== null && lastDeal < staleCutoff;

  if (line.dealCount < minSamples) return;

  const dev = (line.unitPrice - line.medianPrice) / line.medianPrice;
  const absDev = Math.abs(dev);
  const baseMetrics = { dev, median: line.medianPrice, dealCount: line.dealCount };
  const citeLabel = `中位价 ${line.medianPrice} · 本次 ${line.unitPrice} · ${line.dealCount} 笔成交`;

  if (absDev > highPct && !stale) {
    hits.push({
      id: `h-price-${line.code}-high`,
      rowId: line.id,
      dim: 'price',
      level: 'high',
      ruleId: 'price.dev-high',
      metrics: baseMetrics,
      cite: { label: citeLabel, refs: [] },
    });
  } else if (absDev > midPct && absDev <= highPct) {
    hits.push({
      id: `h-price-${line.code}-mid`,
      rowId: line.id,
      dim: 'price',
      level: 'mid',
      ruleId: 'price.dev-mid',
      metrics: baseMetrics,
      cite: { label: citeLabel, refs: [] },
    });
  }
}

function evaluateTimeRules(
  line: JoinedLine,
  input: PackInput,
  hits: RuleHit[],
): void {
  if (!line.timeOpen || line.transitQty === null || line.transitQty <= 0) return;
  if (line.qty === null || line.qty <= 0) return;

  const windowTransit = input.facts.transit.filter((t) => {
    if (t.code !== line.code) return false;
    const cutoff = new Date(input.asOf);
    cutoff.setDate(cutoff.getDate() - input.ranges.transitDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return !t.at || t.at >= cutoffStr;
  });

  const hasUnknownDate = windowTransit.some((t) => !t.at);
  const citeParts = [`在途 ${line.transitQty}`];
  if (line.transitRef) citeParts.push(`单号 ${line.transitRef}`);
  if (hasUnknownDate) citeParts.push('日期未知');

  hits.push({
    id: `h-time-${line.code}-dup`,
    rowId: line.id,
    dim: 'time',
    level: 'mid',
    ruleId: 'time.duplicate',
    metrics: { transitQty: line.transitQty },
    cite: { label: citeParts.join(' · '), refs: [] },
  });
}

function evaluateCompletenessRules(
  line: JoinedLine,
  hits: RuleHit[],
): void {
  if (line.code === null) {
    hits.push({
      id: `h-comp-${line.id}-code`,
      rowId: line.id,
      dim: 'completeness',
      level: 'mid',
      ruleId: 'completeness.missing-code',
      metrics: {},
      cite: { label: '缺少物资编码', refs: [] },
    });
  }
  if (line.qty === null) {
    hits.push({
      id: `h-comp-${line.id}-qty`,
      rowId: line.id,
      dim: 'completeness',
      level: 'mid',
      ruleId: 'completeness.missing-qty',
      metrics: {},
      cite: { label: '缺少数量', refs: [] },
    });
  }
  if (line.unit === null) {
    hits.push({
      id: `h-comp-${line.id}-unit`,
      rowId: line.id,
      dim: 'completeness',
      level: 'mid',
      ruleId: 'completeness.missing-unit',
      metrics: {},
      cite: { label: '缺少单位', refs: [] },
    });
  }
}

function buildQuery(pack: PackInput): string {
  if (pack.policyKb === null) return '';
  const parts: string[] = [];
  for (const row of pack.plan) {
    const amount = row.qty !== null && row.unitPrice !== null ? row.qty * row.unitPrice : null;
    const bits = [row.name, amount !== null ? String(amount) : null, row.applicant].filter(Boolean);
    if (bits.length > 0) parts.push(bits.join(' '));
  }
  return parts.join('；').slice(0, 200);
}

export function evaluatePack(input: PackInput): EvaluationSnapshot {
  const { lines, conflicts: joinConflicts } = joinLines(input);
  const hits: RuleHit[] = [];

  for (const line of lines) {
    evaluateCompletenessRules(line, hits);
    evaluateQtyRules(line, input, joinConflicts, hits);
    evaluatePriceRules(line, input, hits);
    evaluateTimeRules(line, input, hits);
  }

  const closed = {
    qty: !lines.some((l) => l.qtyOpen),
    price: !lines.some((l) => l.priceOpen),
    time: !lines.some((l) => l.timeOpen),
    compliance: input.policyKb === null,
  };

  let banner: string | undefined;
  if (closed.qty && closed.price && closed.time) {
    hits.push({
      id: 'h-comp-dims-closed',
      rowId: '',
      dim: 'completeness',
      level: 'mid',
      ruleId: 'completeness.dims-closed',
      metrics: {},
      cite: { label: '量价时三维均未评估', refs: [] },
    });
    banner = '量价时均未评估，仅做完整性检查';
  }

  return {
    lines,
    hits,
    closed,
    conflicts: joinConflicts,
    banner,
  };
}

export function prepareWorkflowInput(pack: PackInput, documents: string[]): {
  documents: string[];
  evaluation: EvaluationSnapshot;
  query: string;
} {
  return {
    documents,
    evaluation: evaluatePack(pack),
    query: buildQuery(pack),
  };
}
