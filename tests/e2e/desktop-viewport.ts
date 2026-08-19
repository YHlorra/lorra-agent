import type { Page } from '@playwright/test';

/**
 * CI runner 显示器把 BrowserWindow(1280×800) 钳到 1050px 断点以下 → App 进入
 * narrow 模式,侧栏/文件树不渲染,所有依赖侧栏的断言全灭(实测 E2E_DIAG
 * narrow=true)。命中时强制桌面视口;本机大屏 narrow=false 为 no-op,零成本。
 */
export async function ensureDesktopViewport(win: Page): Promise<void> {
  const narrow = await win.evaluate(() => matchMedia('(max-width: 1050px)').matches);
  if (narrow) await win.setViewportSize({ width: 1280, height: 800 });
}
