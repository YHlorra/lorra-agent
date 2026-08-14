/// <reference types="vite/client" />

declare module 'electron-squirrel-startup';

interface LorraWindowApi {
  minimize(): Promise<boolean>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<boolean>;
}

interface LorraWorkspaceApi {
  pick(): Promise<{ path: string | null }>;
  switch(): Promise<{ path: string | null }>;
  get(): Promise<{ path: string | null }>;
  /** 按路径激活最近工作区(顶栏 tab 点击),不弹目录选择框。 */
  activate(path: string): Promise<{ path: string | null }>;
  /** 最近工作区列表(顶栏 tab 条数据源;首项为当前激活)。 */
  list(): Promise<{ workspaces: string[] }>;
  /** 移除最近工作区记录(设置页「最近工作区」列表);不处理激活项。 */
  remove(path: string): Promise<{ workspaces: string[] }>;
}

type RpcEnvelope<T> = import('./shared/result').LorraResult<T>;

interface LorraSessionInfo {
  id: string;
  name?: string;
  cwd: string;
  path: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

interface LorraSessionApi {
  list(args: { workspaceId: string }): Promise<RpcEnvelope<LorraSessionInfo[]>>;
  open(args: { sessionId: string }): Promise<RpcEnvelope<{ sessionId: string }>>;
  continueRecent(args: { workspaceId: string }): Promise<RpcEnvelope<{ sessionId: string }>>;
  create(args: { workspaceId: string }): Promise<RpcEnvelope<{ sessionId: string }>>;
  send(args: {
    sessionId: string;
    text: string;
  }): Promise<RpcEnvelope<{ accepted: boolean; busySessionId?: string }>>;
  abort(args: { sessionId: string }): Promise<RpcEnvelope<true>>;
  compact(args: { sessionId: string }): Promise<RpcEnvelope<{ accepted: boolean }>>;
  respondApproval(args: {
    sessionId: string;
    approvalId: string;
    decision: 'allowOnce' | 'allowAlways' | 'deny';
  }): Promise<RpcEnvelope<true>>;
}

interface LorraFsApi {
  tree(args: {
    directoryId: string;
    depth?: number;
  }): Promise<
    RpcEnvelope<Array<{ id: string; name: string; type: 'file' | 'dir'; hasChildren: boolean }>>
  >;
  search(args: {
    query: string;
    limit?: number;
  }): Promise<RpcEnvelope<Array<{ fileId: string; name: string }>>>;
  open(args: {
    fileId: string;
  }): Promise<RpcEnvelope<{ content: string; mtime: number; size: number }>>;
  openBinary(args: { fileId: string }): Promise<RpcEnvelope<{ data: Uint8Array }>>;
  save(args: {
    fileId: string;
    content: string;
    baseMtime?: number;
  }): Promise<RpcEnvelope<{ mtime: number }>>;
  /** 素材消化(3b 6.13):系统对话框选文件,取消返回 null。 */
  pickFile(): Promise<RpcEnvelope<string | null>>;
}

// Annotation DTO 与 src/shared/annotations.ts 同源(renderer 可直连共享类型)。
type AnnotationDto = import('./shared/annotations').Annotation;
type AnnotationDraftDto = import('./shared/annotations').AnnotationDraft;

interface LorraAnnotationsApi {
  list(args: { fileId: string }): Promise<RpcEnvelope<AnnotationDto[]>>;
  save(args: { fileId: string; annotation: AnnotationDraftDto }): Promise<RpcEnvelope<void>>;
  remove(args: { fileId: string; id: string }): Promise<RpcEnvelope<void>>;
}

interface LorraEventsApi {
  subscribe(cb: (event: unknown) => void): () => void;
}

// Model-config DTOs mirror src/preload.ts / model-config.ts. Re-declared inline
// (not imported from main/) to match the existing window.lorra typing style.
type ProviderGroup = 'popular' | 'all';

interface ProviderDto {
  id: string;
  name: string;
  group: ProviderGroup;
  modelCount: number;
  auth: { apiKey: boolean; oauth: boolean };
  available: boolean;
  reason?: 'oauth-only';
}

type ConnectionMethod = 'apiKey' | 'environment' | 'custom';

interface ConnectedProviderDto {
  id: string;
  name: string;
  connectionMethod: ConnectionMethod;
  modelCount: number;
}

interface ModelDto {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  enabled: boolean;
  default: boolean;
  available: boolean;
}

interface CustomProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
  }>;
  headers?: Record<string, string>;
}

interface LorraProvidersApi {
  catalog(): Promise<RpcEnvelope<ProviderDto[]>>;
  list(): Promise<RpcEnvelope<ConnectedProviderDto[]>>;
  connect(args: { providerId: string; material?: string }): Promise<RpcEnvelope<void>>;
  disconnect(args: { providerId: string }): Promise<RpcEnvelope<void>>;
  getAuthStatus(args: { providerId: string }): Promise<
    RpcEnvelope<{
      configured: boolean;
      source?:
        | 'stored'
        | 'runtime'
        | 'environment'
        | 'fallback'
        | 'models_json_key'
        | 'models_json_command';
      label?: string;
    }>
  >;
  testConnection(args: { providerId: string }): Promise<RpcEnvelope<void>>;
  custom: {
    add(input: CustomProviderInput): Promise<RpcEnvelope<void>>;
    remove(args: { providerId: string }): Promise<RpcEnvelope<void>>;
  };
}

interface LorraModelsApi {
  list(args: { providerId?: string }): Promise<RpcEnvelope<ModelDto[]>>;
  getDefault(): Promise<RpcEnvelope<{ providerId: string; modelId: string } | null>>;
  setDefault(args: { providerId: string; modelId: string }): Promise<RpcEnvelope<void>>;
  toggle(args: {
    providerId: string;
    modelId: string;
    enabled: boolean;
  }): Promise<RpcEnvelope<void>>;
  getAvailable(): Promise<RpcEnvelope<ModelDto[]>>;
}

interface LorraEditsApi {
  revert(args: { editId: string }): Promise<RpcEnvelope<{ fileId: string }>>;
  accept(args: { editId: string }): Promise<RpcEnvelope<{ fileId: string }>>;
  list(args: { sessionId?: string }): Promise<
    RpcEnvelope<
      Array<{
        id: string;
        sessionId: string;
        toolName: 'write' | 'edit';
        fileId: string;
        ts: number;
        status: 'applied' | 'accepted' | 'reverted';
        kind: 'git' | 'snapshot';
      }>
    >
  >;
}

interface LorraAppApi {
  /** 应用元信息(设置页「关于」组数据源)。 */
  info(): Promise<{ version: string; name: string }>;
  /** 开源项目清单(设置页「关于 → 开源项目」数据源)。 */
  licenses(): Promise<OpenSourceProject[]>;
}

/** 开源项目条目(与 src/shared/licenses-api.ts 同构,inline 声明风格)。 */
interface OpenSourceProject {
  name: string;
  version: string;
  license: string;
  homepage: string | null;
  repository: string | null;
}

interface LorraSettingsApi {
  get(): Promise<
    RpcEnvelope<{
      showHiddenFiles: boolean;
      language: Lang;
      defaultHideThinking: boolean;
      compileModel: { providerId: string; modelId: string } | null;
      dataSources: { claudeCode: boolean; opencode: boolean; ohMyPi: boolean; workbuddy: boolean };
    }>
  >;
  set(args: {
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
  }): Promise<RpcEnvelope<void>>;
}

// ── 今日页只读投影(agent-memory-today-timeline)──
// 类型单一事实源:渲染层 type-only 引用共享 schema(facts-schema)与后端
// day-summary 导出;不在此重复定义(审查 #9)。
type TodaySessionFactDto = import('./shared/facts-schema').SessionFact;
type TodayDayDataDto = import('./main/memory/day-summary').TodayDayData;
type TodayWorkspaceStatDto = import('./main/memory/day-summary').TodayWorkspaceStat;

interface LorraTodayApi {
  getDayFacts(
    dateISO?: string,
  ): Promise<import('./shared/result').SerializedResult<TodayDayDataDto>>;
  /** S6:后台摘要编译完成推送(数据过期打开今日页 → 编译完成自动刷新);返回退订函数。 */
  onDayCompiled(cb: () => void): () => void;
}

// ── 复盘引擎(review-rail / review-modal)──
// 只读消费:生成/列表/阅读经 IPC 走事实层与复盘存档,modal 渲染只读 markdown。
// 契约类型单一事实源 src/shared/review-api.ts(与 preload 同源,防层间漂移)。
interface LorraReviewApi {
  generate(
    req: import('./shared/review-api').GenerateArgs,
  ): Promise<import('./shared/result').SerializedResult<import('./shared/review-api').ReviewMeta>>;
  list(): Promise<
    import('./shared/result').SerializedResult<import('./shared/review-api').ReviewMeta[]>
  >;
  read(
    args: import('./shared/review-api').ReadArgs,
  ): Promise<
    import('./shared/result').SerializedResult<import('./shared/review-api').StoredReview>
  >;
}

// ── 技能管理页(skill-manager V1 / 拟议 )──
// 契约类型单一事实源 src/shared/skills-api.ts(通道常量/类型);preload bridge
// 与声明同源防漂移。信封 = SerializedResult(与 today 同款直透,渲染端按 status
// 判别消费)。
type SkillXrayDto = import('./shared/skills-api').SkillXray;

interface LorraSkillsApi {
  xray(): Promise<import('./shared/result').SerializedResult<SkillXrayDto>>;
  setEnabled(
    name: string,
    enabled: boolean,
  ): Promise<import('./shared/result').SerializedResult<void>>;
  cleanDangling(
    wsPath: string,
  ): Promise<import('./shared/result').SerializedResult<{ cleaned: number }>>;
  // 2026-08-13 批:收集 / 更新 / 按工作区停用(安装已迁移为对话内 install_skill 工具)。
  collect(
    wsPath?: string,
  ): Promise<
    import('./shared/result').SerializedResult<import('./shared/skills-api').CollectResult>
  >;
  checkUpdates(): Promise<
    import('./shared/result').SerializedResult<
      Record<string, import('./shared/skills-api').SkillGitStatus>
    >
  >;
  updateAll(): Promise<
    import('./shared/result').SerializedResult<{ updated: string[]; skipped: string[] }>
  >;
  setWsEnabled(
    name: string,
    enabled: boolean,
    wsPath?: string,
  ): Promise<import('./shared/result').SerializedResult<void>>;
}

// ── 记忆页(memory-page, 6.9 / )──
// 契约类型单一事实源 src/shared/memory-api.ts(通道名/参数形状)与
// src/shared/memory-schema.ts(MemoryEntry/MemoryEvent 形状);preload bridge
// 与声明同源防漂移。无 confirm/reject(闸门拆除),listEvents = 审计视图。
type MemoryEntryDto = import('./shared/memory-schema').MemoryEntry;
type MemoryEventDto = import('./shared/memory-schema').MemoryEvent;

interface LorraMemoryApi {
  listActive(
    args: import('./shared/memory-api').ListActiveArgs,
  ): Promise<RpcEnvelope<MemoryEntryDto[]>>;
  listArchived(): Promise<RpcEnvelope<MemoryEntryDto[]>>;
  listEvents(
    args: import('./shared/memory-api').ListEventsArgs,
  ): Promise<RpcEnvelope<MemoryEventDto[]>>;
  listLinks(): Promise<RpcEnvelope<import('./shared/memory-api').MemoryLink[]>>;
  edit(args: import('./shared/memory-api').EditArgs): Promise<RpcEnvelope<MemoryEntryDto>>;
  retire(args: import('./shared/memory-api').RetireArgs): Promise<RpcEnvelope<MemoryEntryDto>>;
  search(args: import('./shared/memory-api').SearchArgs): Promise<RpcEnvelope<MemoryEntryDto[]>>;
  // 6.13 素材消化 + 用户结晶(「记住这段」); ingest 编译结果面。
  digestText(
    args: import('./shared/memory-api').DigestTextArgs,
  ): Promise<RpcEnvelope<import('./shared/memory-api').DigestResult>>;
  digestFile(
    args: import('./shared/memory-api').DigestFileArgs,
  ): Promise<RpcEnvelope<import('./shared/memory-api').DigestResult>>;
  crystallize(
    args: import('./shared/memory-api').CrystallizeArgs,
  ): Promise<RpcEnvelope<{ entryId: string }>>;
  /** 知识库文档读取:path 为 bundle 相对路径。 */
  readDocument(path: string): Promise<RpcEnvelope<{ content: string | null }>>;
}

type Lang = import('./shared/i18n-core').Lang;

interface LorraApi {
  platform: NodeJS.Platform;
  app: LorraAppApi;
  window: LorraWindowApi;
  workspace: LorraWorkspaceApi;
  session: LorraSessionApi;
  fs: LorraFsApi;
  annotations: LorraAnnotationsApi;
  edits: LorraEditsApi;
  events: LorraEventsApi;
  providers: LorraProvidersApi;
  models: LorraModelsApi;
  settings: LorraSettingsApi;
  today: LorraTodayApi;
  review: LorraReviewApi;
  memory: LorraMemoryApi;
  skills: LorraSkillsApi;
  plugins: LorraPluginsApi;
}

interface LorraPluginsApi {
  /** 数据源插件清单;每次调用现加载。 */
  list(): Promise<
    RpcEnvelope<{
      plugins: Array<{
        name: string;
        runtime: string;
        description: string;
        status: 'ok' | 'error';
        error?: string;
      }>;
    }>
  >;
}

interface Window {
  lorra: LorraApi;
}
