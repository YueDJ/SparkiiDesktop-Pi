import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { isPathInside } from './workspace.js';
import type { ChatAttachment } from '../preload/api-types.js';

export const ATTACHMENTS_DIR = '.sparkii-attachments';

export interface StagedAttachment {
  ref: string;
  absolutePath: string;
}

function splitName(name: string): { stem: string; ext: string } {
  const ext = extname(name);
  return { stem: name.slice(0, name.length - ext.length), ext };
}

function resolveUniqueName(dir: string, name: string): string {
  const { stem, ext } = splitName(name);
  let candidate = name;
  for (let i = 1; existsSync(join(dir, candidate)); i += 1) {
    candidate = `${stem}-${i}${ext}`;
  }
  return candidate;
}

export async function stageAttachments(
  workspacePath: string,
  attachments: ChatAttachment[],
): Promise<StagedAttachment[]> {
  if (attachments.length === 0) return [];
  await mkdir(workspacePath, { recursive: true });
  const dir = join(workspacePath, ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });

  const out: StagedAttachment[] = [];
  for (const att of attachments) {
    const inside = att.path
      && isPathInside(workspacePath, att.path)
      && existsSync(att.path);
    if (inside) {
      out.push({
        ref: relative(workspacePath, att.path).replaceAll('\\', '/'),
        absolutePath: att.path,
      });
      continue;
    }
    const finalName = resolveUniqueName(dir, att.name);
    const finalPath = join(dir, finalName);
    await copyFile(att.path, finalPath);
    out.push({
      ref: relative(workspacePath, finalPath).replaceAll('\\', '/'),
      absolutePath: finalPath,
    });
  }
  return out;
}

export function buildAttachmentPrompt(text: string, refs: StagedAttachment[]): string {
  if (refs.length === 0) return text;
  const list = refs.map((r) => `- ${r.ref}`).join('\n');
  return [
    '以下是本条消息附带的文件，已放置到会话工作区（相对工作区路径）：',
    list,
    '',
    '请使用 read 工具读取需要的文本或代码内容；图片会作为图像输入；PDF、Word 等二进制文档请用 bash 配合本机可用工具解析。',
    '',
    text,
  ].join('\n');
}
