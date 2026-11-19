/**
 * Electron-backed offscreen SVG renderer for P7.
 * Uses the bundled Chromium (no extra dependency / no network). Kept in its own
 * module so the render service stays testable with an injected fake renderer.
 */
import { BrowserWindow } from 'electron';
import type { OffscreenRenderer } from './render-diagram-service.js';

export function createElectronSvgRenderer(): OffscreenRenderer {
  return {
    async renderSvg(svg: string, width: number, height: number, scale: number): Promise<Buffer> {
      const win = new BrowserWindow({
        show: false,
        width,
        height,
        webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
      });
      try {
        const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style></head><body>${svg}</body></html>`;
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        // Allow fonts/layout to settle.
        await new Promise((r) => setTimeout(r, 60));
        // Capture at the scaled pixel size by zooming the offscreen page, so
        // text stays crisp (a plain 1x→2x upscale would blur Chinese labels).
        if (scale !== 1) await win.webContents.setZoomFactor(scale);
        if (scale !== 1) await new Promise((r) => setTimeout(r, 40));
        const image = await win.webContents.capturePage({
          x: 0, y: 0, width: Math.round(width * scale), height: Math.round(height * scale),
        });
        return Buffer.from(image.toPNG());
      } finally {
        win.destroy();
      }
    },
  };
}
