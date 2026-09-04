import type { SparkiiApi } from './types/sparkii-api.js';
declare global { interface Window { sparkii: SparkiiApi } }
declare module 'pdfjs-dist/build/pdf.worker.min.mjs';
export {};
