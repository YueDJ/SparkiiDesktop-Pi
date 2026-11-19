/**
 * P7 — generic SVG → PNG render capability (platform, NO business specifics).
 *
 * Renders an SVG string to PNG using a hidden, offscreen Electron BrowserWindow
 * (Chromium is already bundled — no extra dependency, no network, no version
 * drift). Optionally embeds a draw.io source XML into the PNG's `tEXt` chunk so
 * the exported image stays editable (draw.io "include a copy of my diagram").
 *
 * The caller (IPC layer) is responsible for Workspace Admission + audit on the
 * destination path; this service only does deterministic rendering + encoding.
 */
import { deflateSync } from 'node:zlib';

export interface RenderRequest {
  svg: string;
  width?: number;
  height?: number;
  scale?: number;
  /** draw.io mxGraph source XML to embed (base64url of deflate). */
  sourceXml?: string;
}

export interface RenderResult {
  ok: boolean;
  png?: Buffer;
  error?: string;
}

/** Minimal surface of Electron BrowserWindow we depend on (injectable for tests). */
export interface OffscreenRenderer {
  renderSvg(svg: string, width: number, height: number, scale: number): Promise<Buffer>;
}

/** CRC32 for PNG chunks. */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Insert a `tEXt` chunk with keyword `mxfile` right after the IHDR chunk. */
export function embedSourceXml(png: Buffer, sourceXml: string): Buffer {
  const encoded = deflateSync(Buffer.from(sourceXml, 'utf8')).toString('base64url');
  const keyword = Buffer.from('mxfile', 'ascii');
  const value = Buffer.from(encoded, 'ascii');
  const type = Buffer.from('tEXt', 'ascii');
  const data = Buffer.concat([keyword, Buffer.from([0]), value]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const chunk = Buffer.concat([length, type, data, crc]);
  // PNG signature (8) + IHDR length(4) + IHDR type(4) + IHDR data(13) + IHDR crc(4) = 33
  const insertAt = 33;
  return Buffer.concat([png.subarray(0, insertAt), chunk, png.subarray(insertAt)]);
}

/** Parse SVG width/height (numbers only) with sane fallback. */
export function svgDimensions(svg: string): { width: number; height: number } {
  const w = /width="(\d+(?:\.\d+)?)"/.exec(svg);
  const h = /height="(\d+(?:\.\d+)?)"/.exec(svg);
  const vb = /viewBox="\d+\s+\d+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/.exec(svg);
  return {
    width: Math.min(4096, Math.max(1, Math.round(Number(w?.[1] ?? vb?.[1] ?? 800)))),
    height: Math.min(4096, Math.max(1, Math.round(Number(h?.[1] ?? vb?.[2] ?? 500)))),
  };
}

export function createRenderDiagramService(renderer: OffscreenRenderer) {
  return {
    async render(req: RenderRequest): Promise<RenderResult> {
      try {
        if (typeof req?.svg !== 'string' || !req.svg.trim()) {
          return { ok: false, error: 'svg required' };
        }
        const dims = svgDimensions(req.svg);
        const width = req.width ?? dims.width;
        const height = req.height ?? dims.height;
        const scale = req.scale ?? 2;
        let png = await renderer.renderSvg(req.svg, width, height, scale);
        if (req.sourceXml) png = embedSourceXml(png, req.sourceXml);
        return { ok: true, png };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export type RenderDiagramService = ReturnType<typeof createRenderDiagramService>;
