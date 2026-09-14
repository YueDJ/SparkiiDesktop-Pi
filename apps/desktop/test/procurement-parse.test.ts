import { describe, it, expect } from 'vitest';
import { parseCsv, parsePlanTable, parseFactTable } from '../agents/procurement-review/engine/parse.js';

describe('parse tables', () => {
  it('parseCsv reads a header row', () => {
    const rows = parseCsv('物资编码,物资名称,申请数量\nRM-001,烟煤,2800\n');
    expect(rows[0]).toMatchObject({ 物资编码: 'RM-001', 物资名称: '烟煤', 申请数量: '2800' });
  });

  it('maps Chinese headers to plan lines', () => {
    const lines = parsePlanTable([
      { 物资编码: 'RM-001', 物资名称: '烟煤', 申请数量: '2800', 单位: '吨', 预估单价: '920' },
    ], 'upload');
    expect(lines[0]).toMatchObject({ code: 'RM-001', name: '烟煤', qty: 2800, unitPrice: 920 });
  });

  it('maps stock / usage / deals / transit aliases', () => {
    expect(parseFactTable('stock', [{ 物资编码: 'RM-001', 库存数量: '4200', 快照日期: '2026-09-13' }], 'pull')[0]).toMatchObject({
      code: 'RM-001', qty: 4200, asOf: '2026-09-13', source: 'pull',
    });
    expect(parseFactTable('usage', [{ 编码: 'RM-001', 领用数量: '2100', 天数: '90' }], 'upload')[0].qty).toBe(2100);
    expect(parseFactTable('deals', [{ 物资编码: 'RM-001', 单价: '780', 成交日期: '2026-01-01' }], 'upload')[0].unitPrice).toBe(780);
    expect(parseFactTable('transit', [{ 物资编码: 'SP-203', 数量: '36', 单号: 'PO-883', 日期: '2026-09-02' }], 'upload')[0].ref).toBe('PO-883');
  });

  it('skips fact rows with no code', () => {
    expect(parseFactTable('stock', [{ 物资名称: '烟煤', 库存数量: '1', 快照日期: '2026-09-13' }], 'upload')).toEqual([]);
  });
});
