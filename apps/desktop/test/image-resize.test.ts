import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: vi.fn(),
  },
}));
import { nativeImage } from 'electron';
import { computeResizeTarget, resizeImageForAttachment } from '../electron/main/image-resize.js';

function fakeImage(overrides: {
  empty?: boolean;
  width?: number;
  height?: number;
  png?: Buffer;
  jpeg?: Buffer;
} = {}) {
  return {
    isEmpty: () => overrides.empty ?? false,
    getSize: () => ({ width: overrides.width ?? 100, height: overrides.height ?? 100 }),
    resize: vi.fn(() => fakeImage({ ...overrides, empty: false })),
    toPNG: () => overrides.png ?? Buffer.from('png-bytes'),
    toJPEG: (_quality: number) => overrides.jpeg ?? Buffer.from('jpeg-bytes'),
  };
}

beforeEach(() => {
  vi.mocked(nativeImage.createFromPath).mockReset();
});

describe('computeResizeTarget', () => {
  it('returns null when already within the max dimension (no upscale)', () => {
    expect(computeResizeTarget(100, 100, 2000)).toBeNull();
    expect(computeResizeTarget(2000, 2000, 2000)).toBeNull();
  });

  it('scales the long edge down to the max dimension preserving aspect ratio', () => {
    expect(computeResizeTarget(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
    expect(computeResizeTarget(2000, 4000, 2000)).toEqual({ width: 1000, height: 2000 });
  });

  it('returns null for non-positive dimensions', () => {
    expect(computeResizeTarget(0, 100, 2000)).toBeNull();
    expect(computeResizeTarget(100, 0, 2000)).toBeNull();
  });
});

describe('resizeImageForAttachment', () => {
  it('returns null when the image cannot be decoded', () => {
    vi.mocked(nativeImage.createFromPath).mockReturnValue(fakeImage({ empty: true }) as any);
    expect(resizeImageForAttachment('C:/x.png', 'image/png')).toBeNull();
  });

  it('keeps PNG as PNG without resizing when within limits', () => {
    const img = fakeImage({ width: 100, height: 100, png: Buffer.from('ok-png') });
    vi.mocked(nativeImage.createFromPath).mockReturnValue(img as any);
    const out = resizeImageForAttachment('C:/x.png', 'image/png');
    expect(out).toEqual({ buffer: Buffer.from('ok-png'), mimeType: 'image/png', resized: false });
    expect(img.resize).not.toHaveBeenCalled();
  });

  it('resizes an oversized JPEG and returns JPEG bytes', () => {
    const img = fakeImage({ width: 4000, height: 2000, jpeg: Buffer.from('ok-jpeg') });
    vi.mocked(nativeImage.createFromPath).mockReturnValue(img as any);
    const out = resizeImageForAttachment('C:/x.jpg', 'image/jpeg');
    expect(out).toEqual({ buffer: Buffer.from('ok-jpeg'), mimeType: 'image/jpeg', resized: true });
    expect(img.resize).toHaveBeenCalledWith({ width: 2000, height: 1000, quality: 'good' });
  });
});
