/**
 * Persisted app-local UI state lives in `<userData>/settings.json`.
 * Never store credentials or session content here .
 *
 * Reads are synchronous and tolerant of missing/corrupt files — first launch
 * starts with an empty record. Writes are atomic via temp-file + rename so
 * a crash mid-write can never truncate the existing file.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Lang } from '../../shared/i18n-core';
import type { McpServerConfig } from '../../shared/plugins-api';

export interface AppSettings {
  /** First entry is the active workspace (Section 3 / D6). */
  recentWorkspaces: string[];
  /** 文件树是否显示隐藏项(默认 false)。 */
  showHiddenFiles?: boolean;
  /** 思考链默认折叠(设置页「默认隐藏思考链」开关,默认 false=展开)。 */
  defaultHideThinking?: boolean;
  /** 技能全局隐藏名单:从 <available_skills> 提示清单剔除的技能名(软禁用,不防读)。 */
  disabledSkills?: string[];
  /** 技能收集根(空串 = 默认 ~/.agents/skills;只影响后续收集/安装,已收集技能不迁移)。 */
  skillCollectionRoot?: string;
  /** 按工作区停用名单(/D6,恒合并):key = 工作区 realpath;值 = 该工作区停用的技能名。 */
  workspaceSkillOverrides?: Record<string, string[]>;
  /** 界面语言:'en' 显式指定,其余(含 undefined)按 zh。 */
  language?: Lang;
  /**
 * 语义清洗专用模型:每日摘要/分类编译用的模型;
 * null/缺省 = 跟随默认模型。null 显式清除(= 回默认)。
 */
  compileModel?: { providerId: string; modelId: string } | null;
  /** 数据源开关:内置适配器启用;缺省 = 全关(pi 恒开不在此列)。 */
  dataSources?: { claudeCode?: boolean; opencode?: boolean; ohMyPi?: boolean; workbuddy?: boolean };
  /** 今日页标签列表(2026-08-14):内置默认 + 用户自定义;缺省 = DEFAULT_TAGS。 */
  tags?: string[];
  /** agent-plugins 根(空串 = 默认 ~/.lorra/plugins/agent-plugins;只影响后续安装/新 collection)。 */
  agentPluginRoot?: string;
  /** 停用的 agent-plugin 名名单(按名启停，映射其 skills + mcpServers)。 */
  disabledPlugins?: string[];
  /** 用户自配 MCP 服务器(key = 服务器 id)。 */
  mcpServers?: Record<string, McpServerConfig>;
}

const EMPTY: AppSettings = {
  recentWorkspaces: [],
  showHiddenFiles: false,
  defaultHideThinking: false,
  disabledSkills: [],
  skillCollectionRoot: '',
  workspaceSkillOverrides: {},
  dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
  agentPluginRoot: '',
  disabledPlugins: [],
  mcpServers: {},
};

/** dataSources 白名单解析:逐键 === true 才保留(其余键/值丢弃)。 */
function parseDataSources(value: unknown): AppSettings['dataSources'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const out: NonNullable<AppSettings['dataSources']> = {};
  for (const key of ['claudeCode', 'opencode', 'ohMyPi', 'workbuddy'] as const) {
    if (record[key] === true) out[key] = true;
  }
  return out;
}

/** compileModel 形状守卫:providerId/modelId 均为非空串才保留。 */
function isCompileModel(value: unknown): value is { providerId: string; modelId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerId === 'string' &&
    record.providerId.length > 0 &&
    typeof record.modelId === 'string' &&
    record.modelId.length > 0
  );
}

/** tags 规范化:非空串、trim、去重、≤30;空数组 → undefined(回内置默认)。 */
function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = [
    ...new Set(
      value
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        .map((t) => t.trim()),
    ),
  ].slice(0, 30);
  return tags.length > 0 ? tags : undefined;
}

/** Record<string, McpServerConfig> 归一化:逐 id 保留 type 合法且 shape 完整的条目，非法丢弃。 */
function parseMcpServers(value: unknown): Record<string, McpServerConfig> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, McpServerConfig> = {};
  const TYPES = new Set(['stdio', 'streamable-http', 'sse']);
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const cfg = raw as Record<string, unknown>;
    if (typeof cfg.type !== 'string' || !TYPES.has(cfg.type)) continue;
    const parsed: McpServerConfig = { type: cfg.type as McpServerConfig['type'] };
    if (typeof cfg.enabled === 'boolean') parsed.enabled = cfg.enabled;
    if (typeof cfg.command === 'string') parsed.command = cfg.command;
    if (Array.isArray(cfg.args) && cfg.args.every((x) => typeof x === 'string')) {
      parsed.args = cfg.args as string[];
    }
    if (typeof cfg.url === 'string') parsed.url = cfg.url;
    if (typeof cfg.cwd === 'string') parsed.cwd = cfg.cwd;
    if (typeof cfg.env === 'object' && cfg.env !== null && !Array.isArray(cfg.env)) {
      const env: Record<string, string> = {};
      let okEnv = true;
      for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          okEnv = false;
          break;
        }
        env[k] = v;
      }
      if (okEnv) parsed.env = env;
    }
    if (typeof cfg.headers === 'object' && cfg.headers !== null && !Array.isArray(cfg.headers)) {
      const headers: Record<string, string> = {};
      let okH = true;
      for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          okH = false;
          break;
        }
        headers[k] = v;
      }
      if (okH) parsed.headers = headers;
    }
    out[id] = parsed;
  }
  return out;
}

/** Record<string, string[]> 类型守卫:任一值非字符串数组 → 整个键回退默认值。 */
function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (v) => Array.isArray(v) && v.every((item) => typeof item === 'string'),
  );
}

const settingsPath = (): string => path.join(app.getPath('userData'), 'settings.json');

export async function readSettings(): Promise<AppSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    // Corrupt file: fall back to empty record rather than blocking startup.
    // The next successful write atomically replaces the bad file.
    return EMPTY;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    if (!parsed || !Array.isArray(parsed.recentWorkspaces)) return EMPTY;
    return {
      recentWorkspaces: parsed.recentWorkspaces.filter((p): p is string => typeof p === 'string'),
      showHiddenFiles: parsed.showHiddenFiles === true,
      defaultHideThinking: parsed.defaultHideThinking === true,
      disabledSkills: Array.isArray(parsed.disabledSkills)
        ? parsed.disabledSkills.filter((s): s is string => typeof s === 'string')
        : [],
      skillCollectionRoot:
        typeof parsed.skillCollectionRoot === 'string' && parsed.skillCollectionRoot.trim() !== ''
          ? parsed.skillCollectionRoot
          : '',
      workspaceSkillOverrides: isStringArrayRecord(parsed.workspaceSkillOverrides)
        ? parsed.workspaceSkillOverrides
        : {},
      language: parsed.language === 'en' ? 'en' : 'zh',
      ...(parsed.compileModel === null || isCompileModel(parsed.compileModel)
        ? { compileModel: parsed.compileModel }
        : {}),
      ...(parsed.dataSources !== undefined
        ? { dataSources: parseDataSources(parsed.dataSources) }
        : {}),
      ...(parsed.tags !== undefined ? { tags: normalizeTags(parsed.tags) } : {}),
      agentPluginRoot:
        typeof parsed.agentPluginRoot === 'string' && parsed.agentPluginRoot.trim() !== ''
          ? parsed.agentPluginRoot
          : '',
      disabledPlugins: Array.isArray(parsed.disabledPlugins)
        ? parsed.disabledPlugins.filter((s): s is string => typeof s === 'string')
        : [],
      mcpServers: parseMcpServers(parsed.mcpServers) ?? {},
    };
  } catch {
    return EMPTY;
  }
}

export async function writeSettings(next: AppSettings): Promise<void> {
  const target = settingsPath();
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.settings.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
  await rename(temp, target);
}

export async function recordRecentWorkspace(workspacePath: string): Promise<AppSettings> {
  const current = await readSettings();
  const next: AppSettings = {
    recentWorkspaces: [
      workspacePath,
      ...current.recentWorkspaces.filter((p) => p !== workspacePath),
    ],
    // 保留其它设置字段(文件树隐藏项、思考链默认折叠、技能隐藏/收集根/按工作区停用、界面语言),避免覆盖丢失。
    showHiddenFiles: current.showHiddenFiles,
    defaultHideThinking: current.defaultHideThinking,
    disabledSkills: current.disabledSkills,
    skillCollectionRoot: current.skillCollectionRoot,
    workspaceSkillOverrides: current.workspaceSkillOverrides,
    agentPluginRoot: current.agentPluginRoot,
    disabledPlugins: current.disabledPlugins,
    mcpServers: current.mcpServers,
    ...(current.language !== undefined ? { language: current.language } : {}),
    ...(current.compileModel !== undefined ? { compileModel: current.compileModel } : {}),
    ...(current.dataSources !== undefined ? { dataSources: current.dataSources } : {}),
    ...(current.tags !== undefined ? { tags: current.tags } : {}),
  };
  await writeSettings(next);
  return next;
}
