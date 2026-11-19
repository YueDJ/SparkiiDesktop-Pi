import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { normalizeSpec, toSvg, toDrawioXml, layout } from '../agents/bid-writing/surface/figure-converter.js';
import {
  createRenderDiagramService,
  embedSourceXml,
  svgDimensions,
  type OffscreenRenderer,
} from '../electron/main/security/render-diagram-service.js';

const spec = normalizeSpec({
  type: 'architecture',
  title: '系统总体架构',
  layout: 'TB',
  nodes: [
    { id: 'app', label: '应用层', group: '应用层', items: ['运维门户', '移动应用'] },
    { id: 'plat', label: '平台层', group: '平台层', items: ['数据汇聚', '服务网关'] },
  ],
  edges: [{ from: 'plat', to: 'app', label: '提供服务' }],
});

describe('figure-converter (product §7)', () => {
  it('normalizes a valid spec and rejects invalid', () => {
    expect(spec).not.toBeNull();
    expect(normalizeSpec({ nodes: [] })).toBeNull();
    expect(normalizeSpec(null)).toBeNull();
  });

  it('drops edges referencing unknown nodes', () => {
    const s = normalizeSpec({ nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'ghost' }] })!;
    expect(s.edges.length).toBe(0);
  });

  it('lays out deterministic positions', () => {
    const a = layout(spec!);
    const b = layout(spec!);
    expect(a).toEqual(b);
    expect(a.length).toBe(2);
  });

  it('renders SVG with Chinese labels and no pixel coordinates from model', () => {
    const svg = toSvg(spec!);
    expect(svg).toContain('系统总体架构');
    expect(svg).toContain('应用层');
    expect(svg).toContain('提供服务');
    expect(svg).toContain('<line');
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('emits editable draw.io XML with nodes and edges', () => {
    const xml = toDrawioXml(spec!);
    expect(xml).toContain('<mxfile');
    expect(xml).toContain('应用层');
    expect(xml).toContain('edge="1"');
    expect(xml).toContain('</mxfile>');
  });
});

describe('P7 render service', () => {
  it('parses SVG dimensions', () => {
    expect(svgDimensions('<svg width="720" height="360" viewBox="0 0 720 360"></svg>')).toEqual({ width: 720, height: 360 });
    expect(svgDimensions('<svg viewBox="0 0 400 250"></svg>')).toEqual({ width: 400, height: 250 });
  });

  it('embeds draw.io source XML in PNG tEXt and round-trips it', () => {
    // Minimal PNG prefix: signature(8) + IHDR length(4) + IHDR type(4) + IHDR data(13) + IHDR crc(4) = 33 bytes.
    const png = Buffer.alloc(33);
    png.set(Buffer.from('89504e470d0a1a0a', 'hex'), 0);
    png.set(Buffer.from('IHDR', 'ascii'), 12);
    const source = '<mxfile><diagram>x</diagram></mxfile>';
    const embedded = embedSourceXml(png, source);
    // Chunk starts right after 33-byte prefix: [len:4][type:4][keyword+NUL][value][crc:4]
    const len = embedded.readUInt32BE(33);
    expect(embedded.subarray(37, 41).toString('ascii')).toBe('tEXt');
    const payloadStart = 41 + 'mxfile'.length + 1;
    const payload = embedded.subarray(payloadStart, payloadStart + len - 'mxfile'.length - 1).toString('ascii');
    const decoded = inflateSync(Buffer.from(payload, 'base64url')).toString('utf8');
    expect(decoded).toBe(source);
  });

  it('renders via injected renderer and fails closed on empty svg', async () => {
    let called = 0;
    const fake: OffscreenRenderer = {
      async renderSvg() { called++; return Buffer.from('PNGDATA'); },
    };
    const svc = createRenderDiagramService(fake);
    const ok = await svc.render({ svg: '<svg width="100" height="50"></svg>' });
    expect(ok.ok).toBe(true);
    expect(ok.png?.toString()).toBe('PNGDATA');
    expect(called).toBe(1);
    const bad = await svc.render({ svg: '   ' });
    expect(bad.ok).toBe(false);
    expect(called).toBe(1);
  });
});
