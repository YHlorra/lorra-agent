import { net, type WebContents } from 'electron';
import { createHotMemoryExtractor, type HotMemoryExtractor } from '../memory/hot-memory-extractor';
import { seedMemoryMaintenanceSkill } from '../memory/memory-maintenance-seed';
import { createCompileModelInvoke } from '../memory/review-model';
import { seedOfkDigestSkill } from '../ofk/digest-seed';
import { createOfkHotSyncer } from '../ofk/ofk-hot-syncer';
import type { LorraDriver } from '../pi-sdk-driver';
import { LorraDriver as LorraDriverImpl } from '../pi-sdk-driver';
import { createSessionPersistence } from '../pi-sdk-driver/session-persistence';

/**
 * 会话自动记忆提取总开关:false 时 onSessionActivity 只跑事实
 * 增量清洗,不触发提取模型调用(成本开关;设置 UI 留展示阶段,本批常量控制)。
 */
const MEMORY_EXTRACTION_ENABLED = true;

/**
 * Workspace activation runtime — single source of truth for the active
 * workspace path and the corresponding `LorraDriver`. Created once at app
 * startup; mutates on `lorra.workspace.pick` and the titlebar "switch
 * workspace" action so the chat bar and provider entry actually attach to a
 * real session even when the user picks a workspace after first launch.
 *
 * IPC handlers read this through getters; the driver is rebuilt (old one
 * shutdown) whenever the workspace changes so per-workspace resources
 * (SessionManager, ExtensionRunner) do not leak across switches.
 *
 * `attachWindow(wc)` is the bridge between Electron's BrowserWindow and the
 * driver-side EventRouter. Without it, agent events emitted by the SDK have
 * zero subscribers and are dropped before reaching the renderer — the
 * "input clears, conversation never starts" symptom. The runtime holds the
 * wc references so they automatically re-attach when the driver rebuilds on
 * a workspace switch (the new driver has its own empty attachedWebContents).
 */
export interface WorkspaceRuntime {
  /** Current workspace path; null on first launch before any pick. */
  getActivePath(): string | null;
  /** Current driver; null when no workspace is active. */
  getActiveDriver(): LorraDriver | null;
  /** Subscribe to activation changes. Returns an unsubscribe function. */
  onChange(cb: (path: string | null) => void): () => void;
  /** Activate a workspace, building a fresh driver. */
  activate(workspacePath: string): Promise<void>;
  /** Drop the active workspace; used by the titlebar switch button. */
  deactivate(): Promise<void>;
  /**
 * Register a window so its webContents receives agent events from the
 * current driver (and re-binds when the driver is rebuilt on workspace
 * switch). Idempotent per wc; returns a detach function for symmetry.
 */
  attachWindow(wc: WebContents): () => void;
}

export function createWorkspaceRuntime(): WorkspaceRuntime {
  let currentPath: string | null = null;
  let currentDriver: LorraDriver | null = null;
  // OFK 热同步:会话活动 → 防抖写概念文档(facts.db 已随 P2 删除)。
  const ofkHotSyncer = createOfkHotSyncer();
  // 会话自动记忆提取器(H3 dispose 主入口):工作区切换时旧 extractor 的
  // pending 计时器必须被清,否则旧工作区会话的活动仍会触发提取。
  let currentExtractor: HotMemoryExtractor | null = null;
  const listeners = new Set<(path: string | null) => void>();
  // Self-reference so callbacks registered during activate resolve
  // drivers through the public getter, not a captured (possibly stale)
  // closure variable.
  let self: WorkspaceRuntime | undefined;
  // Windows (webContents) registered by main.ts. Driver is rebuilt on
  // workspace switch, so the runtime — not any single driver — owns this
  // list and rebinds wc → new driver on every setActiveDriver.
  const attachedWcs = new Set<WebContents>();
  const wcDetach = new WeakMap<WebContents, () => void>();

  function bindWcToDriver(wc: WebContents): void {
    if (wc.isDestroyed()) return;
    const prev = wcDetach.get(wc);
    if (prev) prev();
    wcDetach.delete(wc);
    if (currentDriver) {
      const detach = currentDriver.attachWebContents(wc);
      wcDetach.set(wc, detach);
    }
  }

  function emit(): void {
    for (const cb of listeners) cb(currentPath);
    for (const wc of attachedWcs) bindWcToDriver(wc);
  }

  function setActiveDriver(path: string | null, driver: LorraDriver | null): void {
    currentPath = path;
    currentDriver = driver;
    emit();
  }

  const runtime: WorkspaceRuntime = {
    getActivePath: () => currentPath,
    getActiveDriver: () => currentDriver,
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async activate(workspacePath: string): Promise<void> {
      // H3 生命周期收口:工作区切换(直接 activate)时旧 extractor 必须先 dispose
      // (全仓无 runtime.deactivate 调用方,这里是主入口)——否则旧工作区 pending
      // 计时器在切换后仍触发提取。
      currentExtractor?.dispose();
      currentExtractor = null;
      if (currentDriver) {
        try {
          await currentDriver.shutdownAll();
        } catch {
          // Driver teardown is best-effort; we still rebuild on top.
        }
      }
      // 记忆维护技能播种:工作区激活时一次,缺失才写、存在原样用。
      // 生成链路外(技能由模型读取对照),失败静默——不阻塞工作区激活。
      seedMemoryMaintenanceSkill(workspacePath);
      // OFK 摘要编译技能播种:同 write-if-missing 纪律,失败静默。
      seedOfkDigestSkill(workspacePath);
      const persistence = await createSessionPersistence({
        workspacePath,
        // Chromium network stack (system trust store + proxy handling);
        // the Node global fetch in Electron main can fail TLS on some
        // networks where net.fetch succeeds.
        fetcher: (url, init) => net.fetch(url, init),
        emitBlocked: (payload) => {
          const driver = self?.getActiveDriver();
          const activeSessionId = driver?.getActiveSessionId();
          if (!activeSessionId || !driver) return;
          driver.emitToolBlocked(activeSessionId, payload);
        },
        // 编辑历史:driver 在 activate 之后才构造,钩子经 getter 惰性解析。
        recordEditBefore: (payload) => {
          self?.getActiveDriver()?.recordEditBefore(payload);
        },
        finalizeEdit: (payload) => {
          self?.getActiveDriver()?.finalizeEdit(payload);
        },
        // 分级审批:同上,经 getter 解析到 driver 的审批注册表;
        // 返回裁决 Promise(拦截器 await 挂起直到用户裁决)。
        requestApproval: (payload) =>
          self?.getActiveDriver()?.requestApproval(payload) ?? Promise.resolve('deny'),
        checkApproved: (toolName, target) =>
          self?.getActiveDriver()?.checkApproved(toolName, target) ?? false,
        // 记忆写入成功(/D6):memory 工具 propose/update 成功 →
        // 经 driver router 发 'memory.recorded' 事件(渲染端只读通知条消费)。
        emitMemoryRecorded: (payload) => {
          self?.getActiveDriver()?.emitMemoryRecorded(payload);
        },
      });
      // 会话自动记忆提取器:活动事件防抖 → 增量段模型提取 → 落库。
      // store 经动态 import 装载共享单例(node:sqlite 不进 vitest client 测试图,
      // 与 propose-memory-tool 注册处同款纪律);emitRecorded 经 driver router
      // 发 'memory.recorded'(渲染端通知条),惰性 getter 解析(文件既有模式)。
      const hotMemoryExtractor = createHotMemoryExtractor(workspacePath, {
        invoke: createCompileModelInvoke(),
        getStore: async () => {
          const { getSharedMemoryStore } = await import('../memory/shared-memory-store');
          const shared = getSharedMemoryStore();
          if (shared.isErr()) throw shared.error;
          return shared.value;
        },
        emitRecorded: (payload) => {
          self?.getActiveDriver()?.emitMemoryRecorded(payload);
        },
        workspace: workspacePath,
      });
      // H3:activate 期间立即接管(dispose 主入口在 activate 开头,此处确保
      // 新 extractor 与当前工作区绑定,onSessionActivity 经它触发)。
      currentExtractor = hotMemoryExtractor;
      const driver = new LorraDriverImpl({
        workspacePath,
        persistence,
        // 热会话增量:活动事件 → 防抖重清洗 → 写入事实库。
        // fact.workspace 以会话头 header.cwd 为准(collector 内解析);
        // 这里传真实工作区路径仅作 header.cwd 缺失时的兜底。
        onSessionActivity: (sessionFile) => {
          ofkHotSyncer.sync(sessionFile, workspacePath);
          // 会话自动提取:防抖后对 jsonl 增量段跑记忆提取(第五写入
          // 通道 session-extraction)。开关关闭时只跑事实清洗。
          if (MEMORY_EXTRACTION_ENABLED) hotMemoryExtractor.trigger(sessionFile);
        },
      });
      setActiveDriver(workspacePath, driver);
    },
    async deactivate(): Promise<void> {
      // H3 防御性双保险:显式 deactivate 时也清 extractor(activate 开头是主入口)。
      currentExtractor?.dispose();
      currentExtractor = null;
      if (currentDriver) {
        try {
          await currentDriver.shutdownAll();
        } catch {
          // same teardown tolerance as activate
        }
      }
      setActiveDriver(null, null);
    },
    attachWindow(wc: WebContents): () => void {
      if (wc.isDestroyed()) return () => {};
      attachedWcs.add(wc);
      bindWcToDriver(wc);
      const cleanup = () => {
        const d = wcDetach.get(wc);
        if (d) d();
        wcDetach.delete(wc);
        attachedWcs.delete(wc);
      };
      // Real Electron WebContents is an EventEmitter; in tests the stub is
      // not, so use optional chaining — worst case cleanup still runs on
      // manual detach.
      wc.once?.('destroyed', cleanup);
      return cleanup;
    },
  };
  self = runtime;
  return runtime;
}
