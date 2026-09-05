/**
 * pdfjs 只发布了 worker 的运行时文件，没有类型。
 * 合同预览在本线程 import worker；vite-env.d.ts 里同名 declare 对 `agents/` 下的 import 不够，tsc 仍报 TS7016。
 */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs';
