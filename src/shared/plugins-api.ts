/**
 * agent-plugins 共享契约（V1）：IPC 通道名、schema/常量、跨进程类型。
 * 主进程 agent-plugins 内核与渲染端插件页的唯一事实源 —— 两侧均从本模块导入。
 *
 * 对齐 agent-plugins.org 1.0.0 规范（https://github.com/agentplugins/agent-plugins-spec）：
 * - 根清单恒为 plugin.json（必填 $schema + name，封闭 schema additionalProperties:false）。
 * - MCP 恒为独立 mcp.json（必填 $schema + mcpServers，三型 stdio/streamable-http/sse）。
 * - 技能固定位置 skills/<id>/SKILL.md（直接子目录、不递归；SKILL.md 格式委托
 * agentskills.io specification）。
 * 设计边界见文档，此处只放跨进程事实。
 */

// ---- 通道常量（agent-plugins-ipc 注册 / preload 透传）----
export const PLUGINS_IPC = Object.freeze({
  xray: 'lorra.plugins.xray',
  importFolder: 'lorra.plugins.importFolder',
  create: 'lorra.plugins.create',
  setPluginEnabled: 'lorra.plugins.setPluginEnabled',
  mcpSetEnabled: 'lorra.plugins.mcpSetEnabled',
  mcpAdd: 'lorra.plugins.mcpAdd',
  mcpRemove: 'lorra.plugins.mcpRemove',
  mcpTest: 'lorra.plugins.mcpTest',
} as const);

// ---- agent-plugins 1.0.0 常量（规范事实源）----
export const AGENT_PLUGINS_SCHEMA_V1_0_0 =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA_V1_0_0 = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const MCP_RESERVED_ENV_KEYS = ['PLUGIN_ROOT', 'PLUGIN_DATA'] as const;

// ---- 类型 ----
export type McpServerType = 'stdio' | 'streamable-http' | 'sse';

export interface McpServerConfig {
  type: McpServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 用户自配服务器的启停开关（缺省 true）；插件内置服务器启停由 disabledPlugins 整体控制。 */
  enabled?: boolean;
}

export type McpHealth = 'ok' | 'error' | 'unverified' | 'unsupported';

export interface AgentPluginIssue {
  code: string;
  message: string;
}

export interface McpServerInfo {
  id: string;
  type: McpServerType;
  origin: 'plugin' | 'user';
  pluginName: string;
  config: McpServerConfig;
  enabled: boolean;
  health: McpHealth;
  issues: AgentPluginIssue[];
}

export interface AgentPluginInfo {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  path: string;
  skillCount: number;
  mcpCount: number;
  enabled: boolean;
  issues: AgentPluginIssue[];
}

export interface PluginsXray {
  plugins: AgentPluginInfo[];
  mcps: McpServerInfo[];
  root: string;
  workspacePath: string;
}

export interface InstallAgentPluginResult {
  name: string;
  path: string;
  skillCount: number;
  mcpCount: number;
}

export interface CreateAgentPluginResult {
  name: string;
  path: string;
}

export interface McpTestResult {
  id: string;
  ok: boolean;
  toolCount?: number;
  error?: string;
}

// ---- 源发现（供 skills-store 第 6 源消费）----
export interface AgentPluginSkillPath {
  pluginName: string;
  skillsRoot: string;
}

export type AgentPluginSource = { kind: 'url'; url: string } | { kind: 'folder'; path: string };
