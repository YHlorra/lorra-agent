/**
 * pdfjs worker 加载抽象(主方案 = vite 资源 URL;后备 = 内联 worker)。
 * 独立成模块以便单测整体 mock —— vitest 不转换 ?url / ?worker 后缀,
 * 真实模块只在应用运行时加载。
 */

export async function loadPdfWorkerUrl(): Promise<string> {
  const mod = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  return mod.default;
}

export async function createPdfWorkerPort(): Promise<Worker> {
  const mod = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker');
  return new mod.default();
}
