import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOWNLOAD_UNREACHABLE,
  defaultModulesCatalogPath,
  downloadDocumentParseModule,
  sha256Hex,
} from '../electron/main/document-parse-modules.js';

let dirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.length = 0;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function listen(payload: Buffer): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(payload);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}/seal.bin`;
}

describe('document-parse modules', () => {
  it('rejects huggingface hosts', async () => {
    const modelsDir = await mkdtemp(join(tmpdir(), 'dp-mod-'));
    dirs.push(modelsDir);
    await expect(downloadDocumentParseModule('seal', {
      modelsDir,
      catalog: [{
        id: 'seal',
        label: '印章',
        url: 'https://huggingface.co/PaddlePaddle/foo/resolve/main/x.tar',
        sha256: sha256Hex(Buffer.from('fixture')),
        minBytes: 1,
        target: 'optional/seal',
      }],
    })).rejects.toThrow(DOWNLOAD_UNREACHABLE);

    await expect(downloadDocumentParseModule('seal', {
      modelsDir,
      extraAllowedHosts: ['hf.co'],
      catalog: [{
        id: 'seal',
        label: '印章',
        url: 'https://hf.co/models/foo',
        sha256: sha256Hex(Buffer.from('fixture')),
        minBytes: 1,
        target: 'optional/seal',
      }],
    })).rejects.toThrow(DOWNLOAD_UNREACHABLE);
  });

  it('accepts a local fixture: verifies hash and minBytes then copies to optional/<id>/', async () => {
    const modelsDir = await mkdtemp(join(tmpdir(), 'dp-mod-'));
    dirs.push(modelsDir);
    const payload = randomBytes(16);
    const sha256 = sha256Hex(payload);
    const url = await listen(payload);
    const result = await downloadDocumentParseModule('seal', {
      modelsDir,
      extraAllowedHosts: ['127.0.0.1'],
      catalog: [{
        id: 'seal',
        label: '印章',
        url,
        sha256,
        minBytes: 16,
        target: 'optional/seal',
      }],
    });
    expect(result.ok).toBe(true);
    const dest = join(modelsDir, 'optional', 'seal');
    expect(existsSync(dest)).toBe(true);
    const files = await readdir(dest);
    expect(files.length).toBeGreaterThan(0);
    const copied = await readFile(join(dest, files[0]));
    expect(copied.equals(payload)).toBe(true);
  });

  it('rejects a wrong hash and does not install', async () => {
    const modelsDir = await mkdtemp(join(tmpdir(), 'dp-mod-'));
    dirs.push(modelsDir);
    const payload = randomBytes(16);
    const url = await listen(payload);
    await expect(downloadDocumentParseModule('seal', {
      modelsDir,
      extraAllowedHosts: ['127.0.0.1'],
      catalog: [{
        id: 'seal',
        label: '印章',
        url,
        sha256: sha256Hex(Buffer.from('not-the-payload')),
        minBytes: 1,
        target: 'optional/seal',
      }],
    })).rejects.toThrow(/sha256 mismatch/);
    expect(existsSync(join(modelsDir, 'optional', 'seal'))).toBe(false);
  });

  it('production modules.json has no REPLACE and omits placeholder hashes', async () => {
    const raw = await readFile(defaultModulesCatalogPath(), 'utf8');
    expect(raw).not.toMatch(/REPLACE/);
    const parsed = JSON.parse(raw) as { modules: Array<Record<string, unknown>> };
    expect(JSON.stringify(parsed)).not.toMatch(/REPLACE/);
    for (const mod of parsed.modules) {
      expect(mod).not.toHaveProperty('url');
      expect(mod).not.toHaveProperty('sha256');
    }
    expect(parsed.modules.map((m) => m.id)).toEqual(['baseline', 'seal', 'formula', 'chart']);
  });
});
