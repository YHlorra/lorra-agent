import { ipcMain } from 'electron';
import type {
  CreateAgentPluginResult,
  InstallAgentPluginResult,
  McpServerConfig,
  McpTestResult,
  PluginsXray,
} from '../../shared/plugins-api';
import type { SerializedResult } from '../../shared/result';
import { err, ok, toSerialized } from '../../shared/result';
import {
  addMcpServer,
  createAgentPlugin,
  getPluginsXray,
  importAgentPlugin,
  removeMcpServer,
  setMcpEnabled,
  setPluginEnabled,
} from '../agent-plugins/manager';
import { loadPlugins } from '../ofk/plugin-loader';

/**
 * 数据源插件清单 IPC(step 6):设置页「数据源」组自定义插件只读清单。
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

/**
 * agent-plugins 管理 IPC（plan S2/S4）：xray / setPluginEnabled / mcpAdd /
 * mcpRemove / mcpSetEnabled。通道名取 shared/plugins-api PLUGINS_IPC 单一事实源，
 * Result + toSerialized 收口，错误文案 PM 语域（同 skills-ipc 纪律）。
 * install / importFolder / create / mcpTest 在 S4 install/create + S3 mcp 运行时落地。
 */
export function registerAgentPluginsIpc(): void {
  ipcMain.handle(
    'lorra.plugins.xray',
    async (_e, args?: { wsPath?: unknown }): Promise<SerializedResult<PluginsXray>> => {
      const ws =
        typeof args?.wsPath === 'string' && args.wsPath.trim() !== '' ? args.wsPath : undefined;
      return toSerialized(await getPluginsXray(ws));
    },
  );

  ipcMain.handle(
    'lorra.plugins.setPluginEnabled',
    async (_e, args?: { name?: unknown; enabled?: unknown }): Promise<SerializedResult<void>> => {
      if (typeof args?.name !== 'string' || args.name.trim() === '') {
        return toSerialized(err({ code: 'invalid-plugin-name', message: '插件名称无效' }));
      }
      if (typeof args?.enabled !== 'boolean') {
        return toSerialized(err({ code: 'invalid-enabled', message: '启用状态无效' }));
      }
      return toSerialized(await setPluginEnabled(args.name, args.enabled));
    },
  );

  ipcMain.handle(
    'lorra.plugins.mcpAdd',
    async (_e, args?: { id?: unknown; config?: unknown }): Promise<SerializedResult<void>> => {
      if (typeof args?.id !== 'string' || args.id.trim() === '') {
        return toSerialized(err({ code: 'invalid-mcp-id', message: 'MCP 服务器名称无效' }));
      }
      if (typeof args?.config !== 'object' || args.config === null) {
        return toSerialized(err({ code: 'invalid-mcp-config', message: 'MCP 服务器配置无效' }));
      }
      return toSerialized(await addMcpServer(args.id, args.config as McpServerConfig));
    },
  );

  ipcMain.handle(
    'lorra.plugins.mcpRemove',
    async (_e, args?: { id?: unknown }): Promise<SerializedResult<void>> => {
      if (typeof args?.id !== 'string' || args.id.trim() === '') {
        return toSerialized(err({ code: 'invalid-mcp-id', message: 'MCP 服务器名称无效' }));
      }
      return toSerialized(await removeMcpServer(args.id));
    },
  );

  ipcMain.handle(
    'lorra.plugins.mcpSetEnabled',
    async (_e, args?: { id?: unknown; enabled?: unknown }): Promise<SerializedResult<void>> => {
      if (typeof args?.id !== 'string' || args.id.trim() === '') {
        return toSerialized(err({ code: 'invalid-mcp-id', message: 'MCP 服务器名称无效' }));
      }
      if (typeof args?.enabled !== 'boolean') {
        return toSerialized(err({ code: 'invalid-enabled', message: '启用状态无效' }));
      }
      return toSerialized(await setMcpEnabled(args.id, args.enabled));
    },
  );

  ipcMain.handle(
    'lorra.plugins.importFolder',
    async (
      _e,
      args?: { source?: unknown },
    ): Promise<SerializedResult<InstallAgentPluginResult>> => {
      if (typeof args?.source !== 'string' || args.source.trim() === '') {
        return toSerialized(
          err({ code: 'invalid-plugin-source', message: '请选择有效的插件目录' }),
        );
      }
      return toSerialized(await importAgentPlugin(args.source));
    },
  );

  ipcMain.handle(
    'lorra.plugins.create',
    async (_e, args?: { name?: unknown }): Promise<SerializedResult<CreateAgentPluginResult>> => {
      if (typeof args?.name !== 'string' || args.name.trim() === '') {
        return toSerialized(err({ code: 'invalid-plugin-name', message: '插件名称无效' }));
      }
      return toSerialized(await createAgentPlugin(args.name.trim()));
    },
  );

  // mcpTest：S3 MCP 运行时接入后改为真实 initialize+ping；先占位。
  ipcMain.handle('lorra.plugins.mcpTest', async (): Promise<SerializedResult<McpTestResult>> => {
    return toSerialized(ok({ id: '', ok: false, error: 'MCP 运行时尚未接入（预览态）' }));
  });
}
