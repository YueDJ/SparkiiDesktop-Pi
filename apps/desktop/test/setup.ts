import { vi } from 'vitest';

const PromiseAny = Promise as typeof Promise & {
  try?: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown>;
};
if (typeof PromiseAny.try !== 'function') {
  PromiseAny.try = (fn, ...args) => Promise.resolve().then(() => fn(...args));
}

vi.mock('pdfjs-dist', () => ({
  getDocument: () => ({ promise: Promise.reject(new Error('pdfjs mocked in tests')) }),
  GlobalWorkerOptions: { workerSrc: '' },
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs', () => ({}));
