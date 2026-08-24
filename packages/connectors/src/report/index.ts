import { writeFile } from 'node:fs/promises';
import type { Connector, ToolHandler } from '../types.js';

export interface ReportInput { title: string; sections: Array<{ heading: string; body: string }>; format: 'docx' }

export async function buildReportDocx(input: ReportInput): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel } = await import('docx');
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
        ...input.sections.flatMap((s) => [
          new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: s.body }),
        ]),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

const handler: ToolHandler = async (args) => {
  try {
    const buf = await buildReportDocx(args as unknown as ReportInput);
    const outPath = String((args as { path?: string }).path);
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
        sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } } } },
        format: { type: 'string', enum: ['docx'] },
      },
      required: ['title', 'sections', 'format'],
    },
    sideEffect: 'write',
    handler,
  }],
  async init() {},
};
