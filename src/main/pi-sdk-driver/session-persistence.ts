import { statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentSession,
  EventBus,
  Extension,
  ExtensionAPI,
  ExtensionRuntime,
  ExtensionFactory as SdkExtensionFactory,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEventBus,
  createExtensionRuntime,
  type SessionInfo as SdkSessionInfo,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
// 纯共享模块(零 node 依赖):本文件被 tests/unit 直接 import,
// 经 recall.ts 会拖入 shared-memory-store → node:sqlite,client 测试图打包失败。
import { stripRecallContext } from '../../shared/recall-context';
import { collectAgentPluginSkillPaths, loadAgentPlugins } from '../agent-plugins/loader';
import { agentPluginsRoot } from '../agent-plugins/root';
import { createMcpClient, type McpClient } from '../mcp/mcp-client';
import { createMcpExtension, type ReadyMcpTool } from '../mcp/mcp-extension';
import { mcpToolName } from '../mcp/tool-adapter';
import {
  createMemoryTool,
  MEMORY_TOOL_NAME,
  type MemoryRecordedPayload,
} from '../memory/propose-memory-tool';
import { createKnowledgeTool, KNOWLEDGE_TOOL_NAME } from '../ofk/knowledge-tool';
import { buildSkillsOverride } from '../skills/skills-override';
import { getSkillCollectionRoot } from '../skills/skills-store';
import { readSettings } from '../workspace/settings';
import type { BlockEmitter, SessionInfo, SessionPersistence } from './driver';
import { lorraConfigDir } from './lorra-config-dir';
import { buildLorraSystemPrompt } from './lorra-system-prompt';
import { createInstallSkillTool, SKILL_INSTALL_TOOL_NAME } from './skill-tools/install-skill-tool';
import { createSafetyInterceptor } from './tool-safety/interceptor';
import { AnySearchClient, createWebTools, ExaMcpClient, type McpFetchLike } from './web-tools';

/**
 * SDK discovery default for SessionManager.list(cwd) without an explicit
 * sessionDir lands on the SDK's own `~/.pi/agent/sessions/...` — diverging
 * from where lorra's createAgentSessionServices writes (lorraConfigDir).
 * We pass `sessionDir` explicitly so list/continueRecent read the same tree
 * that buildAgentSession writes to. Pattern mirrors SDK's
 * getDefaultSessionDirPath (path-with-dashes encoding) — see
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`.
 */
export function lorraSessionDir(cwd: string): string {
  const safe = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(lorraConfigDir(), 'sessions', safe);
}

function toSessionInfo(sdk: SdkSessionInfo): SessionInfo {
  return {
    id: sdk.id,
    // 显示卫生(走查实证):SDK 以首条消息(含召回注入块)命名会话,
    // 侧栏会话标题会泄漏整块记忆+HTML 注释——显示层剥离注入前缀。
    name: sdk.name ? stripRecallContext(sdk.name) : sdk.name,
    cwd: sdk.cwd,
    path: sdk.path,
    created: sdk.created,
    modified: sdk.modified,
    messageCount: sdk.messageCount,
    firstMessage: stripRecallContext(sdk.firstMessage),
  };
}

/**
 * Load an inline ExtensionFactory into an Extension object.
 * The SDK has `loadExtensionFromFactory` at
 * `@earendil-works/pi-coding-agent/core/extensions/loader` but its
 * package.json `exports` field only exposes `.` and `./rpc-entry`, so the
 * sub-path is not importable from consumers. Hand-roll the minimum needed
 * to register our tool-safety factory inline.
 */
function loadInlineExtension(
  factory: SdkExtensionFactory,
  _eventBus: EventBus,
  _runtime: ExtensionRuntime,
  extensionPath: string,
): Extension {
  const extension: Extension = {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: {
      path: extensionPath,
      source: 'inline',
      scope: 'project',
      origin: 'top-level',
    },
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const api = {
    on(event: string, handler: unknown) {
      const list = extension.handlers.get(event) ?? [];
      list.push(handler as never);
      extension.handlers.set(event, list);
    },
    registerTool(tool: Parameters<ExtensionAPI['registerTool']>[0]) {
      extension.tools.set(tool.name, {
        definition: tool,
        sourceInfo: {
          path: extensionPath,
          source: 'inline',
          scope: 'project',
          origin: 'top-level',
        },
      });
    },
  } as unknown as ExtensionAPI;
  void factory(api);
  return extension;
}

export async function createSessionPersistence(opts: {
  workspacePath: string;
  emitBlocked: BlockEmitter;
  /** Injectable fetch for the web tools (Electron main passes net.fetch). */
  fetcher?: McpFetchLike;
  /** 编辑历史:write/edit 放行时记录执行前内容。 */
  recordEditBefore?: (payload: {
    toolCallId: string;
    toolName: 'write' | 'edit';
    fileId: string;
    before: string;
  }) => void;
  /** 编辑历史:tool_result 到达时收口记录。 */
  finalizeEdit?: (payload: {
    toolCallId: string;
    toolName: string;
    fileId: string;
    ok: boolean;
  }) => void;
  /** 分级审批:write/edit 需审批时请求许可,返回裁决 Promise。 */
  requestApproval?: (payload: {
    toolName: string;
    target: string;
    reason: string;
    callId?: string;
  }) => Promise<'allowOnce' | 'allowAlways' | 'deny'>;
  /** 分级审批:会话内已批准 (toolName, target) 直放。 */
  checkApproved?: (toolName: string, target: string) => boolean;
  /**
   * 记忆写入成功事件(/D6):memory 工具 propose/update 成功后回调,
   * payload 形状 = agent-events.ts MemoryRecordedEvent(RendererAutonomy 定稿,
   * 未落地前经此回调以字面量对象转发)。sessionId 在会话创建后注入。
   */
  emitMemoryRecorded?: (payload: MemoryRecordedPayload) => void;
}): Promise<SessionPersistence> {
  const wsRealpath = await realpath(opts.workspacePath);
  // One MCP client per workspace activation: all sessions share the cached
  // Exa session so only the first tool call pays the initialize round-trip.
  const webClient = new ExaMcpClient({ fetcher: opts.fetcher });
  // 备用搜索后端(Exa 免费额度耗尽/故障兜底,2026-08-09):AnySearch 免 key
  // 匿名公共端点,与 Exa 额度互不消耗;Exa Err 时 web_search/web_fetch 自动降级。
  const backupWebClient = new AnySearchClient({ fetcher: opts.fetcher });

  async function buildAgentSession(sessionManager: SessionManager): Promise<AgentSession> {
    // (2026-08-13 批修订):创建会话时读取 AppSettings,把全局隐藏名单
    // (disabledSkills)与按工作区停用名单(workspaceSkillOverrides,恒合并——newmax 式
    // 开关语义,无 opt-in gate)合并进 skillsOverride;readSettings 容错(缺文件/坏文件
    // 回退默认)。软禁用语义:只从 <available_skills> 提示清单剔除,不防读
    // (agent 仍可 read 技能文件)。
    const settings = await readSettings();
    const excludedSkills = buildSkillsOverride({
      wsPath: wsRealpath,
      existingExclusions: ['daily-review', 'deep-review', 'ofk-digest'],
      disabledSkills: settings.disabledSkills ?? [],
      workspaceSkillOverrides: settings.workspaceSkillOverrides ?? {},
    });
    // 2026-08-13(技能收集批 D8):收集根可自定义后 SDK 必须发现它——自定义根技能
    // 对 agent 不可见会直接发散「页面所见 vs agent 所见」。与既有两项 realpath
    // 相同(默认收集根 = ~/.agents/skills)或尚不存在时不重复加入。
    const collectionRoot = getSkillCollectionRoot(settings);
    const collectionRootReal = path.resolve(collectionRoot);
    let collectionRootExists = false;
    try {
      collectionRootExists = statSync(collectionRootReal).isDirectory();
    } catch {
      collectionRootExists = false;
    }
    const baseSkillPaths = [
      path.join(wsRealpath, '.lorra', 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
    ];
    const collectionRootDuplicates = baseSkillPaths.some(
      (p) => path.resolve(p).toLowerCase() === collectionRootReal.toLowerCase(),
    );
    // 第 6 源：启用的 agent-plugins 技能根（skills/ 目录，SDK 递归发现其下 SKILL.md）。
    const pluginRoot =
      settings.agentPluginRoot && settings.agentPluginRoot.trim() !== ''
        ? settings.agentPluginRoot
        : agentPluginsRoot();
    const agentPluginSkills = await collectAgentPluginSkillPaths({
      root: pluginRoot,
      disabled: new Set(settings.disabledPlugins ?? []),
    });
    const additionalSkillPaths = [
      ...(collectionRootDuplicates || !collectionRootExists
        ? baseSkillPaths
        : [...baseSkillPaths, collectionRootReal]),
      ...agentPluginSkills.map((s) => s.skillsRoot),
    ];
    const services = await createAgentSessionServices({
      cwd: wsRealpath,
      agentDir: lorraConfigDir(),
      // 项目技能统一 .lorra 单源:排除 SDK 默认 <cwd>/.pi 技能源(前缀锚定,
      // 不误伤用户路径含 .pi 段的工作区);复盘播种的平铺 .md 也会被 SDK
      // 当技能发现,必须按名字剔除(见 review-generator loadOrSeedSkill)。
      // 2026-08-10:用户全局技能库 <home>/.agents/skills 加入
      // additionalSkillPaths——agent 可自主发现本机既有技能(读/执行走既有
      // 可信路径直放,写仍审批;技能自带硬边界,发现 ≠ 授权)。
      // 2026-08-12(/D6 勘误 4):skillsOverride 剔除 = 共享合并函数
      // 输出(既有 .pi/复盘剔除原样保持 + disabledSkills + 按工作区停用)。
      // 2026-08-13(技能收集批 D8):additionalSkillPaths 动态加入自定义收集根。
      // 2026-08-15(系统提示词批,整体替换):lorra 完整主提示词经 systemPromptOverride
      // 替换 SDK 默认主文(expert coding assistant operating inside pi 段不再进入),
      // 身份/汇报格式/配置路径/专属工具/pi 文档指引全在 lorra-system-prompt.ts 一份
      // 文案。appendSystemPromptOverride 清空,掐掉 SDK 自动发现的 APPEND_SYSTEM.md,
      // 确保替换干净。cwd/工具清单//skills 仍由 buildSystemPrompt 动态注入。
      resourceLoaderOptions: {
        additionalSkillPaths,
        systemPromptOverride: () => buildLorraSystemPrompt({ workspacePath: wsRealpath }),
        appendSystemPromptOverride: () => [],
        skillsOverride: (base) => {
          return {
            ...base,
            skills: base.skills.filter((skill) => {
              const p = skill.filePath.replace(/\\/g, '/');
              // 条目语义:技能名精确匹配,或路径前缀边界匹配(见 buildSkillsOverride)。
              return !excludedSkills.some(
                (entry) => skill.name === entry || p === entry || p.startsWith(`${entry}/`),
              );
            }),
          };
        },
      },
    });
    const eventBus = createEventBus();
    const runtime = createExtensionRuntime();
    const safetyFactory: SdkExtensionFactory = createSafetyInterceptor({
      workspaceRoot: wsRealpath,
      emitBlocked: opts.emitBlocked,
      recordEditBefore: opts.recordEditBefore,
      finalizeEdit: opts.finalizeEdit,
      requestApproval: opts.requestApproval,
      checkApproved: opts.checkApproved,
    });
    const safetyExtension = loadInlineExtension(safetyFactory, eventBus, runtime, 'tool-safety');
    // : memory 工具注册 —— 四操作(propose 直落 active / update 就地
    // 更新 / retire / search),成功写入 emit memory.recorded。emitRecorded 的
    // sessionId 由注册处闭包注入(工具执行时会话已创建);经 emitMemoryRecorded
    // 回调由应用层转发事件。getWorkspace 供 search 的 scope 过滤匹配当前工作区。
    let agentSessionId = '';
    const customTools: ToolDefinition[] = [
      ...createWebTools({ client: webClient, backupClient: backupWebClient }),
      createMemoryTool({
        // 共享单例经惰性动态 import 装载:node:sqlite 是实验性内置, 本模块被
        // tests/unit 直接 import, 静态引入会把 sqlite 拉进 vitest client 测试图
        // 导致打包失败（shared-facts-store 同款纪律）。
        getStore: async () => {
          const { getSharedMemoryStore } = await import('../memory/shared-memory-store');
          const shared = getSharedMemoryStore();
          if (shared.isErr()) {
            throw new Error(`memory store unavailable: ${shared.error.message}`);
          }
          return shared.value;
        },
        emitRecorded: (payload) => {
          if (agentSessionId && opts.emitMemoryRecorded) {
            opts.emitMemoryRecorded({ ...payload, sessionId: agentSessionId });
          }
        },
        getWorkspace: () => wsRealpath,
      }),
      // 技能安装工具(2026-08-13 UX 重构):替代前端安装按钮,agent 在对话里
      // 收到安装请求时自动调用。安装核心经惰性动态 import 接线(skill-manager
      // 会拖入 electron shell,静态引入破坏 vitest client 测试图,同 memory 纪律)。
      createInstallSkillTool({
        install: async (gitUrl) => (await import('../skills/skill-manager')).installSkill(gitUrl),
      }),
      // knowledge 工具:知识摄入(ingest/write/search),只写
      // ~/.lorra/knowledge,不触工作区;fetch 复用 runtime 传入的 Chromium
      // 网络栈(runtime 传给 persistence 的 fetcher 模式)。
      createKnowledgeTool({
        fetcher: opts.fetcher ?? ((url, init) => fetch(url, init)),
        getProducer: () => 'pi-sdk',
      }),
    ];

    // ── 自研 MCP 运行时（plan S3，扩展 pi 边界）：拉起启用的 MCP server → tools/list →
    // 收集 ReadyMcpTool，纳入 tools 白名单并经 McpExtension 注册进会话工具面。──
    const pluginDataRoot = path.join(lorraConfigDir(), 'plugins', 'agent-plugins', 'data');
    const mcpClients: Array<{ serverId: string; client: McpClient }> = [];
    const readyMcpTools: ReadyMcpTool[] = [];
    try {
      // 1) 插件内置 MCP（loadAgentPlugins 汇总，仅 enabled 插件 + 非 sse）。
      const pluginLoad = await loadAgentPlugins({
        root: agentPluginsRoot(),
        disabled: new Set(settings.disabledPlugins ?? []),
      });
      if (pluginLoad.isOk()) {
        for (const mcp of pluginLoad.value.mcps) {
          if (!mcp.enabled || mcp.config.type === 'sse') continue;
          const created = createMcpClient(mcp.config, agentPluginsRoot(), {
            fetcher: opts.fetcher,
            pluginDataDir: path.join(pluginDataRoot, 'plugin-' + mcp.pluginName),
          });
          if (created.isErr()) continue;
          const started = await created.value.start();
          if (started.isErr()) {
            created.value.stop();
            continue;
          }
          mcpClients.push({ serverId: mcp.id, client: created.value });
          for (const tool of started.value) readyMcpTools.push({ serverId: mcp.id, tool });
        }
      }
      // 2) 用户自配 MCP（settings.mcpServers，enabled !== false）。
      for (const [id, cfg] of Object.entries(settings.mcpServers ?? {})) {
        if (cfg.enabled === false || cfg.type === 'sse') continue;
        const created = createMcpClient(cfg, wsRealpath, {
          fetcher: opts.fetcher,
          pluginDataDir: path.join(pluginDataRoot, 'user-' + id),
        });
        if (created.isErr()) continue;
        const started = await created.value.start();
        if (started.isErr()) {
          created.value.stop();
          continue;
        }
        mcpClients.push({ serverId: id, client: created.value });
        for (const tool of started.value) readyMcpTools.push({ serverId: id, tool });
      }
    } catch {
      // MCP 拉取失败不改挂会话（fail-open；单 server 失败已在 start 层跳过）。
    }

    const mcpToolNames = readyMcpTools.map((r) => mcpToolName(r.serverId, r.tool.name));
    const mcpCall = async (
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<{ ok: boolean; text?: string; error?: string }> => {
      const entry = mcpClients.find((c) => c.serverId === serverId);
      if (!entry) return { ok: false, error: 'MCP 服务器不可用' };
      const res = await entry.client.callTool(toolName, args);
      if (res.isErr()) return { ok: false, error: res.error.message };
      return { ok: true, text: res.value };
    };

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      // tools = session availability whitelist (maps to SDK allowedToolNames,
      // which also gates customTools registration — tools missing here are
      // registered but never reach the model/system prompt).
      tools: [
        'read',
        'write',
        'edit',
        'bash',
        'grep',
        'find',
        'ls',
        'web_search',
        'web_fetch',
        'update_plan',
        MEMORY_TOOL_NAME,
        SKILL_INSTALL_TOOL_NAME,
        KNOWLEDGE_TOOL_NAME,
        ...mcpToolNames,
      ],
      customTools,
    });
    agentSessionId = session.sessionId;
    // M1 wiring: register the safety extension with the session's ExtensionRunner
    // so that tool_call events are intercepted before each tool execution.
    // extensions is private on ExtensionRunner; cast through unknown to access.
    const runner = session.extensionRunner as unknown as { extensions: unknown[] };
    runner.extensions.push(safetyExtension);
    // MCP 工具（经 registerTool 注册）扩展到会话工具面（plan S3）。无 MCP 工具则跳过。
    if (readyMcpTools.length > 0) {
      const mcpExtension = loadInlineExtension(
        createMcpExtension({ tools: readyMcpTools, call: mcpCall }),
        eventBus,
        runtime,
        'mcp-bridge',
      );
      runner.extensions.push(mcpExtension);
    }
    return session;
  }

  return {
    async list(cwd: string): Promise<SessionInfo[]> {
      let all: SdkSessionInfo[];
      try {
        all = await SessionManager.list(cwd, lorraSessionDir(cwd));
      } catch {
        return [];
      }
      const wsReal = await realpath(cwd);
      const filtered: SessionInfo[] = [];
      for (const s of all) {
        try {
          const sessionCwdReal = await realpath(s.cwd);
          if (sessionCwdReal === wsReal && s.messageCount > 0) {
            filtered.push(toSessionInfo(s));
          }
        } catch {
          // skip sessions whose cwd is unreadable (defensive)
        }
      }
      return filtered;
    },
    async open(jsonlPath: string): Promise<AgentSession> {
      const sm = SessionManager.open(jsonlPath, lorraSessionDir(jsonlPath));
      return buildAgentSession(sm);
    },
    async continueRecent(cwd: string): Promise<AgentSession> {
      const sm = SessionManager.continueRecent(cwd, lorraSessionDir(cwd));
      return buildAgentSession(sm);
    },
    async createInMemory(cwd: string): Promise<AgentSession> {
      // Persist new sessions to the lorra session dir — SDK inMemory is
      // explicitly "no file persistence", which would lose the conversation
      // on app close and hide it from list. Name kept for driver.ts.
      const sm = SessionManager.create(cwd, lorraSessionDir(cwd));
      return buildAgentSession(sm);
    },
  };
}
