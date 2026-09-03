import type { HtmlNode } from './html.js';
import { parseHtml, styleColor, styleFontWeight } from './html.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TEXT = '1E293B';
const SECONDARY = '475569';
const MUTED = '94A3B8';
const BORDER = 'EAF0F6';
const WASH = 'F5F7FB';
const RISK = 'B91C1C';
const WARN = 'C2410C';
const OK = '15803D';

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

export async function documentFromHtml(title: string, html: string): Promise<Uint8Array> {
  const root = parseHtml(html);
  const titled = Boolean(findClass(root, 'contract-report-mock-title'));
  const body = [
    ...(titled ? [] : [paragraph(run(title || '合同审核报告', { bold: true, color: TEXT, size: 36 }), pStyle('ReportTitle'))]),
    ...blocksFrom(root),
    sectionProps(),
  ].join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
  return zipStore({
    '[Content_Types].xml': contentTypes(),
    '_rels/.rels': packageRels(),
    'word/_rels/document.xml.rels': documentRels(),
    'word/styles.xml': stylesXml(),
    'word/numbering.xml': numberingXml(),
    'word/document.xml': documentXml,
  });
}

function blocksFrom(node: HtmlNode): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    if (typeof child === 'string') {
      const text = child.trim();
      if (text) out.push(paragraph(run(text, { color: SECONDARY, size: 22 }), pStyle('ReportBody')));
      continue;
    }
    out.push(...blockOf(child));
  }
  return out;
}

function blockOf(node: HtmlNode): string[] {
  if (hasClass(node, 'contract-report-status')) return [];
  if (hasClass(node, 'contract-report-mock-title')) {
    return [paragraph(inlines(node, true, { color: TEXT, size: 36 }), pStyle('ReportTitle'))];
  }
  if (hasClass(node, 'contract-report-mock-meta')) {
    const source = textOf(node);
    if (!source || /deepseek/i.test(source)) return [];
    return [paragraph(inlines(node, false, { color: MUTED, size: 22 }), pStyle('ReportMeta'))];
  }
  if (hasClass(node, 'contract-report-summary')) return [summaryTable(node)];
  switch (node.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
      return [paragraph(inlines(node, true, { color: TEXT, size: 28 }), pStyle('ReportHeading'))];
    case 'p':
      return [paragraph(inlines(node, false, { color: SECONDARY, size: 24 }), pStyle('ReportBody'))];
    case 'ul':
    case 'ol':
      return node.children
        .filter((c): c is HtmlNode => typeof c !== 'string' && c.tag === 'li')
        .map((li) => paragraph(inlines(li, false, { color: SECONDARY, size: 24 }), listProps()));
    case 'table':
      return [tableOf(node)];
    case 'thead':
    case 'tbody':
    case 'tr':
      return [];
    default:
      return blocksFrom(node);
  }
}

function summaryTable(node: HtmlNode): string {
  const items = collectClass(node, 'contract-report-summary-item');
  const cells = items.map((item) => {
    const num = findClass(item, 'num');
    const label = findClass(item, 'label');
    const labelText = label ? textOf(label) : '';
    const color = (num && styleColor(num.attrs.style)) || colorForLabel(labelText);
    return tableCell([
      paragraph(run(num ? textOf(num) : '0', { bold: true, color, size: 40 })),
      paragraph(run(labelText, { color: MUTED, size: 20 })),
    ], { fill: WASH, borders: 'box' });
  });
  if (!cells.length) return '';
  return tableWrap(`<w:tr>${cells.join('')}</w:tr>`, items.length);
}

function tableOf(table: HtmlNode): string {
  const rows = tableRows(table);
  const last = Math.max(0, (rows[0]?.cells.length ?? 1) - 1);
  const xml = rows.map((row) => {
    const cells = row.cells.map((cell, index) => tableCell(
      cellParagraphs(cell.node, cell.header, index === last),
      { fill: cell.header ? WASH : undefined, borders: 'bottom', header: cell.header },
    ));
    return `<w:tr>${cells.join('')}</w:tr>`;
  }).join('');
  return tableWrap(xml, rows[0]?.cells.length ?? 1);
}

function cellParagraphs(node: HtmlNode, header: boolean, lastCol: boolean): string[] {
  const blocks = node.children.filter((c): c is HtmlNode => typeof c !== 'string' && (c.tag === 'div' || c.tag === 'p'));
  const align = lastCol ? `<w:jc w:val="right"/>` : '';
  if (blocks.length) {
    return blocks.map((block) => {
      const meta = hasClass(block, 'contract-risk-meta');
      return paragraph(
        inlines(block, header && !meta, { color: meta ? MUTED : header ? MUTED : TEXT, size: meta ? 20 : 22 }),
        `<w:pPr>${align}<w:spacing w:after="40"/></w:pPr>`,
      );
    });
  }
  return [paragraph(
    inlines(node, header, { color: header ? MUTED : TEXT, size: 22 }),
    `<w:pPr>${align}</w:pPr>`,
  )];
}

function tableRows(table: HtmlNode): Array<{ cells: Array<{ node: HtmlNode; header: boolean }> }> {
  const rows: Array<{ cells: Array<{ node: HtmlNode; header: boolean }> }> = [];
  const walk = (node: HtmlNode, header: boolean) => {
    if (node.tag === 'thead') {
      node.children.forEach((c) => { if (typeof c !== 'string') walk(c, true); });
      return;
    }
    if (node.tag === 'tbody') {
      node.children.forEach((c) => { if (typeof c !== 'string') walk(c, false); });
      return;
    }
    if (node.tag === 'tr') {
      rows.push({
        cells: node.children
          .filter((c): c is HtmlNode => typeof c !== 'string' && (c.tag === 'th' || c.tag === 'td'))
          .map((c) => ({ node: c, header: header || c.tag === 'th' })),
      });
      return;
    }
    node.children.forEach((c) => { if (typeof c !== 'string') walk(c, header); });
  };
  walk(table, false);
  return rows;
}

function inlines(node: HtmlNode, forceBold = false, opts: { color?: string; size?: number } = {}): string {
  const color = styleColor(node.attrs.style) ?? opts.color;
  const bold = forceBold || styleFontWeight(node.attrs.style) || node.tag === 'strong' || node.tag === 'b';
  const italic = node.tag === 'em' || node.tag === 'i';
  const size = opts.size;
  const parts: string[] = [];
  for (const child of node.children) {
    if (typeof child === 'string') {
      const text = child.replace(/\s+/g, ' ');
      if (text) parts.push(run(text, { bold, italic, color, size }));
      continue;
    }
    if (child.tag === 'br') {
      parts.push('<w:r><w:br/></w:r>');
      continue;
    }
    if (['ul', 'ol', 'table'].includes(child.tag)) continue;
    parts.push(inlines(child, bold, { color, size }));
  }
  return parts.length ? parts.join('') : run(textOf(node) || ' ', { bold, italic, color, size });
}

function paragraph(runs: string, pPr = ''): string {
  return `<w:p>${pPr}${runs}</w:p>`;
}

function pStyle(id: string): string {
  return `<w:pPr><w:pStyle w:val="${id}"/></w:pPr>`;
}

function listProps(): string {
  return `<w:pPr><w:pStyle w:val="ReportBody"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`
    + `<w:spacing w:after="60" w:line="360" w:lineRule="auto"/><w:ind w:left="420"/></w:pPr>`;
}

function run(text: string, opts: { bold?: boolean; italic?: boolean; color?: string; size?: number } = {}): string {
  const rPr = [
    `<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="微软雅黑"/>`,
    opts.bold ? '<w:b/>' : '',
    opts.italic ? '<w:i/>' : '',
    opts.color ? `<w:color w:val="${esc(opts.color)}"/>` : '',
    opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '',
  ].join('');
  return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function tableWrap(rows: string, columns: number): string {
  const width = Math.floor(5000 / Math.max(columns, 1));
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borderSet('bottom')}</w:tblBorders>`
    + `<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>`
    + `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

function tableCell(paragraphs: string[], opts: { fill?: string; borders?: 'bottom' | 'box'; header?: boolean } = {}): string {
  const fill = opts.fill ? `<w:shd w:val="clear" w:fill="${opts.fill}"/>` : '';
  const borders = opts.borders === 'box'
    ? `<w:tcBorders>${borderSet('box')}</w:tcBorders>`
    : `<w:tcBorders>${borderSet('bottom')}</w:tcBorders>`;
  return `<w:tc><w:tcPr>${fill}${borders}</w:tcPr>${paragraphs.join('')}</w:tc>`;
}

function borderSet(kind: 'bottom' | 'box'): string {
  const line = (edge: string) => kind === 'bottom' && edge !== 'bottom'
    ? `<w:${edge} w:val="nil"/>`
    : `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="${BORDER}"/>`;
  return ['top', 'left', 'bottom', 'right'].map(line).join('');
}

function sectionProps(): string {
  return `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
    + `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720"/>`
    + `</w:sectPr>`;
}

function textOf(node: HtmlNode): string {
  return node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('').replace(/\s+/g, ' ').trim();
}

function hasClass(node: HtmlNode, name: string): boolean {
  return (node.attrs.class ?? '').split(/\s+/).includes(name);
}

function findClass(node: HtmlNode, name: string): HtmlNode | undefined {
  if (hasClass(node, name)) return node;
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    const hit = findClass(child, name);
    if (hit) return hit;
  }
  return undefined;
}

function collectClass(node: HtmlNode, name: string): HtmlNode[] {
  const out = hasClass(node, name) ? [node] : [];
  for (const child of node.children) {
    if (typeof child !== 'string') out.push(...collectClass(child, name));
  }
  return out;
}

function colorForLabel(label: string): string {
  if (label.includes('高')) return RISK;
  if (label.includes('中')) return WARN;
  if (label.includes('低')) return OK;
  return TEXT;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stylesXml(): string {
  const fonts = `<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="微软雅黑" w:cs="Microsoft YaHei"/>`;
  const style = (id: string, name: string, extra: string) => (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:styles xmlns:w="${W}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="${SECONDARY}"/></w:rPr></w:rPrDefault>`
    + `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + style('ReportTitle', 'Report Title', `<w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr>${fonts}<w:b/><w:sz w:val="36"/><w:color w:val="${TEXT}"/></w:rPr>`)
    + style('ReportMeta', 'Report Meta', `<w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr>${fonts}<w:sz w:val="22"/><w:color w:val="${MUTED}"/></w:rPr>`)
    + style('ReportHeading', 'Report Heading', `<w:pPr><w:spacing w:before="200" w:after="60"/></w:pPr><w:rPr>${fonts}<w:b/><w:sz w:val="28"/><w:color w:val="${TEXT}"/></w:rPr>`)
    + style('ReportBody', 'Report Body', `<w:pPr><w:spacing w:after="80" w:line="360" w:lineRule="auto"/></w:pPr><w:rPr>${fonts}<w:sz w:val="24"/><w:color w:val="${SECONDARY}"/></w:rPr>`)
    + `</w:styles>`;
}

function contentTypes(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
    + `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`
    + `</Types>`;
}

function packageRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>`
    + `</Relationships>`;
}

function documentRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>`
    + `</Relationships>`;
}

function numberingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:numbering xmlns:w="${W}">`
    + `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="420" w:hanging="210"/></w:pPr></w:lvl></w:abstractNum>`
    + `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`
    + `</w:numbering>`;
}

function zipStore(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = encoder.encode(text);
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, data,
    );
    const central = concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    );
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const central = concat(...centrals);
  const eocd = concat(
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(central.length), u32(offset), u16(0),
  );
  return concat(...locals, central, eocd);
}

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
