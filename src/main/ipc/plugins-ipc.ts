import { ipcMain } from 'electron';
import type { SerializedResult } from '../../shared/result';
import { err, ok, toSerialized } from '../../shared/result';
import { loadPlugins } from '../ofk/plugin-loader';

/**
 * 插件清单 IPC(step 6):设置页「数据源」组自定义插件只读清单。
 * loadPlugins 每次调用现加载(插件文件改动重启后生效——清单页提示)。
 */
export interface PluginListDto {
  plugins: Array<{
    name: string;
    runtime: string;
    description: string;
    status: 'ok' | 'error';
    error?: string;
  }>;
}

export function registerPluginsHandlers(): void {
  ipcMain.handle('lorra.plugins.list', async (): Promise<SerializedResult<PluginListDto>> => {
    try {
      const plugins = await loadPlugins();
      return toSerialized(
        ok({
          plugins: plugins.map((p) => ({
            name: p.name,
            runtime: p.runtime,
            description: p.description,
            status: p.status,
            ...(p.error !== undefined ? { error: p.error } : {}),
          })),
        }),
      );
    } catch (cause) {
      return toSerialized(
        err({
          code: 'plugins-list-failed',
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  });
}
