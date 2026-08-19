import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SavedClipboardImage } from './main/ipc/clipboard-ipc';
import type { TodayDayData } from './main/memory/day-summary';
import type { SessionInfo } from './main/pi-sdk-driver/driver';
import type {
  ConnectedProviderDto,
  CustomProviderInput,
  ModelDto,
  ProviderDto,
} from './main/pi-sdk-driver/model-config';
import type { Annotation, AnnotationDraft } from './shared/annotations';
import type { Lang } from './shared/i18n-core';
import { LICENSES_CHANNEL } from './shared/licenses-api';
import type {
  ArchivalAuditDto,
  CoreProjectionDto,
  CrystallizeArgs,
  DigestFileArgs,
  DigestTextArgs,
  EditArgs,
  ExperienceAuditDto,
  ListActiveArgs,
  ListEventsArgs,
  MemoryLink,
  OkfCheckResultDto,
  RetireArgs,
  SearchArgs,
  WorkingMemorySnapshotDto,
} from './shared/memory-api';
import {
  KNOWLEDGE_CHANNEL_READ,
  MEMORY_CHANNEL_CRYSTALLIZE,
  MEMORY_CHANNEL_DIGEST_FILE,
  MEMORY_CHANNEL_DIGEST_TEXT,
  MEMORY_CHANNEL_EDIT,
  MEMORY_CHANNEL_GET_ARCHIVAL_AUDIT,
  MEMORY_CHANNEL_GET_CORE_PROJECTION,
  MEMORY_CHANNEL_GET_EXPERIENCE_AUDIT,
  MEMORY_CHANNEL_GET_WORKING_MEMORY,
  MEMORY_CHANNEL_LIST_ACTIVE,
  MEMORY_CHANNEL_LIST_ARCHIVED,
  MEMORY_CHANNEL_LIST_EVENTS,
  MEMORY_CHANNEL_LIST_LINKS,
  MEMORY_CHANNEL_OKF_CHECK,
  MEMORY_CHANNEL_RETIRE,
  MEMORY_CHANNEL_SEARCH,
} from './shared/memory-api';
import type { MemoryEntry, MemoryEvent } from './shared/memory-schema';
import type { McpServerConfig, PluginsXray } from './shared/plugins-api';
import type { SerializedResult } from './shared/result';
import type { GenerateArgs, ReadArgs, ReviewMeta, StoredReview } from './shared/review-api';
import {
  REVIEW_CHANNEL_GENERATE,
  REVIEW_CHANNEL_LIST,
  REVIEW_CHANNEL_READ,
} from './shared/review-api';
import {
  type CollectResult,
  SKILLS_IPC,
  type SkillCreatedResult,
  type SkillGitStatus,
  type SkillReadResult,
  type SkillXray,
} from './shared/skills-api';

/**
 * Preload exposes the IPC surface as `window.lorra.*`. Per the
 * renderer never sees absolute paths or raw credentials — opaque IDs only.
 * IPC carries the SerializedResult envelope ({ok,value}/{ok,error}) as pure
 * data (methods are stripped cross-process); every bridge passes it through
 * unchanged — the renderer narrows on `res.ok` directly.
 */

function invoke<T>(channel: string, payload?: unknown): Promise<SerializedResult<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<SerializedResult<T>>;
}

const lorra = {
  platform: process.platform,
  app: {
    info: () => ipcRenderer.invoke('lorra.app.info') as Promise<{ version: string; name: string }>,
    licenses: () =>
      ipcRenderer.invoke(LICENSES_CHANNEL) as Promise<
        import('./shared/licenses-api').OpenSourceProject[]
      >,
    openExternal: (url: string) =>
      ipcRenderer.invoke('lorra.app.openExternal', url) as Promise<boolean>,
  },
  window: {
    minimize: () => ipcRenderer.invoke('lorra.window.minimize') as Promise<boolean>,
    toggleMaximize: () => ipcRenderer.invoke('lorra.window.toggleMaximize') as Promise<boolean>,
    close: () => ipcRenderer.invoke('lorra.window.close') as Promise<boolean>,
  },
  workspace: {
    pick: () => ipcRenderer.invoke('lorra.workspace.pick') as Promise<{ path: string | null }>,
    switch: () => ipcRenderer.invoke('lorra.workspace.switch') as Promise<{ path: string | null }>,
    get: () => ipcRenderer.invoke('lorra.workspace.get') as Promise<{ path: string | null }>,
    activate: (path: string) =>
      ipcRenderer.invoke('lorra.workspace.activate', { path }) as Promise<{ path: string | null }>,
    list: () => ipcRenderer.invoke('lorra.workspace.list') as Promise<{ workspaces: string[] }>,
    remove: (path: string) =>
      ipcRenderer.invoke('lorra.workspace.remove', { path }) as Promise<{ workspaces: string[] }>,
  },
  session: {
    list: (args: { workspaceId: string }) => invoke<SessionInfo[]>('lorra.session.list', args),
    open: (args: { sessionId: string }) =>
      invoke<{ sessionId: string }>('lorra.session.open', args),
    continueRecent: (args: { workspaceId: string }) =>
      invoke<{ sessionId: string }>('lorra.session.continueRecent', args),
    create: (args: { workspaceId: string }) =>
      invoke<{ sessionId: string }>('lorra.session.new', args),
    send: (args: { sessionId: string; text: string; images?: Array<{ fileId: string }> }) =>
      invoke<{ accepted: boolean; busySessionId?: string }>('lorra.session.send', args),
    abort: (args: { sessionId: string }) => invoke<true>('lorra.session.abort', args),
    compact: (args: { sessionId: string }) =>
      invoke<{ accepted: boolean }>('lorra.session.compact', args),
    respondApproval: (args: {
      sessionId: string;
      approvalId: string;
      decision: 'allowOnce' | 'allowAlways' | 'deny';
    }) => invoke<true>('lorra.session.respondApproval', args),
  },
  providers: {
    catalog: () => invoke<ProviderDto[]>('lorra.providers.catalog'),
    list: () => invoke<ConnectedProviderDto[]>('lorra.providers.list'),
    connect: (args: { providerId: string; material?: string }) =>
      invoke<void>('lorra.providers.connect', {
        providerId: args.providerId,
        material: args.material,
      }),
    disconnect: (args: { providerId: string }) => invoke<void>('lorra.providers.disconnect', args),
    getAuthStatus: (args: { providerId: string }) =>
      invoke<{
        configured: boolean;
        source?:
          | 'stored'
          | 'runtime'
          | 'environment'
          | 'fallback'
          | 'models_json_key'
          | 'models_json_command';
        label?: string;
      }>('lorra.providers.getAuthStatus', args),
    testConnection: (args: { providerId: string }) =>
      invoke<void>('lorra.providers.testConnection', args),
    custom: {
      add: (input: CustomProviderInput) => invoke<void>('lorra.providers.custom.add', input),
      remove: (args: { providerId: string }) => invoke<void>('lorra.providers.custom.remove', args),
    },
  },
  models: {
    list: (args: { providerId?: string }) => invoke<ModelDto[]>('lorra.models.list', args),
    getDefault: () =>
      invoke<{ providerId: string; modelId: string } | null>('lorra.models.getDefault'),
    setDefault: (args: { providerId: string; modelId: string }) =>
      invoke<void>('lorra.models.setDefault', args),
    toggle: (args: { providerId: string; modelId: string; enabled: boolean }) =>
      invoke<void>('lorra.models.toggle', args),
    getAvailable: () => invoke<ModelDto[]>('lorra.models.getAvailable'),
  },
  fs: {
    tree: (args: { directoryId: string; depth?: number }) =>
      invoke<Array<{ id: string; name: string; type: 'file' | 'dir'; hasChildren: boolean }>>(
        'lorra.fs.tree',
        args,
      ),
    search: (args: { query: string; limit?: number }) =>
      invoke<Array<{ fileId: string; name: string }>>('lorra.fs.search', args),
    resolveWikilink: (args: { name: string }) =>
      invoke<{ fileId: string | null }>('lorra.fs.resolve-wikilink', args),
    open: (args: { fileId: string }) =>
      invoke<{ content: string; mtime: number; size: number }>('lorra.fs.open', args),
    save: (args: { fileId: string; content: string; baseMtime?: number }) =>
      invoke<{ mtime: number }>('lorra.fs.save', args),
    openBinary: (args: { fileId: string }) =>
      invoke<{ data: Uint8Array }>('lorra.fs.openBinary', args),
    // 拖拽文件 → 磁盘绝对路径(2026-08-14):Electron 43 已移除 File.path 增强,
    // 官方替代为 webUtils.getPathForFile(renderer 侧 contextBridge 直传 File)。
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    // 素材消化(3b 6.13):系统文件对话框选素材文件,取消返回 null。
    pickFile: () => invoke<string | null>('lorra.fs.pick-file'),
  },
  annotations: {
    list: (args: { fileId: string }) => invoke<Annotation[]>('lorra.annotations.list', args),
    save: (args: { fileId: string; annotation: AnnotationDraft }) =>
      invoke<void>('lorra.annotations.save', args),
    remove: (args: { fileId: string; id: string }) =>
      invoke<void>('lorra.annotations.remove', args),
  },
  edits: {
    revert: (args: { editId: string }) => invoke<{ fileId: string }>('lorra.edits.revert', args),
    accept: (args: { editId: string }) => invoke<{ fileId: string }>('lorra.edits.accept', args),
    list: (args: { sessionId?: string }) =>
      invoke<
        Array<{
          id: string;
          sessionId: string;
          toolName: 'write' | 'edit';
          fileId: string;
          ts: number;
          status: 'applied' | 'accepted' | 'reverted';
          kind: 'git' | 'snapshot';
        }>
      >('lorra.edits.list', args),
  },
  events: {
    subscribe: (cb: (event: unknown) => void) => {
      const handler = (_e: unknown, event: unknown) => cb(event);
      ipcRenderer.on('lorra.events', handler);
      return () => {
        ipcRenderer.removeListener('lorra.events', handler);
      };
    },
  },
  today: {
    // 今日页只读投影:直接透传主进程 SerializedResult 信封,渲染端按 ok 判别消费。
    getDayFacts: (dateISO?: string) => invoke<TodayDayData>('lorra.today.getDayFacts', { dateISO }),
    // S6:后台编译完成推送(今日页打开时数据过期 → 编译完成自动刷新);
    // 返回退订函数(removeListener)。
    onDayCompiled: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('lorra.today.dayCompiled', handler);
      return () => {
        ipcRenderer.removeListener('lorra.today.dayCompiled', handler);
      };
    },
  },
  review: {
    generate: (args: GenerateArgs) => invoke<ReviewMeta>(REVIEW_CHANNEL_GENERATE, args),
    list: () => invoke<ReviewMeta[]>(REVIEW_CHANNEL_LIST),
    read: (args: ReadArgs) => invoke<StoredReview>(REVIEW_CHANNEL_READ, args),
  },
  skills: {
    // 技能管理页(V1-9 + 2026-08-13 批):通道名取 shared/skills-api 单一事实源;
    // 与 today 同款直接透传主进程 SerializedResult 信封,渲染端按 ok 判别消费。
    xray: () => invoke<SkillXray>(SKILLS_IPC.xray),
    setEnabled: (name: string, enabled: boolean) =>
      invoke<void>(SKILLS_IPC.setEnabled, { name, enabled }),
    cleanDangling: (wsPath: string) =>
      invoke<{ cleaned: number }>(SKILLS_IPC.cleanDangling, { wsPath }),
    collect: (wsPath?: string) => invoke<CollectResult>(SKILLS_IPC.collect, { wsPath }),
    checkUpdates: () => invoke<Record<string, SkillGitStatus>>(SKILLS_IPC.checkUpdates),
    updateAll: () => invoke<{ updated: string[]; skipped: string[] }>(SKILLS_IPC.updateAll),
    setWsEnabled: (name: string, enabled: boolean, wsPath?: string) =>
      invoke<void>(SKILLS_IPC.setWsEnabled, { name, enabled, wsPath }),
    // /skill 触发(2026-08-14):读取技能文件原文,composer 拼 prompt 后走正常发送。
    read: (name: string) => invoke<SkillReadResult>(SKILLS_IPC.read, { name }),
    // 手动新建(2026-08-18):写 <ws>/.lorra/skills/<name>.md。
    create: (args: { name: string; content: string; wsPath?: string }) =>
      invoke<SkillCreatedResult>(SKILLS_IPC.create, args),
  },
  clipboard: {
    // 输入栏粘贴图片(2026-08-14):主进程读系统剪贴板 → 存工作区 → 返回预览 dataUrl。
    saveImage: () => invoke<SavedClipboardImage>('lorra.clipboard.saveImage'),
  },
  settings: {
    get: () =>
      invoke<{
        showHiddenFiles: boolean;
        language: Lang;
        defaultHideThinking: boolean;
        compileModel: { providerId: string; modelId: string } | null;
        dataSources: {
          claudeCode: boolean;
          opencode: boolean;
          ohMyPi: boolean;
          workbuddy: boolean;
        };
        tags: string[];
      }>('lorra.settings.get'),
    set: (args: {
      showHiddenFiles?: boolean;
      language?: Lang;
      defaultHideThinking?: boolean;
      compileModel?: { providerId: string; modelId: string } | null;
      dataSources?: {
        claudeCode?: boolean;
        opencode?: boolean;
        ohMyPi?: boolean;
        workbuddy?: boolean;
      };
      tags?: string[];
    }) => invoke<void>('lorra.settings.set', args),
  },
  memory: {
    // 记忆页全栈 bridge(phase3-contract 6.9 / ):通道名/参数形状取
    // shared/memory-api 单一事实源;invoke 包装后直传 SerializedResult 信封。
    // 无 confirm/reject 通道(闸门拆除);edit = update 语义,listEvents = 审计视图数据源。
    listActive: (args: ListActiveArgs) => invoke<MemoryEntry[]>(MEMORY_CHANNEL_LIST_ACTIVE, args),
    listArchived: () => invoke<MemoryEntry[]>(MEMORY_CHANNEL_LIST_ARCHIVED),
    listEvents: (args: ListEventsArgs) => invoke<MemoryEvent[]>(MEMORY_CHANNEL_LIST_EVENTS, args),
    listLinks: () => invoke<MemoryLink[]>(MEMORY_CHANNEL_LIST_LINKS),
    edit: (args: EditArgs) => invoke<MemoryEntry>(MEMORY_CHANNEL_EDIT, args),
    retire: (args: RetireArgs) => invoke<MemoryEntry>(MEMORY_CHANNEL_RETIRE, args),
    search: (args: SearchArgs) => invoke<MemoryEntry[]>(MEMORY_CHANNEL_SEARCH, args),
    // 6.13 素材消化 + 用户结晶(「记住这段」):原文不落库,产物直落 active。
    digestText: (args: DigestTextArgs) =>
      invoke<{ entryId: string }>(MEMORY_CHANNEL_DIGEST_TEXT, args),
    digestFile: (args: DigestFileArgs) =>
      invoke<{ entryId: string }>(MEMORY_CHANNEL_DIGEST_FILE, args),
    crystallize: (args: CrystallizeArgs) =>
      invoke<{ entryId: string }>(MEMORY_CHANNEL_CRYSTALLIZE, args),
    // :知识库文档读取(记忆页「查看文档」跳转 OFK memory/<entryId>.md)。
    readDocument: (path: string) =>
      invoke<{ content: string | null }>(KNOWLEDGE_CHANNEL_READ, { path }),
    getCoreProjection: () => invoke<CoreProjectionDto>(MEMORY_CHANNEL_GET_CORE_PROJECTION),
    getWorkingMemory: (sessionId: string) =>
      invoke<WorkingMemorySnapshotDto | null>(MEMORY_CHANNEL_GET_WORKING_MEMORY, { sessionId }),
    getArchivalAudit: (sessionId: string) =>
      invoke<ArchivalAuditDto | null>(MEMORY_CHANNEL_GET_ARCHIVAL_AUDIT, { sessionId }),
    getExperienceAudit: (nameOrId: string) =>
      invoke<ExperienceAuditDto | null>(MEMORY_CHANNEL_GET_EXPERIENCE_AUDIT, { nameOrId }),
    okfCheck: (path: string) => invoke<OkfCheckResultDto>(MEMORY_CHANNEL_OKF_CHECK, { path }),
  },
  plugins: {
    // 数据源插件清单:设置页只读展示;每次调用现加载。
    list: () =>
      invoke<{
        plugins: Array<{
          name: string;
          runtime: string;
          description: string;
          status: 'ok' | 'error';
          error?: string;
        }>;
      }>('lorra.plugins.list'),
  },
  agentPlugins: {
    // agent-plugins 管理（plan S2/S4）：插件态/MCP 态数据 + 启停/增删；
    // 与 skills 同款直接透传 SerializedResult 信封，渲染端按 ok 判别消费。
    xray: (wsPath?: string) => invoke<PluginsXray>('lorra.plugins.xray', { wsPath }),
    setPluginEnabled: (name: string, enabled: boolean) =>
      invoke<void>('lorra.plugins.setPluginEnabled', { name, enabled }),
    mcpAdd: (id: string, config: McpServerConfig) =>
      invoke<void>('lorra.plugins.mcpAdd', { id, config }),
    mcpRemove: (id: string) => invoke<void>('lorra.plugins.mcpRemove', { id }),
    mcpSetEnabled: (id: string, enabled: boolean) =>
      invoke<void>('lorra.plugins.mcpSetEnabled', { id, enabled }),
    mcpTest: (id: string) =>
      invoke<{ id: string; ok: boolean; toolCount?: number; error?: string }>(
        'lorra.plugins.mcpTest',
        { id },
      ),
    importFolder: (source: string) =>
      invoke<{ name: string; path: string; skillCount: number; mcpCount: number }>(
        'lorra.plugins.importFolder',
        { source },
      ),
    create: (name: string) =>
      invoke<{ name: string; path: string }>('lorra.plugins.create', { name }),
  },
};

contextBridge.exposeInMainWorld('lorra', lorra);

export type LorraApi = typeof lorra;
