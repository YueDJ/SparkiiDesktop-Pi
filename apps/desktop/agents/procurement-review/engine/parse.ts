import * as XLSX from 'xlsx';
import type { FactTables, PlanLine, SourceKind } from './types.js';

function normalizeKey(key: string): string {
  return key.replace(/\s/g, '').toLowerCase();
}

function findValue(row: Record<string, string>, aliases: string[]): string | undefined {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    normalized.set(normalizeKey(key), value);
  }
  for (const alias of aliases) {
    const value = normalized.get(normalizeKey(alias));
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function parseNum(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function aoaToCsv(aoa: unknown[][]): string {
  return aoa
    .map((row) =>
      row
        .map((cell) => {
          const value = cell == null ? '' : String(cell);
          if (/[",\n\r]/.test(value)) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        })
        .join(','),
    )
    .join('\n');
}

export function rowsFromWorkbook(workbook: {
  SheetNames?: string[];
  Sheets?: Record<string, XLSX.WorkSheet | undefined>;
}): Record<string, string>[] {
  const name = workbook.SheetNames?.[0];
  if (!name) return [];
  const sheet = workbook.Sheets?.[name];
  if (!sheet) return [];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (aoa.length === 0) return [];
  return parseCsv(aoaToCsv(aoa));
}

export function parseXlsxBuffer(buf: ArrayBuffer): Record<string, string>[] {
  return rowsFromWorkbook(XLSX.read(buf, { type: 'array' }));
}

export function parsePlanTable(rows: Record<string, string>[], _source: SourceKind): PlanLine[] {
  return rows.map((row, index) => {
    const code = findValue(row, ['物资编码', '编码', 'code']) ?? null;
    const name = findValue(row, ['物资名称', '名称', 'name']) ?? '';
    return {
      id: `plan-${index + 1}`,
      code,
      name,
      qty: parseNum(findValue(row, ['申请数量', '数量', 'qty'])),
      unit: findValue(row, ['单位', 'unit']) ?? null,
      unitPrice: parseNum(findValue(row, ['预估单价', '单价', 'unitPrice'])),
      requestDate: findValue(row, ['申请日期', 'requestDate']),
      applicant: findValue(row, ['申请人', 'applicant']),
    };
  });
}

export function parseFactTable<K extends keyof FactTables>(
  kind: K,
  rows: Record<string, string>[],
  source: SourceKind,
): FactTables[K] {
  const codeAliases = ['物资编码', '编码', 'code'];
  const result: unknown[] = [];

  for (const row of rows) {
    const code = findValue(row, codeAliases);
    if (!code) continue;

    switch (kind) {
      case 'stock':
        result.push({
          code,
          qty: parseNum(findValue(row, ['库存数量', 'qty'])) ?? 0,
          asOf: findValue(row, ['快照日期', 'asOf']) ?? '',
          source,
        });
        break;
      case 'usage':
        result.push({
          code,
          qty: parseNum(findValue(row, ['领用数量', 'qty'])) ?? 0,
          days: parseNum(findValue(row, ['天数', 'days'])) ?? 0,
          source,
        });
        break;
      case 'deals':
        result.push({
          code,
          unitPrice: parseNum(findValue(row, ['成交单价', '单价', 'unitPrice'])) ?? 0,
          at: findValue(row, ['成交日期', 'at']) ?? '',
          source,
        });
        break;
      case 'transit':
        result.push({
          code,
          qty: parseNum(findValue(row, ['数量', 'qty'])) ?? 0,
          ref: findValue(row, ['单号', 'ref']) ?? '',
          at: findValue(row, ['日期', 'at']),
          source,
        });
        break;
    }
  }

  return result as FactTables[K];
}
