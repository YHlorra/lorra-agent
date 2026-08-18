import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import licenses from '../../shared/licenses.json';
import type { OpenSourceProject } from '../../shared/licenses-api';
import { LICENSES_CHANNEL } from '../../shared/licenses-api';
import { isExternalUrl } from '../lib/external-url';

/**
 * Window control IPC (minimize / maximize-toggle / close).
 * The titlebar buttons are renderer DOM, so they cannot call BrowserWindow
 * directly — these handlers resolve the window from the sender webContents.
 */
export function registerWindowHandlers(): void {
  function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
    return BrowserWindow.fromWebContents(event.sender);
  }

  /** 应用元信息(设置页「关于」组数据源)。 */
  ipcMain.handle('lorra.app.info', (): { version: string; name: string } => ({
    version: app.getVersion(),
    name: app.getName(),
  }));

  /** 开源项目清单(设置页「关于 → 开源项目」数据源,构建期生成只读数据)。 */
  ipcMain.handle(LICENSES_CHANNEL, (): OpenSourceProject[] => licenses);

  ipcMain.handle('lorra.window.minimize', (event) => {
    windowOf(event)?.minimize();
    return true;
  });

  ipcMain.handle('lorra.window.toggleMaximize', (event) => {
    const win = windowOf(event);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return true;
  });

  ipcMain.handle('lorra.window.close', (event) => {
    windowOf(event)?.close();
    return true;
  });

  /** 外链跳转(2026-08-17):document-viewer Ctrl+点击调用,经 shell 交给系统浏览器。
 * 协议白名单走 src/main/lib/external-url.ts 单源;此处只负责 shell 转发。 */
  ipcMain.handle('lorra.app.openExternal', (_e, url: string): boolean => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return true;
  });
}
