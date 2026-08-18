import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Result as ResultRuntime } from 'better-result';
import {
  type AgentPluginInfo,
  type AgentPluginIssue,
  type AgentPluginSkillPath,
  MCP_SCHEMA_V1_0_0,
  type McpServerConfig,
  type McpServerInfo,
} from '../../shared/plugins-api';
import type { Result } from '../../shared/result';
import { toLorraError } from '../../shared/result';
import { readAgentPluginManifest } from './manifest';
import { validateMcpServer } from './mcp-config';
import { AGENT_PLUGIN_SKIP_NAMES, agentPluginsRoot } from './root';

/**
 * agent-plugins 加载（plan S2）——扫描插件根，产出 AgentPluginInfo[] + McpServerInfo[]。
 *
 * - 每目录读 plugin.json 清单；manifest 致命 -> 该插件以 error issues 呈现，不加载 skills/mcp。
 * - skills 发现：skills/<dir>/SKILL.md 直接子目录（不递归，对齐规范 固定位置）。
 * - mcp 发现：mcp.json 的 mcpServers，逐条 validateMcpServer；失败 -> issues 记 error 跳过。
 * - 单个插件/单条 mcp 失败不影响其它（fail-open，对齐 OFK plugin-loader 纪律）。
 */

export interface AgentPluginsLoad {
  plugins: AgentPluginInfo[];
  mcps: McpServerInfo[];
}

export interface LoadAgentPluginsOpts {
  /** 测试注入：插件根（缺省 agentPluginsRoot）。 */
  root?: string;
  /** 已停用插件名集合（disabledPlugins）。 */
  disabled?: Set<string>;
}

/** 直接子目录含 SKILL.md（普通文件）即一个技能；返回绝对路径数组（不递归）。 */
function discoverSkillDirs(skillsRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const p = path.join(skillsRoot, name, 'SKILL.md');
    try {
      if (statSync(p).isFile()) out.push(path.join(skillsRoot, name));
    } catch {
      // 无 SKILL.md -> 跳过。
    }
  }
  return out;
}

interface McpJsonShape {
  $schema?: unknown;
  mcpServers?: unknown;
}

/** 读 mcp.json；返回 { servers: Record<string, McpServerConfig>, issues }。缺失/坏 -> 空。 */
function readMcp(pluginDir: string): {
  servers: Record<string, McpServerConfig>;
  issues: AgentPluginIssue[];
} {
  const issues: AgentPluginIssue[] = [];
  const p = path.join(pluginDir, 'mcp.json');
  let rawText: string;
  try {
    rawText = readFileSync(p, 'utf8');
  } catch {
    return { servers: {}, issues }; // 无 mcp.json = 合法（组件位置缺失非错误）。
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    const e = cause instanceof Error ? cause.message : String(cause);
    issues.push({ code: 'mcp-parse-failed', message: 'mcp.json 不是合法 JSON（' + e + '）' });
    return { servers: {}, issues };
  }
  const obj = parsed as McpJsonShape;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    issues.push({ code: 'mcp-invalid', message: 'mcp.json 顶层须为对象' });
    return { servers: {}, issues };
  }
  if (obj.$schema !== MCP_SCHEMA_V1_0_0) {
    issues.push({
      code: 'mcp-schema-mismatch',
      message: 'mcp.json 的 $schema 缺失或版本不符（MCP 组件失效）',
    });
    return { servers: {}, issues };
  }
  if (
    obj.mcpServers !== undefined &&
    (typeof obj.mcpServers !== 'object' || obj.mcpServers === null || Array.isArray(obj.mcpServers))
  ) {
    issues.push({ code: 'mcp-invalid', message: 'mcp.json 的 mcpServers 须为对象' });
    return { servers: {}, issues };
  }
  const servers: Record<string, McpServerConfig> = {};
  const rawServers = (obj.mcpServers ?? {}) as Record<string, unknown>;
  for (const [id, raw] of Object.entries(rawServers)) {
    const vr = validateMcpServer(id, raw);
    if (vr.isErr()) {
      issues.push({ code: vr.error.code, message: vr.error.message });
    } else {
      servers[id] = vr.value;
    }
  }
  return { servers, issues };
}

/**
 * 加载全部 agent-plugins。单个插件 manifest 致命 -> 该插件 error issues 呈现（name 回退目录名），
 * 不阻断其它插件。返回 plugins + mcps 汇总。
 */
export function loadAgentPlugins(
  opts: LoadAgentPluginsOpts = {},
): Promise<Result<AgentPluginsLoad>> {
  return ResultRuntime.tryPromise({
    try: async () => {
      const root = opts.root ?? agentPluginsRoot();
      const disabled = opts.disabled ?? new Set<string>();
      let dirs: string[];
      try {
        dirs = readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name);
      } catch {
        return { plugins: [], mcps: [] } as AgentPluginsLoad;
      }

      const plugins: AgentPluginInfo[] = [];
      const mcps: McpServerInfo[] = [];

      for (const dir of dirs) {
        if (AGENT_PLUGIN_SKIP_NAMES.has(dir)) continue;
        const dirPath = path.join(root, dir);
        const manifest = await readAgentPluginManifest(dirPath);
        if (manifest.isErr()) {
          plugins.push({
            name: dir,
            path: dirPath,
            skillCount: 0,
            mcpCount: 0,
            enabled: !disabled.has(dir),
            issues: [{ code: manifest.error.code, message: manifest.error.message }],
          });
          continue;
        }
        const m = manifest.value;
        const skillDirs = discoverSkillDirs(path.join(dirPath, 'skills'));
        const mcp = readMcp(dirPath);
        const pluginEnabled = !disabled.has(m.name);

        plugins.push({
          name: m.name,
          ...(m.version !== undefined ? { version: m.version } : {}),
          ...(m.description !== undefined ? { description: m.description } : {}),
          ...(m.author !== undefined ? { author: m.author } : {}),
          ...(m.homepage !== undefined ? { homepage: m.homepage } : {}),
          ...(m.repository !== undefined ? { repository: m.repository } : {}),
          ...(m.license !== undefined ? { license: m.license } : {}),
          ...(m.keywords !== undefined ? { keywords: m.keywords } : {}),
          path: dirPath,
          skillCount: skillDirs.length,
          mcpCount: Object.keys(mcp.servers).length,
          enabled: pluginEnabled,
          issues: [
            ...m.warnings,
            ...mcp.issues.map((i) => ({
              code: i.code,
              message: '[' + Object.keys(mcp.servers).length + ' 个已载] ' + i.message,
            })),
          ],
        });

        for (const [id, cfg] of Object.entries(mcp.servers)) {
          const health = cfg.type === 'sse' ? 'unsupported' : 'unverified';
          mcps.push({
            id,
            type: cfg.type,
            origin: 'plugin',
            pluginName: m.name,
            config: cfg,
            enabled: pluginEnabled,
            health,
            issues:
              cfg.type === 'sse'
                ? [{ code: 'mcp-unsupported', message: 'sse 为旧版 MCP，lorra 首期不支持执行' }]
                : [],
          });
        }
      }
      return { plugins, mcps } as AgentPluginsLoad;
    },
    catch: (cause) => toLorraError(cause, 'agent-plugins-load-failed'),
  });
}

/**
 * 启用的 agent-plugins 技能根清单（skills-store 第 6 源消费）。
 * 只返回 enabled 插件的 skills 直接子目录绝对路径。
 */
export async function collectAgentPluginSkillPaths(
  opts: LoadAgentPluginsOpts = {},
): Promise<AgentPluginSkillPath[]> {
  const res = await loadAgentPlugins(opts);
  if (res.isErr()) return [];
  const root = opts.root ?? agentPluginsRoot();
  const out: AgentPluginSkillPath[] = [];
  for (const p of res.value.plugins) {
    if (!p.enabled) continue;
    if (
      p.issues.some((i) =>
        ['manifest-fatal', 'manifest-read-failed', 'manifest-parse-failed'].includes(i.code),
      )
    )
      continue;
    const skillsRoot = path.join(root, p.name, 'skills');
    if (existsSync(skillsRoot)) {
      out.push({ pluginName: p.name, skillsRoot });
    }
  }
  return out;
}
