/**
 * Workspace selection IPC handlers (Section 3.2 / 3.3 / D6).
 *
 * Renderer never sees absolute paths or `cwd` strings directly — the
 * workspace path is the only opaque value returned by `lorra.workspace.get`
 * and `lorra.workspace.pick`. The driver (Section 4) wraps this with
 * realpath + workspace-containment checks before any filesystem call.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { dialog, ipcMain } from 'electron';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';
import { readSettings, recordRecentWorkspace, writeSettings } from './settings';

interface WorkspacePickResult {
  /** Selected directory, or null if the user cancelled the dialog. */
  path: string | null;
}

interface WorkspaceGetResult {
  /** Active workspace path (first entry of recentWorkspaces). */
  path: string | null;
}

interface WorkspaceListResult {
  /** 最近工作区列表(首项为当前激活工作区)。 */
  workspaces: string[];
}

/** Minimal shape the runtime needs from us on pick/deactivate. */
export interface WorkspaceActivation {
  activate(workspacePath: string): Promise<void>;
  deactivate(): Promise<void>;
  getActivePath(): string | null;
}

export function registerWorkspaceHandlers(activation: WorkspaceActivation): void {
  ipcMain.handle('lorra.workspace.pick', async (): Promise<WorkspacePickResult> => {
    const result = await dialog.showOpenDialog({
      title: '选择工作区',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    const picked = result.filePaths[0];
    await recordRecentWorkspace(picked);
    await activation.activate(picked);
    return { path: picked };
  });

  ipcMain.handle('lorra.workspace.switch', async (): Promise<WorkspacePickResult> => {
    const result = await dialog.showOpenDialog({
      title: '切换工作区',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: activation.getActivePath() };
    }
    const picked = result.filePaths[0];
    await recordRecentWorkspace(picked);
    await activation.activate(picked);
    return { path: picked };
  });

  ipcMain.handle('lorra.workspace.get', async (): Promise<WorkspaceGetResult> => {
    const active = activation.getActivePath();
    if (active) return { path: active };
    const settings = await readSettings();
    if (settings.recentWorkspaces[0]) return { path: settings.recentWorkspaces[0] };
    // 首次启动:自动创建默认工作区 ~/.lorra/workspace 并激活,不再弹首启选择器。
    const defaultWs = path.join(lorraConfigDir(), 'workspace');
    await mkdir(defaultWs, { recursive: true });
    await recordRecentWorkspace(defaultWs);
    await activation.activate(defaultWs);
    return { path: defaultWs };
  });

  /** 按路径激活最近工作区(顶栏 tab 点击),不弹目录选择框。 */
  ipcMain.handle(
    'lorra.workspace.activate',
    async (_e, args: { path: string }): Promise<WorkspaceGetResult> => {
      const target = args.path;
      if (!target || activation.getActivePath() === target) return { path: target ?? null };
      await recordRecentWorkspace(target);
      await activation.activate(target);
      return { path: target };
    },
  );

  /** 最近工作区列表(顶栏 tab 条渲染数据源)。 */
  ipcMain.handle('lorra.workspace.list', async (): Promise<WorkspaceListResult> => {
    const settings = await readSettings();
    return { workspaces: settings.recentWorkspaces };
  });

  /**
 * 移除最近工作区记录(设置页「最近工作区」列表)。
 * 不处理「移除激活工作区」:设置页 UI 对首项(激活项)不渲染移除按钮;
 * 移除激活项属实现错误,UI 层已禁止,无需 deactivate 逻辑。
 */
  ipcMain.handle(
    'lorra.workspace.remove',
    async (_e, args: { path: string }): Promise<WorkspaceListResult> => {
      const settings = await readSettings();
      const workspaces = settings.recentWorkspaces.filter((p) => p !== args.path);
      await writeSettings({ ...settings, recentWorkspaces: workspaces });
      return { workspaces };
    },
  );
}
