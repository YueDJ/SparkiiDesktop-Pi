import type {
  Conflict,
  FactTables,
  JoinedLine,
  PackInput,
  PlanLine,
  SourceKind,
} from './types.js';

function sumBySource<T extends { code: string; source: SourceKind }>(
  rows: T[],
  code: string,
  pick: (row: T) => number,
): { pull: number | null; upload: number | null } {
  let pull: number | null = null;
  let upload: number | null = null;
  for (const row of rows.filter((r) => r.code === code)) {
    const val = pick(row);
    if (row.source === 'pull') {
      pull = (pull ?? 0) + val;
    } else {
      upload = (upload ?? 0) + val;
    }
  }
  return { pull, upload };
}

function resolveQty(
  rows: FactTables['stock'] | FactTables['usage'],
  code: string,
  field: 'stock' | 'usage',
  conflicts: Conflict[],
): { value: number | null; pull: number | null; upload: number | null } {
  const { pull, upload } = sumBySource(rows, code, (r) => r.qty);
  if (pull !== null && upload !== null && pull !== upload) {
    conflicts.push({ code, field, pull, upload });
  }
  const value = upload ?? pull;
  return { value, pull, upload };
}

function resolveDeals(
  deals: FactTables['deals'],
  code: string,
  priceCutoff: string,
  conflicts: Conflict[],
): { medianPrice: number | null; dealCount: number } {
  const windowDeals = deals.filter((d) => d.code === code && d.at >= priceCutoff);
  const pullDeals = windowDeals.filter((d) => d.source === 'pull');
  const uploadDeals = windowDeals.filter((d) => d.source === 'upload');

  const pullMedian = median(pullDeals.map((d) => d.unitPrice));
  const uploadMedian = median(uploadDeals.map((d) => d.unitPrice));

  if (pullMedian !== null && uploadMedian !== null && pullMedian !== uploadMedian) {
    conflicts.push({ code, field: 'deal', pull: pullMedian, upload: uploadMedian });
  }

  const usedDeals = uploadDeals.length > 0 ? uploadDeals : pullDeals;
  const dealPrices = usedDeals.map((d) => d.unitPrice);

  return {
    medianPrice: median(dealPrices),
    dealCount: usedDeals.length,
  };
}

function resolveTransit(
  transit: FactTables['transit'],
  code: string,
  transitCutoff: string,
  conflicts: Conflict[],
): { value: number | null; transitRef: string | null; entries: FactTables['transit'] } {
  const windowTransit = transit.filter(
    (t) => t.code === code && (!t.at || t.at >= transitCutoff),
  );

  const { pull, upload } = sumBySource(windowTransit, code, (t) => t.qty);
  if (pull !== null && upload !== null && pull !== upload) {
    conflicts.push({ code, field: 'transit', pull, upload });
  }

  const usedEntries = upload !== null
    ? windowTransit.filter((t) => t.source === 'upload')
    : windowTransit.filter((t) => t.source === 'pull');

  return {
    value: upload ?? pull,
    transitRef: usedEntries.length > 0 ? usedEntries[0]!.ref : null,
    entries: usedEntries,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function subtractMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function joinLine(
  row: PlanLine,
  facts: FactTables,
  ranges: PackInput['ranges'],
  asOf: string,
  conflicts: Conflict[],
): JoinedLine {
  const code = row.code;
  if (!code) {
    return {
      ...row,
      stockQty: null,
      usageQty: null,
      medianPrice: null,
      dealCount: 0,
      transitQty: null,
      transitRef: null,
      qtyOpen: false,
      priceOpen: false,
      timeOpen: false,
    };
  }

  const stockResolved = resolveQty(facts.stock, code, 'stock', conflicts);
  const usageResolved = resolveQty(facts.usage, code, 'usage', conflicts);

  const priceCutoff = subtractMonths(asOf, ranges.priceMonths);
  const dealResolved = resolveDeals(facts.deals, code, priceCutoff, conflicts);

  const transitCutoff = subtractDays(asOf, ranges.transitDays);
  const transitResolved = resolveTransit(facts.transit, code, transitCutoff, conflicts);

  const hasStock = stockResolved.value !== null;
  const hasUsage = usageResolved.value !== null && usageResolved.value > 0;
  const qtyOpen = hasStock && hasUsage;
  const priceOpen = row.unitPrice !== null && dealResolved.dealCount >= 1;
  const timeOpen = transitResolved.entries.length > 0;

  return {
    ...row,
    stockQty: stockResolved.value,
    usageQty: usageResolved.value,
    medianPrice: dealResolved.medianPrice,
    dealCount: dealResolved.dealCount,
    transitQty: transitResolved.value,
    transitRef: transitResolved.transitRef,
    qtyOpen,
    priceOpen,
    timeOpen,
  };
}

export function joinLines(input: PackInput): { lines: JoinedLine[]; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const lines = input.plan.map((row) =>
    joinLine(row, input.facts, input.ranges, input.asOf, conflicts),
  );
  return { lines, conflicts };
}

export { subtractMonths, subtractDays, median, resolveQty, resolveDeals, resolveTransit, sumBySource };
