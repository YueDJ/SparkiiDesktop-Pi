import { vi } from 'vitest';

vi.mock('pdfjs-dist', () => ({
  getDocument: () => ({ promise: Promise.reject(new Error('pdfjs mocked in tests')) }),
  GlobalWorkerOptions: { workerSrc: '' },
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs', () => ({}));
