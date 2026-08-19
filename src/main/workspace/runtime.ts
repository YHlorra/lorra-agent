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
 * Driver 池(D4, 2026-08-19 session-reliability-multi-session):
 * 每工作区一个持久 `LorraDriver` 条目(池化,不随切换销毁)。切换工作区只是
 * 移动 active 指针,旧 driver 的后台会话继续运行;切回时复用池内条目并自动
 * 把 wc 重新绑定到该 driver 的 router(后台进度切回即见)。全量收尾由
 * `disposeAll` 在 `main.ts` before-quit 统一执行。
 *
 * `attachWindow(wc)` is the bridge between Electron's BrowserWindow and the
 * driver-side EventRouter. Without it, agent events emitted by the SDK have
 * zero subscribers and are dropped before reaching the renderer — the
 * "input clears, conversation never starts" symptom. The runtime holds the
 * wc references so they automatically re-attach when the active driver
 * changes on a workspace switch.
 */
export interface WorkspaceRuntime {
  /** Current workspace path; null on first launch before any pick. */
  getActivePath(): string | null;
  /** Current driver; null when no workspace is active. */
  getActiveDriver(): LorraDriver | null;
  /** Subscribe to activation changes. Returns an unsubscribe function. */
  onChange(cb: (path: string | null) => void): () => void;
  /** Activate a workspace, building a fresh driver (or reusing the pool). */
  activate(workspacePath: string): Promise<void>;
  /** Drop the active workspace; used by the titlebar switch button. */
  deactivate(): Promise<void>;
  /**
   * Shut down every pooled driver and dispose every extractor. Called by
   * `main.ts` on `before-quit`; the app is exiting so all resources are
   * released.
   */
  disposeAll(): Promise<void>;
  /**
   * Register a window so its webContents receives agent events from the
   * current driver (and re-binds when the active driver changes on
   * workspace switch). Idempotent per wc; returns a detach function.
   */
  attachWindow(wc: WebContents): () => void;
}

/** 池内单工作区条目(D4):driver 与其热记忆提取器同生命周期。 */
interface WorkspaceEntry {
  driver: LorraDriver;
  extractor: HotMemoryExtractor | null;
}

export function createWorkspaceRuntime(): WorkspaceRuntime {
  let currentPath: string | null = null;
  let currentDriver: LorraDriver | null = null;
  // D4:工作区 → 持久条目池。切换只动 active 指针,池内 driver/extractor 存活。
  const pool = new Map<string, WorkspaceEntry>();
  // OFK 热同步:会话活动 → 防抖写概念文档(facts.db 已随 P2 删除)。
  const ofkHotSyncer = createOfkHotSyncer();
  const listeners = new Set<(path: string | null) => void>();
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
      // D4:池中命中 → 直接置 active,不重建 driver、不 shutdown 后台会话。
      const pooled = pool.get(workspacePath);
      if (pooled) {
        setActiveDriver(workspacePath, pooled.driver);
        return;
      }
      // 记忆维护技能播种:工作区首次激活时一次,缺失才写、存在原样用。
      // 生成链路外(技能由模型读取对照),失败静默——不阻塞工作区激活。
      seedMemoryMaintenanceSkill(workspacePath);
      // OFK 摘要编译技能播种:同 write-if-missing 纪律,失败静默。
      seedOfkDigestSkill(workspacePath);
      // lorra 元技能已迁全局路径(2026-08-18):由启动期 seedBuiltinSkills 落
      // ~/.lorra/skills/,此处不再 per-workspace 播种。(→删除该段)
      // D6(并发归属):池化后后台工作区的会话事件必须回到「自己的 driver」,
      // 不能用全局 active driver 解析——每个 activate 闭包持一个本工作区
      // driverRef,persistence/extractor 回调经它路由(persistence 先于 driver
      // 构造,故先声明后赋值)。
      let driverRef: LorraDriver | null = null;
      const persistence = await createSessionPersistence({
        workspacePath,
        // Chromium network stack (system trust store + proxy handling);
        // the Node global fetch in Electron main can fail TLS on some
        // networks where net.fetch succeeds.
        fetcher: (url, init) => net.fetch(url, init),
        emitBlocked: (payload) => {
          const driver = driverRef;
          if (!driver || !payload.sessionId) return;
          driver.emitToolBlocked(payload.sessionId, payload);
        },
        // 编辑历史:driver 在 activate 之后才构造,钩子经 driverRef 惰性解析。
        recordEditBefore: (payload) => {
          driverRef?.recordEditBefore(payload);
        },
        finalizeEdit: (payload) => {
          driverRef?.finalizeEdit(payload);
        },
        // 分级审批:同上,经 driverRef 解析到本工作区 driver 的审批注册表;
        // 返回裁决 Promise(拦截器 await 挂起直到用户裁决)。
        requestApproval: (payload) =>
          driverRef?.requestApproval(payload) ?? Promise.resolve('deny'),
        checkApproved: (toolName, target) => driverRef?.checkApproved(toolName, target) ?? false,
        // 记忆写入成功(/D6):memory 工具 propose/update 成功 →
        // 经 driver router 发 'memory.recorded' 事件(渲染端只读通知条消费)。
        emitMemoryRecorded: (payload) => {
          driverRef?.emitMemoryRecorded(payload);
        },
      });
      // 会话自动记忆提取器:活动事件防抖 → 增量段模型提取 → 落库。
      // store 经动态 import 装载共享单例(node:sqlite 不进 vitest client 测试图,
      // 与 propose-memory-tool 注册处同款纪律);emitRecorded 经 driver router
      // 发 'memory.recorded'(渲染端通知条),惰性 driverRef 解析(文件既有模式)。
      const hotMemoryExtractor = createHotMemoryExtractor(workspacePath, {
        invoke: createCompileModelInvoke(),
        getStore: async () => {
          const { getSharedMemoryStore } = await import('../memory/shared-memory-store');
          const shared = getSharedMemoryStore();
          if (shared.isErr()) throw shared.error;
          return shared.value;
        },
        emitRecorded: (payload) => {
          driverRef?.emitMemoryRecorded(payload);
        },
        workspace: workspacePath,
      });
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
      driverRef = driver;
      // D4:并入池;提取器随条目存活,disposeAll 时统一清(不随切换销毁)。
      pool.set(workspacePath, { driver, extractor: hotMemoryExtractor });
      setActiveDriver(workspacePath, driver);
    },
    async deactivate(): Promise<void> {
      // D4:deactivate 仅清 active 指针;池内 driver/extractor 保持存活
      // (后台会话继续运行,切回即复用)。
      setActiveDriver(null, null);
    },
    async disposeAll(): Promise<void> {
      // D4:全量收尾(before-quit 主入口)。先清提取器停掉 pending 计时器,
      // 再 shutdown 各 driver(有界:SessionRegistry.shutdownAll 2s 竞速 + dispose)。
      for (const entry of pool.values()) {
        entry.extractor?.dispose();
        try {
          await entry.driver.shutdownAll();
        } catch {
          // Driver teardown is best-effort; the app is quitting anyway.
        }
      }
      pool.clear();
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
  return runtime;
}
