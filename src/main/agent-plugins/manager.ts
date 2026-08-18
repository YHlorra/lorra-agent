import { Result as ResultRuntime } from 'better-result';
import type {
  CreateAgentPluginResult,
  InstallAgentPluginResult,
  McpServerConfig,
  McpServerInfo,
  PluginsXray,
} from '../../shared/plugins-api';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { resolveWorkspacePath } from '../skills/skill-manager';
import { readSettings, writeSettings } from '../workspace/settings';
import { createAgentPluginScaffold, installAgentPluginFromFolder } from './install';
import { type AgentPluginsLoad, loadAgentPlugins } from './loader';
import { agentPluginsRoot } from './root';

/**
 * agent-plugins 编排（plan S2/S4）——插件/MCP xray 组装 + 启停/增删 MCP。
 * 全部 Result<T, LorraError>；异常经 Result.tryPromise 收敛，不手写 try/catch。
 */

/** 插件根（settings.agentPluginRoot 或默认）。 */
function pluginRootOf(settings: { agentPluginRoot?: string }): string {
  return settings.agentPluginRoot && settings.agentPluginRoot.trim() !== ''
    ? settings.agentPluginRoot
    : agentPluginsRoot();
}

/** 加载插件 + 用户 MCP，组装 PluginsXray（插件态/MCP 态共用）。 */
export async function getPluginsXray(wsPath?: string): Promise<Result<PluginsXray>> {
  return ResultRuntime.tryPromise({
    try: async () => {
      const wsRes = await resolveWorkspacePath(wsPath);
      if (wsRes.isErr()) throw new Error(wsRes.error.message);
      const settings = await readSettings();
      const root = pluginRootOf(settings);
      const disabled = new Set(settings.disabledPlugins ?? []);
      const loaded = await loadAgentPlugins({ root, disabled });
      if (loaded.isErr()) throw new Error(loaded.error.message);
      const { plugins, mcps } = loaded.value as AgentPluginsLoad;
      // 用户自配 MCP：origin=user，enabled 取 config.enabled（缺省 true）。
      const userMcps: McpServerInfo[] = Object.entries(settings.mcpServers ?? {}).map(
        ([id, cfg]) => ({
          id,
          type: cfg.type,
          origin: 'user',
          pluginName: '',
          config: cfg,
          enabled: cfg.enabled !== false,
          health: cfg.type === 'sse' ? 'unsupported' : 'unverified',
          issues:
            cfg.type === 'sse'
              ? [{ code: 'mcp-unsupported', message: 'sse 为旧版 MCP，lorra 首期不支持执行' }]
              : [],
        }),
      );
      return {
        plugins,
        mcps: [...mcps, ...userMcps],
        root,
        workspacePath: wsRes.value,
      } as PluginsXray;
    },
    catch: (cause) => toLorraError(cause, 'plugins-xray-failed'),
  });
}

/** 按名启停整个 agent-plugin（写 disabledPlugins）。 */
export async function setPluginEnabled(name: string, enabled: boolean): Promise<Result<void>> {
  if (typeof name !== 'string' || name.trim() === '') {
    return err({ code: 'invalid-plugin-name', message: '插件名称无效' });
  }
  const settings = await readSettings();
  const list = new Set(settings.disabledPlugins ?? []);
  if (enabled) list.delete(name);
  else list.add(name);
  await writeSettings({ ...settings, disabledPlugins: [...list] });
  return ok(undefined);
}

/** 新增用户自配 MCP 服务器（校验后写 settings.mcpServers）。 */
export async function addMcpServer(id: string, config: McpServerConfig): Promise<Result<void>> {
  if (typeof id !== 'string' || id.trim() === '') {
    return err({ code: 'invalid-mcp-id', message: 'MCP 服务器名称无效' });
  }
  const settings = await readSettings();
  const servers = settings.mcpServers ?? {};
  if (servers[id] !== undefined) {
    return err({ code: 'mcp-exists', message: '同名 MCP 服务器已存在' });
  }
  await writeSettings({
    ...settings,
    mcpServers: { ...servers, [id]: { ...config, enabled: config.enabled !== false } },
  });
  return ok(undefined);
}

/** 移除用户自配 MCP 服务器。 */
export async function removeMcpServer(id: string): Promise<Result<void>> {
  if (typeof id !== 'string' || id.trim() === '') {
    return err({ code: 'invalid-mcp-id', message: 'MCP 服务器名称无效' });
  }
  const settings = await readSettings();
  const servers = { ...(settings.mcpServers ?? {}) };
  delete servers[id];
  await writeSettings({ ...settings, mcpServers: servers });
  return ok(undefined);
}

/** 启停用户自配 MCP 服务器（写 config.enabled）。 */
export async function setMcpEnabled(id: string, enabled: boolean): Promise<Result<void>> {
  if (typeof id !== 'string' || id.trim() === '') {
    return err({ code: 'invalid-mcp-id', message: 'MCP 服务器名称无效' });
  }
  const settings = await readSettings();
  const servers = { ...(settings.mcpServers ?? {}) };
  if (servers[id] === undefined) {
    return err({ code: 'mcp-not-found', message: 'MCP 服务器不存在' });
  }
  servers[id] = { ...servers[id], enabled };

  await writeSettings({ ...settings, mcpServers: servers });
  return ok(undefined);
}

/** 导入 agent-plugin（本地文件夹 / 手工目录路径）。 */
export async function importAgentPlugin(source: string): Promise<Result<InstallAgentPluginResult>> {
  const settings = await readSettings();
  const root = pluginRootOf(settings);
  return installAgentPluginFromFolder(source, { root });
}

/** 新建 agent-plugin 脚手架。 */
export async function createAgentPlugin(name: string): Promise<Result<CreateAgentPluginResult>> {
  const settings = await readSettings();
  const root = pluginRootOf(settings);
  return createAgentPluginScaffold(name, { root });
}
