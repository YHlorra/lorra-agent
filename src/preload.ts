import { contextBridge, ipcRenderer } from 'electron';
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
  CrystallizeArgs,
  DigestFileArgs,
  DigestTextArgs,
  EditArgs,
  ListActiveArgs,
  ListEventsArgs,
  MemoryLink,
  RetireArgs,
  SearchArgs,
} from './shared/memory-api';
import {
  KNOWLEDGE_CHANNEL_READ,
  MEMORY_CHANNEL_CRYSTALLIZE,
  MEMORY_CHANNEL_DIGEST_FILE,
  MEMORY_CHANNEL_DIGEST_TEXT,
  MEMORY_CHANNEL_EDIT,
  MEMORY_CHANNEL_LIST_ACTIVE,
  MEMORY_CHANNEL_LIST_ARCHIVED,
  MEMORY_CHANNEL_LIST_EVENTS,
  MEMORY_CHANNEL_LIST_LINKS,
  MEMORY_CHANNEL_RETIRE,
  MEMORY_CHANNEL_SEARCH,
} from './shared/memory-api';
import type { MemoryEntry, MemoryEvent } from './shared/memory-schema';
import { fromSerialized, type SerializedResult, toView } from './shared/result';
import type { GenerateArgs, ReadArgs, ReviewMeta, StoredReview } from './shared/review-api';
import {
  REVIEW_CHANNEL_GENERATE,
  REVIEW_CHANNEL_LIST,
  REVIEW_CHANNEL_READ,
} from './shared/review-api';
import {
  type CollectResult,
  SKILLS_IPC,
  type SkillGitStatus,
  type SkillXray,
} from './shared/skills-api';

/**
 * Preload exposes the IPC surface as `window.lorra.*`. Per the
 * renderer never sees absolute paths or raw credentials — opaque IDs only.
 * IPC carries SerializedResult pure data (methods are stripped cross-process);
 * each bridge method rehydrates it into a better-result `Result` via fromSerialized.
 */

const lorra = {
  platform: process.platform,
  app: {
    info: () => ipcRenderer.invoke('lorra.app.info') as Promise<{ version: string; name: string }>,
    licenses: () =>
      ipcRenderer.invoke(LICENSES_CHANNEL) as Promise<
        import('./shared/licenses-api').OpenSourceProject[]
      >,
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
    list: async (args: { workspaceId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.session.list', args)) as SerializedResult<
        SessionInfo[]
      >;
      return toView(fromSerialized(raw));
    },
    open: async (args: { sessionId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.session.open', args)) as SerializedResult<{
        sessionId: string;
      }>;
      return toView(fromSerialized(raw));
    },
    continueRecent: async (args: { workspaceId: string }) => {
      const raw = (await ipcRenderer.invoke(
        'lorra.session.continueRecent',
        args,
      )) as SerializedResult<{ sessionId: string }>;
      return toView(fromSerialized(raw));
    },
    create: async (args: { workspaceId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.session.new', args)) as SerializedResult<{
        sessionId: string;
      }>;
      return toView(fromSerialized(raw));
    },
    send: async (args: { sessionId: string; text: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.session.send', args)) as SerializedResult<{
        accepted: boolean;
        busySessionId?: string;
      }>;
      return toView(fromSerialized(raw));
    },
    abort: async (args: { sessionId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.session.abort', args)) as SerializedResult<true>;
      return toView(fromSerialized(raw));
    },
    compact: async (args: { sessionId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.session.compact', args)) as SerializedResult<{
        accepted: boolean;
      }>;
      return toView(fromSerialized(raw));
    },
    respondApproval: async (args: {
      sessionId: string;
      approvalId: string;
      decision: 'allowOnce' | 'allowAlways' | 'deny';
    }) => {
      const raw = (await ipcRenderer.invoke(
        'lorra.session.respondApproval',
        args,
      )) as SerializedResult<true>;
      return toView(fromSerialized(raw));
    },
  },
  providers: {
    catalog: async () => {
      const raw = (await ipcRenderer.invoke('lorra.providers.catalog')) as SerializedResult<
        ProviderDto[]
      >;
      return toView(fromSerialized(raw));
    },
    list: async () => {
      const raw = (await ipcRenderer.invoke('lorra.providers.list')) as SerializedResult<
        ConnectedProviderDto[]
      >;
      return toView(fromSerialized(raw));
    },
    connect: async (args: { providerId: string; material?: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.providers.connect', {
        providerId: args.providerId,
        material: args.material,
      })) as SerializedResult<void>;
      return toView(fromSerialized(raw));
    },
    disconnect: async (args: { providerId: string }) => {
      const raw = (await ipcRenderer.invoke(
        'lorra.providers.disconnect',
        args,
      )) as SerializedResult<void>;
      return toView(fromSerialized(raw));
    },
    getAuthStatus: async (args: { providerId: string }) => {
      const raw = (await ipcRenderer.invoke(
        'lorra.providers.getAuthStatus',
        args,
      )) as SerializedResult<{
        configured: boolean;
        source?:
          | 'stored'
          | 'runtime'
          | 'environment'
          | 'fallback'
          | 'models_json_key'
          | 'models_json_command';
        label?: string;
      }>;
      return toView(fromSerialized(raw));
    },
    testConnection: async (args: { providerId: string }) => {
      const raw = (await ipcRenderer.invoke(
        'lorra.providers.testConnection',
        args,
      )) as SerializedResult<void>;
      return toView(fromSerialized(raw));
    },
    custom: {
      add: async (input: CustomProviderInput) => {
        const raw = (await ipcRenderer.invoke(
          'lorra.providers.custom.add',
          input,
        )) as SerializedResult<void>;
        return toView(fromSerialized(raw));
      },
      remove: async (args: { providerId: string }) => {
        const raw = (await ipcRenderer.invoke(
          'lorra.providers.custom.remove',
          args,
        )) as SerializedResult<void>;
        return toView(fromSerialized(raw));
      },
    },
  },
  models: {
    list: async (args: { providerId?: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.models.list', args)) as SerializedResult<
        ModelDto[]
      >;
      return toView(fromSerialized(raw));
    },
    getDefault: async () => {
      const raw = (await ipcRenderer.invoke('lorra.models.getDefault')) as SerializedResult<{
        providerId: string;
        modelId: string;
      } | null>;
      return toView(fromSerialized(raw));
    },
    setDefault: async (args: { providerId: string; modelId: string }) => {
      const raw = (await ipcRenderer.invoke(
        'lorra.models.setDefault',
        args,
      )) as SerializedResult<void>;
      return toView(fromSerialized(raw));
    },
    toggle: async (args: { providerId: string; modelId: string; enabled: boolean }) => {
      const raw = (await ipcRenderer.invoke('lorra.models.toggle', args)) as SerializedResult<void>;
      return toView(fromSerialized(raw));
    },
    getAvailable: async () => {
      const raw = (await ipcRenderer.invoke('lorra.models.getAvailable')) as SerializedResult<
        ModelDto[]
      >;
      return toView(fromSerialized(raw));
    },
  },
  fs: {
    tree: async (args: { directoryId: string; depth?: number }) => {
      const raw = (await ipcRenderer.invoke('lorra.fs.tree', args)) as SerializedResult<
        Array<{ id: string; name: string; type: 'file' | 'dir'; hasChildren: boolean }>
      >;
      return toView(fromSerialized(raw));
    },
    search: async (args: { query: string; limit?: number }) => {
      const raw = (await ipcRenderer.invoke('lorra.fs.search', args)) as SerializedResult<
        Array<{ fileId: string; name: string }>
      >;
      return toView(fromSerialized(raw));
    },
    open: async (args: { fileId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.fs.open', args)) as SerializedResult<{
        content: string;
        mtime: number;
        size: number;
      }>;
      return toView(fromSerialized(raw));
    },
    save: async (args: { fileId: string; content: string; baseMtime?: number }) => {
      const raw = (await ipcRenderer.invoke('lorra.fs.save', args)) as SerializedResult<{
        mtime: number;
      }>;
      return toView(fromSerialized(raw));
    },
    openBinary: async (args: { fileId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.fs.openBinary', args)) as SerializedResult<{
        data: Uint8Array;
      }>;
      return toView(fromSerialized(raw));
    },
    // 素材消化(3b 6.13):系统文件对话框选素材文件,取消返回 null。
    pickFile: async () => {
      const raw = (await ipcRenderer.invoke('lorra.fs.pick-file')) as SerializedResult<
        string | null
      >;
      return toView(fromSerialized(raw));
    },
  },
  annotations: {
    list: async (args: { fileId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.annotations.list', args)) as SerializedResult<
        Annotation[]
      >;
      return toView(fromSerialized(raw));
    },
    save: async (args: { fileId: string; annotation: AnnotationDraft }) => {
      const raw = (await ipcRenderer.invoke(
        'lorra.annotations.save',
        args,
      )) as SerializedResult<void>;
      return toView(fromSerialized(raw));
    },
    remove: async (args: { fileId: string; id: string }) => {
      const raw = (await ipcRenderer.invoke(
        'lorra.annotations.remove',
        args,
      )) as SerializedResult<void>;
      return toView(fromSerialized(raw));
    },
  },
  edits: {
    revert: async (args: { editId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.edits.revert', args)) as SerializedResult<{
        fileId: string;
      }>;
      return toView(fromSerialized(raw));
    },
    accept: async (args: { editId: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.edits.accept', args)) as SerializedResult<{
        fileId: string;
      }>;
      return toView(fromSerialized(raw));
    },
    list: async (args: { sessionId?: string }) => {
      const raw = (await ipcRenderer.invoke('lorra.edits.list', args)) as SerializedResult<
        Array<{
          id: string;
          sessionId: string;
          toolName: 'write' | 'edit';
          fileId: string;
          ts: number;
          status: 'applied' | 'accepted' | 'reverted';
          kind: 'git' | 'snapshot';
        }>
      >;
      return toView(fromSerialized(raw));
    },
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
    // 今日页只读投影:直接透传主进程 SerializedResult 信封(契约钉死,
    // 与其余 toView 方法不同),渲染端按 status 判别消费。
    getDayFacts: async (dateISO?: string) => {
      return (await ipcRenderer.invoke('lorra.today.getDayFacts', {
        dateISO,
      })) as SerializedResult<TodayDayData>;
    },
  },
  review: {
    generate: async (args: GenerateArgs) => {
      const raw = (await ipcRenderer.invoke(
        REVIEW_CHANNEL_GENERATE,
        args,
      )) as SerializedResult<ReviewMeta>;
      return toView(fromSerialized(raw));
    },
    list: async () => {
      const raw = (await ipcRenderer.invoke(REVIEW_CHANNEL_LIST)) as SerializedResult<ReviewMeta[]>;
      return toView(fromSerialized(raw));
    },
    read: async (args: ReadArgs) => {
      const raw = (await ipcRenderer.invoke(
        REVIEW_CHANNEL_READ,
        args,
      )) as SerializedResult<StoredReview>;
      return toView(fromSerialized(raw));
    },
  },
  skills: {
    // 技能管理页(V1-9 + 2026-08-13 批):通道名取 shared/skills-api 单一事实源;
    // 与 today 同款直接透传主进程 SerializedResult 信封,渲染端按 status 判别消费。
    xray: async () => (await ipcRenderer.invoke(SKILLS_IPC.xray)) as SerializedResult<SkillXray>,
    setEnabled: async (name: string, enabled: boolean) =>
      (await ipcRenderer.invoke(SKILLS_IPC.setEnabled, {
        name,
        enabled,
      })) as SerializedResult<void>,
    cleanDangling: async (wsPath: string) =>
      (await ipcRenderer.invoke(SKILLS_IPC.cleanDangling, {
        wsPath,
      })) as SerializedResult<{ cleaned: number }>,
    collect: async (wsPath?: string) =>
      (await ipcRenderer.invoke(SKILLS_IPC.collect, {
        wsPath,
      })) as SerializedResult<CollectResult>,
    checkUpdates: async () =>
      (await ipcRenderer.invoke(SKILLS_IPC.checkUpdates)) as SerializedResult<
        Record<string, SkillGitStatus>
      >,
    updateAll: async () =>
      (await ipcRenderer.invoke(SKILLS_IPC.updateAll)) as SerializedResult<{
        updated: string[];
        skipped: string[];
      }>,
    setWsEnabled: async (name: string, enabled: boolean, wsPath?: string) =>
      (await ipcRenderer.invoke(SKILLS_IPC.setWsEnabled, {
        name,
        enabled,
        wsPath,
      })) as SerializedResult<void>,
  },
  settings: {
    get: async () => {
      const raw = (await ipcRenderer.invoke('lorra.settings.get')) as SerializedResult<{
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
      }>;
      return toView(fromSerialized(raw));
    },
    set: async (args: {
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
    }) => {
      const raw = (await ipcRenderer.invoke('lorra.settings.set', args)) as SerializedResult<void>;
      return toView(fromSerialized(raw));
    },
  },
  memory: {
    // 记忆页全栈 bridge(phase3-contract 6.9 / ):通道名/参数形状取
    // shared/memory-api 单一事实源;invoke 包装 + SerializedResult →
    // LorraResult(toView,与其余 bridge 同构)。无 confirm/reject 通道
    // (闸门拆除);edit = update 语义,listEvents = 审计视图数据源。
    listActive: async (args: ListActiveArgs) => {
      const raw = (await ipcRenderer.invoke(MEMORY_CHANNEL_LIST_ACTIVE, args)) as SerializedResult<
        MemoryEntry[]
      >;
      return toView(fromSerialized(raw));
    },
    listArchived: async () => {
      const raw = (await ipcRenderer.invoke(MEMORY_CHANNEL_LIST_ARCHIVED)) as SerializedResult<
        MemoryEntry[]
      >;
      return toView(fromSerialized(raw));
    },
    listEvents: async (args: ListEventsArgs) => {
      const raw = (await ipcRenderer.invoke(MEMORY_CHANNEL_LIST_EVENTS, args)) as SerializedResult<
        MemoryEvent[]
      >;
      return toView(fromSerialized(raw));
    },
    listLinks: async () => {
      const raw = (await ipcRenderer.invoke(MEMORY_CHANNEL_LIST_LINKS)) as SerializedResult<
        MemoryLink[]
      >;
      return toView(fromSerialized(raw));
    },
    edit: async (args: EditArgs) => {
      const raw = (await ipcRenderer.invoke(
        MEMORY_CHANNEL_EDIT,
        args,
      )) as SerializedResult<MemoryEntry>;
      return toView(fromSerialized(raw));
    },
    retire: async (args: RetireArgs) => {
      const raw = (await ipcRenderer.invoke(
        MEMORY_CHANNEL_RETIRE,
        args,
      )) as SerializedResult<MemoryEntry>;
      return toView(fromSerialized(raw));
    },
    search: async (args: SearchArgs) => {
      const raw = (await ipcRenderer.invoke(MEMORY_CHANNEL_SEARCH, args)) as SerializedResult<
        MemoryEntry[]
      >;
      return toView(fromSerialized(raw));
    },
    // 6.13 素材消化 + 用户结晶(「记住这段」):原文不落库,产物直落 active。
    digestText: async (args: DigestTextArgs) => {
      const raw = (await ipcRenderer.invoke(MEMORY_CHANNEL_DIGEST_TEXT, args)) as SerializedResult<{
        entryId: string;
      }>;
      return toView(fromSerialized(raw));
    },
    digestFile: async (args: DigestFileArgs) => {
      const raw = (await ipcRenderer.invoke(MEMORY_CHANNEL_DIGEST_FILE, args)) as SerializedResult<{
        entryId: string;
      }>;
      return toView(fromSerialized(raw));
    },
    crystallize: async (args: CrystallizeArgs) => {
      const raw = (await ipcRenderer.invoke(MEMORY_CHANNEL_CRYSTALLIZE, args)) as SerializedResult<{
        entryId: string;
      }>;
      return toView(fromSerialized(raw));
    },
    // :知识库文档读取(记忆页「查看文档」跳转 OFK memory/<entryId>.md)。
    readDocument: async (path: string) => {
      const raw = (await ipcRenderer.invoke(KNOWLEDGE_CHANNEL_READ, { path })) as SerializedResult<{
        content: string | null;
      }>;
      return toView(fromSerialized(raw));
    },
  },
  plugins: {
    // 数据源插件清单:设置页只读展示;每次调用现加载。
    list: async () => {
      const raw = (await ipcRenderer.invoke('lorra.plugins.list')) as SerializedResult<{
        plugins: Array<{
          name: string;
          runtime: string;
          description: string;
          status: 'ok' | 'error';
          error?: string;
        }>;
      }>;
      return toView(fromSerialized(raw));
    },
  },
};

contextBridge.exposeInMainWorld('lorra', lorra);

export type LorraApi = typeof lorra;
