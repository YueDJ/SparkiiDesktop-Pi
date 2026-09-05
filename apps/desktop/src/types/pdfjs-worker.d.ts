/**
 * pdfjs 只发布了 worker 的运行时文件，没有类型。我们只是为了在本线程里注册 worker 而 import 它，
 * 不用它的导出，所以声明成空模块就够了。
 */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs';
