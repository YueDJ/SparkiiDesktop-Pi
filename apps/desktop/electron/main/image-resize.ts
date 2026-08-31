import { nativeImage } from 'electron';

export interface ResizedImage {
  buffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  resized: boolean;
}

export interface ResizeOptions {
  maxDimension?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_DIMENSION = 2000;
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;
const JPEG_QUALITY = 80;

export function computeResizeTarget(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null;
  if (width <= maxDimension && height <= maxDimension) return null;
  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function resizeImageForAttachment(
  path: string,
  mimeType: string,
  options: ResizeOptions = {},
): ResizedImage | null {
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return null;

  const { width, height } = image.getSize();
  const isPng = (mimeType || '').toLowerCase() === 'image/png';
  let resized = false;
  let out = image;
  const target = computeResizeTarget(width, height, maxDimension);
  if (target) {
    out = image.resize({ width: target.width, height: target.height, quality: 'good' });
    resized = true;
  }

  if (isPng) {
    return { buffer: out.toPNG(), mimeType: 'image/png', resized };
  }

  let buffer = out.toJPEG(JPEG_QUALITY);
  for (const quality of [70, 55, 40]) {
    if (buffer.length <= maxBytes) break;
    buffer = out.toJPEG(quality);
    resized = true;
  }
  return { buffer, mimeType: 'image/jpeg', resized };
}
