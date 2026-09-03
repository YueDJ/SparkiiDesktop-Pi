import { writeFile } from 'node:fs/promises';
import type { Connector, ToolHandler } from '../types.js';

export interface ReportTable {
  headers: string[];
  rows: string[][];
}

export interface ReportSection {
  heading: string;
  body?: string;
  table?: ReportTable;
}

export interface ReportInput {
  title: string;
  sections?: ReportSection[];
  format: 'docx';
}

export async function buildReportDocx(input: ReportInput): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, TextRun } = await import('docx');
  const cell = (text: string, header = false) => new TableCell({
    children: text.split('\n').map((line) => new Paragraph({
      children: [new TextRun({ text: line, bold: header })],
    })),
  });
  const tableOf = (table: ReportTable) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: table.headers.map((h) => cell(h, true)) }),
      ...table.rows.map((row) => new TableRow({ children: row.map((value) => cell(value)) })),
    ],
  });
  const children = [
    new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
    ...(input.sections ?? []).flatMap((s) => [
      new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1 }),
      ...(s.body ? [new Paragraph({ text: s.body })] : []),
      ...(s.table ? [tableOf(s.table)] : []),
    ]),
  ];
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

const handler: ToolHandler = async (args) => {
  try {
    const payload = args as { path?: string; content?: string };
    const outPath = String(payload.path);
    if (typeof payload.content === 'string' && payload.content.trim()) {
      const buf = Buffer.from(payload.content, 'base64');
      await writeFile(outPath, buf);
      return { ok: true, data: { path: outPath, size: buf.length } };
    }
    const buf = await buildReportDocx(args as unknown as ReportInput);
    await writeFile(outPath, buf);
    return { ok: true, data: { path: outPath, size: buf.length } };
  } catch (e) {
    return { ok: false, error: { code: 'CONNECTOR_IO', message: (e as Error).message } };
  }
};

export const reportConnector: Connector = {
  id: 'report',
  tools: [{
    name: 'report.export',
    description: '把审核结论导出为 Word 文档（写操作，需审批）。',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              body: { type: 'string' },
              table: { type: 'object' },
            },
          },
        },
        format: { type: 'string', enum: ['docx'] },
      },
      required: ['title', 'format'],
    },
    sideEffect: 'write',
    handler,
  }],
  async init() {},
};
