import { Minus, Moon, PanelLeftClose, PanelLeftOpen, Square, Sun, X } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useAppStore } from '@/lib/app-store';
import type { SlashCommandName } from '@/lib/slash-commands';
import { applyThemeClass } from '@/lib/theme';
import type { AgentEvent, SessionStatus } from '../shared/agent-events';
import type { Annotation, AnnotationDraft } from '../shared/annotations';
import type { SerializedResult } from '../shared/result';
import type { ReviewMeta } from '../shared/review-api';
import { AppShell } from './app-shell';
import { ChatPane } from './chat-pane';
import { CommandPalette, useCommandPalette } from './command-palette';
import type { ComposerReference } from './composer';
import { type DocumentFileState, DocumentViewer } from './document-viewer';
import { useT } from './lib/i18n';
import { MemoryPage } from './memory-page';
import { useChatModelState } from './model-hooks';
import { PluginsPage } from './plugins-page';
import { ProvidersPage } from './providers-page';
import { deriveIndicator, initialReducerState, reducer, type SessionIndicator } from './reducer';
import { SettingsPage } from './settings-page';
import { ShortcutsDialog } from './shortcuts-dialog';
import { Sidebar } from './sidebar';
import { TodayPage } from './today-page';
import { WorkspaceTabs } from './workspace-tabs';
import './styles.css';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

const EMPTY_EVENTS: AgentEvent[] = [];

export function App(): JSX.Element {
  const t = useT();
  // 窄视口(<1050px)折叠侧栏:三栏改为两栏(resizable-panels 条件挂载,替代原 CSS display:none)。
  const [narrow, setNarrow] = useState(() => {
    try {
      return window.matchMedia?.('(max-width: 1050px)').matches ?? false;
    } catch {
      return false; // jsdom 无 matchMedia,测试走宽视口默认。
    }
  });
  const [workspacePath, setWorkspacePath] = useState<string | null | undefined>(undefined);
  // 最近工作区列表(顶栏 tab 条数据源;首项 = 当前激活)。
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [state, dispatch] = useReducer(reducer, undefined, initialReducerState);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [activeFileName, setActiveFileName] = useState<string | null>(null);
  const [file, setFile] = useState<DocumentFileState>({ status: 'idle' });
  // 当前文件的划线/笔记 + 「问 AI」引用胶囊(单选替换,不做多胶囊)。
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [references, setReferences] = useState<ComposerReference[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionHistory, setSessionHistory] = useState<LorraSessionInfo[]>([]);
  const [sessionBootstrapping, setSessionBootstrapping] = useState(false);
  // 斜杠命令(pi TUI)反馈条与快捷键对话框。
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // 阅读编辑合一:编辑期间跳过 tool.end 自动重取(AI 写盘不冲掉用户编辑)。
  const [isEditingFile, setIsEditingFile] = useState(false);
  const sessionState = activeSessionId ? state.sessions[activeSessionId] : undefined;
  // 会话栏状态指示灯(2026-08-19):红=卡住/黄=近期空闲/绿=运行中/灰=无新活动。
  // 卡住(90s 无新事件)与「近期空闲→灰」都依赖「当前时间 - 最后事件」,事件驱动重渲染
  // 不会推进时间,故存在会随时间变化的态(running/idle)时用 15s tick 触发重判
  // (stuck 是稳定红,不含)。
  const [staleTick, setStaleTick] = useState(0);
  const sessionIndicators = useMemo(() => {
    const now = Date.now();
    const out: Record<string, SessionIndicator> = {};
    for (const [sid, s] of Object.entries(state.sessions)) out[sid] = deriveIndicator(s, now);
    return out;
    // staleTick 仅驱动超时重判;state.sessions 引用随事件更新,两者都在 deps。
  }, [state.sessions, staleTick]);
  const hasTimeSensitiveState = Object.values(sessionIndicators).some(
    (i) => i === 'running' || i === 'idle',
  );
  useEffect(() => {
    if (!hasTimeSensitiveState) return;
    const id = window.setInterval(() => setStaleTick((t) => t + 1), 15_000);
    return () => window.clearInterval(id);
  }, [hasTimeSensitiveState]);
  // 稳定空引用(memo 性能,2026-08-13):无会话时避免每个渲染都换新数组身份。
  const events = sessionState?.events ?? EMPTY_EVENTS;
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const navCollapsed = useAppStore((s) => s.navCollapsed);
  const toggleNav = useAppStore((s) => s.toggleNav);
  // 文件树隐藏项(/ ):状态在 app-store,设置页与工作台共享。
  const showHiddenFiles = useAppStore((s) => s.showHiddenFiles);
  const setShowHiddenFiles = useAppStore((s) => s.setShowHiddenFiles);
  const setDefaultHideThinking = useAppStore((s) => s.setDefaultHideThinking);
  const applyLanguage = useAppStore((s) => s.applyLanguage);
  const chatModel = useChatModelState();
  const palette = useCommandPalette();
  // 三栏宽度持久化(resizable-panels v4):localStorage 保存比例,重启恢复。
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'lorra-workspace-layout',
    panelIds: ['sidebar', 'document', 'chat'],
    onlySaveAfterUserInteractions: true,
  });

  // 主题状态变化 → 同步 html.dark(initTheme 只覆盖首帧,这里兜住后续切换)。
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // 视口跨过 1050px → 实时折叠/展开侧栏(拖动窗口宽度即可触发)。
  useEffect(() => {
    let mql: MediaQueryList | null = null;
    try {
      mql = window.matchMedia?.('(max-width: 1050px)') ?? null;
    } catch {
      mql = null;
    }
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  // 文件树隐藏项 + 界面语言真源(/ ):启动时从 settings.json 读,
  // 写入 store;语言与 localStorage 缓存漂移时以 settings 为准校正(不触发 IPC 回写)。
  useEffect(() => {
    let cancelled = false;
    void window.lorra.settings
      .get()
      .then((result) => {
        if (cancelled || !result.ok) return;
        setShowHiddenFiles(result.value.showHiddenFiles);
        setDefaultHideThinking(result.value.defaultHideThinking);
        const currentLanguage = useAppStore.getState().language;
        if (result.value.language && result.value.language !== currentLanguage) {
          applyLanguage(result.value.language);
        }
      })
      .catch(() => {
        if (!cancelled) setShowHiddenFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setShowHiddenFiles, applyLanguage, setDefaultHideThinking]);

  // Section 3.5 / 3.6: on mount, ask the main process for the active workspace.
  useEffect(() => {
    let cancelled = false;
    void window.lorra.workspace
      .get()
      .then((result) => {
        if (!cancelled) setWorkspacePath(result.path);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspacePath(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 顶栏 tab 条数据源:最近工作区列表(首次进入也作为工作区选择旁路)。
  useEffect(() => {
    let cancelled = false;
    void window.lorra.workspace
      .list()
      .then((result) => {
        if (!cancelled) setRecentWorkspaces(result.workspaces);
      })
      .catch(() => {
        if (!cancelled) setRecentWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  /** 按路径激活工作区(顶栏 tab 点击):主进程重建 driver,渲染端重置会话/文件态。 */
  const activateWorkspace = useCallback(
    async (path: string) => {
      if (!path || path === workspacePath) return;
      const result = await window.lorra.workspace.activate(path);
      if (!result.path || result.path === workspacePath) return;
      setActiveFileId(null);
      setActiveFileName(null);
      setActiveSessionId(null);
      setSessionHistory([]);
      setAnnotations([]);
      setReferences([]);
      setWorkspacePath(result.path);
    },
    [workspacePath],
  );

  /**
   * 顶栏 tab「×」:仅从最近工作区列表移除(lorra.workspace.remove 只过滤
   * settings.recentWorkspaces)。数据留在后台,当前激活工作区不受影响,
   * 用户可随时通过「+」重新添加 —— 纯界面减负(2026-08-18)。
   */
  const removeRecentWorkspace = useCallback(async (path: string) => {
    try {
      const result = await window.lorra.workspace.remove(path);
      setRecentWorkspaces(result.workspaces);
    } catch {
      // 移除失败静默:仅影响 tab 条展示,不阻塞工作区功能(设置页有显式错误提示)。
    }
  }, []);

  // Once a workspace is set, create or continue a session and subscribe to events.
  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    const unsubscribe = window.lorra.events.subscribe((event: unknown) => {
      if (event && typeof event === 'object' && 'type' in event) {
        dispatch({ type: 'event-received', event: event as AgentEvent });
      }
    });
    (async () => {
      setSessionBootstrapping(true);
      try {
        const wsId = workspacePath;
        const continued = await window.lorra.session.continueRecent({ workspaceId: wsId });
        const fallback = continued.ok
          ? null
          : await window.lorra.session.create({ workspaceId: wsId });
        const resolved = continued.ok ? continued.value : fallback?.ok ? fallback.value : null;
        if (!resolved || cancelled) return;
        setActiveSessionId(resolved.sessionId);
        dispatch({ type: 'subscribe-session', sessionId: resolved.sessionId });
      } finally {
        if (!cancelled) setSessionBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath) {
      setSessionHistory([]);
      return;
    }
    let cancelled = false;
    void window.lorra.session
      .list({ workspaceId: workspacePath })
      .then((result) => {
        if (!cancelled) setSessionHistory(result.ok ? result.value : []);
      })
      .catch(() => {
        if (!cancelled) setSessionHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  // When the active file changes, fetch its content from the main process.
  useEffect(() => {
    if (!activeFileId) {
      setFile({ status: 'idle' });
      setAnnotations([]);
      return;
    }
    let cancelled = false;
    setFile({ status: 'loading' });
    void window.lorra.fs
      .open({ fileId: activeFileId })
      .then((res) => {
        if (cancelled) return;
        if (res.ok)
          setFile({ status: 'ready', content: res.value.content, mtime: res.value.mtime });
        else setFile({ status: 'error', error: res.error.message });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFile({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    // 并行拉取该文件的划线/笔记列表(文件切换时重置)。
    void window.lorra.annotations
      .list({ fileId: activeFileId })
      .then((res) => {
        if (!cancelled) setAnnotations(res.ok ? res.value : []);
      })
      .catch(() => {
        if (!cancelled) setAnnotations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFileId]);

  // 中栏文件重取:tool.end(AI 写盘)与 edits.reverted(主进程复原写盘)共用。
  const refreshActiveFile = useCallback(() => {
    if (!activeFileId) return;
    void window.lorra.fs.open({ fileId: activeFileId }).then((res) => {
      if (res.ok) setFile({ status: 'ready', content: res.value.content, mtime: res.value.mtime });
    });
  }, [activeFileId]);

  // React to driver-issued fs.fileChanged events: re-fetch the active file.
  // 依赖收窄到末条事件本身(2026-08-13 性能):此前依赖整个 state,
  // 每个流式 partial 都会跑一遍此 effect。
  useEffect(() => {
    const latest = sessionState?.events.at(-1);
    if (!latest) return;
    // 阅读编辑合一:用户正在编辑时跳过自动重取,避免 AI 写盘覆盖编辑内容。
    if (isEditingFile || !activeFileId) return;
    if (latest.type === 'tool.end') {
      refreshActiveFile();
    } else if (latest.type === 'edits.reverted' && latest.fileId === activeFileId) {
      // 复原是主进程直接写盘,不走 tool.end 事件流,需显式重取。
      refreshActiveFile();
    }
  }, [sessionState?.events, activeSessionId, activeFileId, isEditingFile, refreshActiveFile]);

  const sendMessage = useCallback(
    async (text: string, images?: Array<{ fileId: string }>) => {
      if (!activeSessionId) return false;
      const res = await window.lorra.session.send({ sessionId: activeSessionId, text, images });
      // accepted:false = driver 忙碌拒收(session status 非 idle)。旧实现静默忽略
      // (消息凭空丢失);现在显式报错,消息队列的出队逻辑据此解锁(见下方)。
      if (!res.ok || !res.value.accepted) {
        dispatch({
          type: 'set-inline-error',
          sessionId: activeSessionId,
          message: res.ok ? '会话忙碌，消息未发出' : res.error.message,
        });
        return false;
      }
      return true;
    },
    [activeSessionId],
  );

  // ---- 消息队列(2026-08-17):agent 忙碌时发送 → 入队,空闲后按序自动发出 ----
  const [messageQueue, setMessageQueue] = useState<Array<{ id: string; text: string }>>([]);
  // 出队锁:发队首后 streaming 事件到达前,status 仍是 idle、effect 会因队列变化
  // 重跑 → 双发(第二条被 driver 拒收丢失)。锁住直到 busy=true(受理成功信号)。
  // ponytail:受理成功但 streaming 事件丢失时会挂起队列(事件流故障场景,整 App
  // 状态已坏,不单独兜底);受理失败由出队/立即发送路径显式解锁。
  const dequeueLockRef = useRef(false);

  /** 会话切换清队列:旧会话的排队消息不得发进新会话。 */
  useEffect(() => {
    setMessageQueue([]);
    dequeueLockRef.current = false;
  }, [activeSessionId]);

  const queueMessage = useCallback((text: string) => {
    setMessageQueue((q) => [...q, { id: crypto.randomUUID(), text }]);
  }, []);
  const removeQueuedMessage = useCallback((id: string) => {
    setMessageQueue((q) => q.filter((item) => item.id !== id));
  }, []);
  const editQueuedMessage = useCallback((id: string, text: string) => {
    setMessageQueue((q) => q.map((item) => (item.id === id ? { ...item, text } : item)));
  }, []);

  /** diff 卡「接受」:标记编辑记录为已接受。 */
  const acceptEdit = useCallback(async (editId: string) => {
    const r = await window.lorra.edits.accept({ editId });
    return r.ok;
  }, []);

  /** diff 卡「复原」:回退该次编辑,成功时返回 fileId 供中栏重取。 */
  const revertEdit = useCallback(async (editId: string) => {
    const r = await window.lorra.edits.revert({ editId });
    return r.ok ? { ok: true, fileId: r.value.fileId } : { ok: false, error: r.error.message };
  }, []);

  /** 工具行「在中栏打开」:目标为相对/绝对路径,换算成 fileId 打开。 */
  const openFileFromTool = useCallback(
    (target: string) => {
      if (!workspacePath) return;
      const rel = target.startsWith(workspacePath)
        ? target.slice(workspacePath.length).replace(/^[\\/]+/, '')
        : target.replace(/^[\\/]+/, '');
      if (!rel) return;
      setActiveFileId(rel);
      setActiveFileName(rel.split(/[\\/]/).pop() ?? rel);
    },
    [workspacePath],
  );

  /** 复原成功 → 若正是中栏当前文件,重取内容。 */
  const handleFileReverted = useCallback(
    (fileId: string) => {
      if (fileId === activeFileId) refreshActiveFile();
    },
    [activeFileId, refreshActiveFile],
  );

  /** 审批裁决:主进程 resolve 拦截器挂起(允许一次/总是允许→放行工具,拒绝→终止当前轮),本地乐观收起审批模态。 */
  const respondApproval = useCallback(
    async (approvalId: string, decision: 'allowOnce' | 'allowAlways' | 'deny') => {
      if (!activeSessionId) return;
      await window.lorra.session.respondApproval({
        sessionId: activeSessionId,
        approvalId,
        decision,
      });
      dispatch({ type: 'approval-resolved', sessionId: activeSessionId, approvalId });
    },
    [activeSessionId],
  );

  const abortSession = useCallback(async () => {
    if (!activeSessionId) return;
    await window.lorra.session.abort({ sessionId: activeSessionId });
  }, [activeSessionId]);

  /** 队列消息「立即发送」:abort 打断当前轮 → 直接 send(driver.abort resolve 时 agent 已停)。 */
  const sendQueuedMessageNow = useCallback(
    async (id: string) => {
      const item = messageQueue.find((m) => m.id === id);
      if (!item) return;
      dequeueLockRef.current = true;
      setMessageQueue((q) => q.filter((m) => m.id !== id));
      await abortSession();
      const accepted = await sendMessage(item.text);
      if (!accepted) dequeueLockRef.current = false;
    },
    [messageQueue, abortSession, sendMessage],
  );

  const switchWorkspace = useCallback(async () => {
    const result = await window.lorra.workspace.switch();
    if (!result.path || result.path === workspacePath) return;
    setActiveFileId(null);
    setActiveFileName(null);
    setActiveSessionId(null);
    setSessionHistory([]);
    setAnnotations([]);
    setReferences([]);
    setWorkspacePath(result.path);
  }, [workspacePath]);

  const handleSelectFile = useCallback((fileId: string, name: string) => {
    setActiveFileId(fileId);
    setActiveFileName(name);
    // 打开/切换文件时清空「问 AI」引用胶囊(单选替换语义)。
    setReferences([]);
  }, []);

  /** 划线/笔记:本地先追加(同 id 替换,笔记更新路径),再落盘;失败 → 重拉列表回滚并显示 inlineError。 */
  const handleAnnotate = useCallback(
    (draft: AnnotationDraft) => {
      setAnnotations((prev) => {
        const idx = prev.findIndex((a) => a.id === draft.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...draft, relPath: '' };
          return next;
        }
        return [...prev, { ...draft, relPath: '' }];
      });
      if (!activeFileId) return;
      const fail = (message: string): void => {
        void window.lorra.annotations.list({ fileId: activeFileId }).then((res) => {
          if (res.ok) setAnnotations(res.value);
        });
        if (activeSessionId) {
          dispatch({
            type: 'set-inline-error',
            sessionId: activeSessionId,
            message,
          });
        }
      };
      void window.lorra.annotations
        .save({ fileId: activeFileId, annotation: draft })
        .then((res) => {
          if (!res.ok) fail(t('app.notice.annotationSaveFailed', { message: res.error.message }));
        })
        .catch((err: unknown) => {
          fail(
            t('app.notice.annotationSaveFailed', {
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        });
    },
    [activeFileId, activeSessionId, t],
  );

  /** 删除划线:本地先删,再落盘;失败 → 重拉列表回滚并显示 inlineError。 */
  const handleRemoveAnnotation = useCallback(
    (id: string) => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      if (!activeFileId) return;
      const fail = (message: string): void => {
        void window.lorra.annotations.list({ fileId: activeFileId }).then((res) => {
          if (res.ok) setAnnotations(res.value);
        });
        if (activeSessionId) {
          dispatch({
            type: 'set-inline-error',
            sessionId: activeSessionId,
            message,
          });
        }
      };
      void window.lorra.annotations
        .remove({ fileId: activeFileId, id })
        .then((res) => {
          if (!res.ok) fail(t('app.notice.annotationDeleteFailed', { message: res.error.message }));
        })
        .catch((err: unknown) => {
          fail(
            t('app.notice.annotationDeleteFailed', {
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        });
    },
    [activeFileId, activeSessionId, t],
  );

  /** 「问 AI」:选区文本作为引用胶囊送入右栏(单选替换,不做多胶囊)。 */
  const handleAskAi = useCallback(
    (text: string) => {
      setReferences([
        { id: crypto.randomUUID(), kind: 'selection', fileName: activeFileName ?? '', text },
      ]);
    },
    [activeFileName],
  );

  /** @ 文件候选:主进程工作区文件搜索。 */
  const fileCandidates = useCallback(
    (query: string) =>
      window.lorra.fs.search({ query, limit: 20 }).then((r) => (r.ok ? r.value : [])),
    [],
  );

  /** @ 文件引用发送时读内容快照;失败 → null(退化为仅文件名)。 */
  const resolveFileRef = useCallback(async (fileId: string) => {
    const r = await window.lorra.fs.open({ fileId });
    return r.ok ? r.value.content : null;
  }, []);

  /** @ 选中文件后追加胶囊。 */
  const appendReference = useCallback((ref: ComposerReference) => {
    setReferences((prev) => [...prev, ref]);
  }, []);

  /**
   * 保存整篇 Markdown(阅读编辑合一)。mtime 守卫失败(文件被其他来源修改)
   * → 重载磁盘版本并提示;普通失败 → 提示原因,编辑块保留内容可重试。
   */
  const handleSaveContent = useCallback(
    async (content: string): Promise<'saved' | 'conflict' | 'error'> => {
      if (!activeFileId || file.status !== 'ready') return 'error';
      const res = await window.lorra.fs.save({
        fileId: activeFileId,
        content,
        baseMtime: file.mtime,
      });
      if (res.ok) {
        setFile({ status: 'ready', content, mtime: res.value.mtime });
        return 'saved';
      }
      if (res.error.code === 'file-changed') {
        const fresh = await window.lorra.fs
          .open({ fileId: activeFileId })
          .then((r) => (r.ok ? r : null));
        if (fresh)
          setFile({ status: 'ready', content: fresh.value.content, mtime: fresh.value.mtime });
        setCommandNotice(t('app.notice.fileConflict'));
        return 'conflict';
      }
      setCommandNotice(t('app.notice.saveFailed', { message: res.error.message }));
      return 'error';
    },
    [activeFileId, file.mtime, file.status, t],
  );
  // 稳定回调(memo 性能,2026-08-13):避免每个流式事件都让 Sidebar/DocumentViewer 重渲染。
  const toggleHiddenFiles = useCallback(
    () => setShowHiddenFiles(!showHiddenFiles),
    [showHiddenFiles, setShowHiddenFiles],
  );
  const openPalette = useCallback(() => palette.setOpen(true), [palette]);
  const onSwitchWorkspace = useCallback(() => void switchWorkspace(), [switchWorkspace]);

  const createSession = useCallback(async () => {
    if (!workspacePath) return;
    const result = await window.lorra.session.create({ workspaceId: workspacePath });
    if (!result.ok) return;
    setActiveSessionId(result.value.sessionId);
    dispatch({ type: 'subscribe-session', sessionId: result.value.sessionId });
  }, [workspacePath]);

  const openSession = useCallback(async (sessionId: string) => {
    const result = await window.lorra.session.open({ sessionId });
    if (!result.ok) return;
    setActiveSessionId(result.value.sessionId);
    dispatch({ type: 'subscribe-session', sessionId: result.value.sessionId });
  }, []);

  // ---- 消息队列出队(2026-08-17) ----
  // 注:必须在下方 workspace picker 等早退 return 之前调用(hook 顺序恒定)。
  const queueStatus: SessionStatus = sessionState?.status ?? 'idle';
  const queueBusy = queueStatus === 'streaming' || queueStatus === 'tool-running';
  // busy=true = 上一条已被 agent 受理 → 解锁出队判断(受理成功信号)。
  useEffect(() => {
    if (queueBusy) dequeueLockRef.current = false;
  }, [queueBusy]);
  // 空闲自动出队:严格 status==='idle'(aborted 不出队——用户刚打断,排队消息
  // 不应立刻自动发出;剩余队列等下一轮 idle)。发队首后上锁,防事件到达前双发。
  useEffect(() => {
    if (queueStatus !== 'idle' || !activeSessionId || messageQueue.length === 0) return;
    if (dequeueLockRef.current) return;
    dequeueLockRef.current = true;
    const head = messageQueue[0];
    setMessageQueue((q) => q.slice(1));
    void sendMessage(head.text).then((accepted) => {
      if (!accepted) dequeueLockRef.current = false;
    });
  }, [queueStatus, activeSessionId, messageQueue, sendMessage]);

  /** `/compact`:委托主进程压缩上下文,成功后重开会话让 driver 重放压缩后消息。 */
  const compactSession = useCallback(async (): Promise<boolean> => {
    if (!activeSessionId) {
      setCommandNotice(t('app.notice.noSessionCompact'));
      return true;
    }
    try {
      const res = await window.lorra.session.compact({ sessionId: activeSessionId });
      if (!res.ok) {
        setCommandNotice(res.error.message);
        return true;
      }
      if (!res.value.accepted) {
        setCommandNotice(t('app.notice.agentBusy'));
        return true;
      }
      await openSession(activeSessionId);
      setCommandNotice(t('app.notice.compacted'));
    } catch (err) {
      setCommandNotice(err instanceof Error ? err.message : t('app.notice.compactFailed'));
    }
    return true;
  }, [activeSessionId, openSession, t]);

  /** `/copy`:复制最后一条 AI 回复到剪贴板。 */
  const copyLastAssistantMessage = useCallback(async (): Promise<void> => {
    const assistantMessages = events.filter(
      (e): e is Extract<AgentEvent, { type: 'message.final' }> =>
        e.type === 'message.final' && e.role === 'assistant',
    );
    const last = assistantMessages[assistantMessages.length - 1];
    if (!last) {
      setCommandNotice(t('app.notice.nothingToCopy'));
      return;
    }
    try {
      await navigator.clipboard.writeText(last.content.text);
      setCommandNotice(t('app.notice.copied'));
    } catch {
      setCommandNotice(t('app.notice.copyFailed'));
    }
  }, [events, t]);

  /** 命令面板 /review 入口（6.10 缝隙修复）：复用生成链路，三态文案同 composer。 */
  const runReviewFromPalette = useCallback(async (): Promise<void> => {
    let res: SerializedResult<ReviewMeta> | undefined;
    try {
      res = await window.lorra?.review?.generate({ kind: 'daily' });
    } catch (err) {
      setCommandNotice(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!res) {
      setCommandNotice(t('app.notice.reviewUnavailable'));
      return;
    }
    if (res.ok) {
      setCommandNotice(t('app.notice.reviewGenerated'));
      return;
    }
    const { error } = res;
    setCommandNotice(
      error.code === 'model-unavailable'
        ? t('app.notice.reviewNoModel')
        : error.code === 'review-timed-out'
          ? t('app.notice.reviewTimeout')
          : t('app.notice.reviewFailed', { message: error.message }),
    );
  }, [t]);

  /** 斜杠命令执行(pi TUI 风格):返回 true = 已处理。 */
  const handleCommand = useCallback(
    async (command: SlashCommandName): Promise<boolean> => {
      switch (command) {
        case 'new':
          createSession();
          return true;
        case 'compact':
          return compactSession();
        case 'resume':
          palette.setOpen(true);
          return true;
        case 'model':
          setPage('providers');
          return true;
        case 'settings':
          setPage('settings');
          return true;
        case 'quit':
          window.close();
          return true;
        case 'hotkeys':
          setShortcutsOpen(true);
          return true;
        case 'copy':
          await copyLastAssistantMessage();
          return true;
        case 'review':
          // 命令面板入口（6.10 缝隙修复）：面板只支持无参 /review（每日），
          // weekly 走 composer 文本输入。反馈经 commandNotice，三态文案与
          // review-rail/composer 一致。
          await runReviewFromPalette();
          return true;
        default:
          return false;
      }
    },
    [createSession, compactSession, copyLastAssistantMessage, palette.setOpen, setPage],
  );

  const returnToWorkspace = useCallback(async () => {
    await chatModel.refresh();
    setPage('workspace');
  }, [chatModel.refresh, setPage]);

  /** 胶囊仓切换模型:setDefault 写真相源 + 本地 refresh 同步显示;最近使用由胶囊侧记录。 */
  const handleModelChanged = useCallback(
    async (providerId: string, modelId: string) => {
      await window.lorra.models.setDefault({ providerId, modelId });
      await chatModel.refresh();
    },
    [chatModel.refresh],
  );

  /** 今日页点击会话块下钻:切工作区(若不同)+ 开会话,复用既有动作,不新造。 */
  const openTodaySession = useCallback(
    (workspace: string, sessionId: string) => {
      void (async () => {
        if (workspace && workspace !== workspacePath) await activateWorkspace(workspace);
        await openSession(sessionId);
      })();
    },
    [workspacePath, activateWorkspace, openSession],
  );

  if (workspacePath === undefined) {
    return (
      <div className="workspace-picker" role="status" aria-live="polite">
        <p>{t('app.loadingWorkspace')}</p>
      </div>
    );
  }

  if (workspacePath === null) {
    // 主进程 get 失败兜底(正常流程自动建默认工作区,不会走到)。
    return (
      <div className="workspace-picker" role="status" aria-live="polite">
        <p>{t('app.workspaceError')}</p>
      </div>
    );
  }

  const status: SessionStatus = sessionState?.status ?? 'idle';
  const inlineError = sessionState?.inlineError ?? '';

  return (
    <div className="app-shell">
      <header className="titlebar">
        <button
          className="nav-toggle"
          type="button"
          aria-label={navCollapsed ? t('titlebar.expandIconBar') : t('titlebar.collapseIconBar')}
          onClick={toggleNav}
        >
          {navCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        {/* 全局壳中间插槽:页面内容只占据此槽,不参与标题栏列布局。
 窗口控件恒钉右缘(grid-column 显式分配),不依赖内容撑开。 */}
        <div className="titlebar-slot">
          {/* 今日页/记忆页/技能页为独立整页:不渲染工作区 tab 条(app-shell spec / 6.9)。 */}
          {page !== 'today' && page !== 'memory' && page !== 'skills' && (
            <WorkspaceTabs
              workspaces={recentWorkspaces}
              activePath={workspacePath}
              onActivate={(path) => void activateWorkspace(path)}
              onAdd={() => void switchWorkspace()}
              onRemove={(path) => void removeRecentWorkspace(path)}
            />
          )}
        </div>
        <div className="window-actions">
          <button
            type="button"
            aria-label={theme === 'dark' ? t('titlebar.toggleLight') : t('titlebar.toggleDark')}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            aria-label={t('titlebar.minimize')}
            onClick={() => void window.lorra.window.minimize()}
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('titlebar.maximize')}
            onClick={() => void window.lorra.window.toggleMaximize()}
          >
            <Square className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('titlebar.close')}
            onClick={() => void window.lorra.window.close()}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>
      <AppShell>
        {page === 'providers' && <ProvidersPage onBack={returnToWorkspace} />}
        {page === 'settings' && <SettingsPage />}
        {page === 'today' && (
          <TodayPage onBack={returnToWorkspace} onOpenSession={openTodaySession} />
        )}
        {page === 'memory' && <MemoryPage onBack={returnToWorkspace} />}
        {page === 'skills' && <PluginsPage onOpenFile={openFileFromTool} />}
        {page === 'workspace' && (
          <>
            <a className="skip-link" href="#current-document">
              {t('app.skipToDocument')}
            </a>
            <Group
              className="workspace-grid"
              orientation="horizontal"
              defaultLayout={defaultLayout}
              onLayoutChanged={onLayoutChanged}
            >
              {!narrow && (
                <>
                  <Panel
                    id="sidebar"
                    className="pane-fill"
                    defaultSize={260}
                    minSize={180}
                    maxSize={420}
                  >
                    <Sidebar
                      activeSessionId={activeSessionId}
                      sessionHistory={sessionHistory}
                      sessionIndicators={sessionIndicators}
                      sessionBootstrapping={sessionBootstrapping}
                      activeFileId={activeFileId}
                      showHiddenFiles={showHiddenFiles}
                      onToggleHidden={toggleHiddenFiles}
                      onCreateSession={createSession}
                      onOpenSession={openSession}
                      onSelectFile={handleSelectFile}
                      onOpenPalette={openPalette}
                      onSwitchWorkspace={onSwitchWorkspace}
                      workspaceKey={workspacePath}
                    />
                  </Panel>
                  <Separator className="pane-handle" />
                </>
              )}
              <Panel id="document" className="pane-fill" minSize={280}>
                <DocumentViewer
                  file={file}
                  fileName={activeFileName}
                  fileId={activeFileId}
                  annotations={annotations}
                  onAnnotate={handleAnnotate}
                  onRemoveAnnotation={handleRemoveAnnotation}
                  onAskAi={handleAskAi}
                  onSaveContent={handleSaveContent}
                  onEditStateChange={setIsEditingFile}
                  onOpenFile={openFileFromTool}
                />
              </Panel>
              <Separator className="pane-handle" />
              <Panel id="chat" className="pane-fill" defaultSize={420} minSize={320} maxSize={720}>
                <ChatPane
                  status={status}
                  events={events}
                  thinkingFirstTs={sessionState?.thinkingFirstTs}
                  modelAvailable={chatModel.modelAvailable}
                  modelLoading={chatModel.loading}
                  defaultModelName={chatModel.defaultModelName}
                  defaultCurrent={chatModel.current}
                  onModelChanged={handleModelChanged}
                  inlineError={inlineError}
                  onOpenProviders={() => setPage('providers')}
                  onSend={sendMessage}
                  onAbort={abortSession}
                  onCreateSession={createSession}
                  onCommand={handleCommand}
                  references={references}
                  onClearReferences={() => setReferences([])}
                  queue={messageQueue}
                  onQueue={queueMessage}
                  onQueueRemove={removeQueuedMessage}
                  onQueueEdit={editQueuedMessage}
                  onQueueSendNow={(id) => void sendQueuedMessageNow(id)}
                  onFileCandidates={fileCandidates}
                  onResolveFileRef={resolveFileRef}
                  onAppendReference={appendReference}
                  workspacePath={workspacePath}
                  onOpenFile={openFileFromTool}
                  onAcceptEdit={acceptEdit}
                  onRevertEdit={revertEdit}
                  onFileReverted={handleFileReverted}
                  pendingApproval={sessionState?.pendingApproval}
                  onRespondApproval={respondApproval}
                  recordedNotices={sessionState?.recordedNotices}
                  onMemoryNoticeDismissed={(entryId) => {
                    if (activeSessionId) {
                      dispatch({
                        type: 'memory-notice-dismissed',
                        sessionId: activeSessionId,
                        entryId,
                      });
                    }
                  }}
                />
              </Panel>
            </Group>
          </>
        )}
      </AppShell>
      <CommandPalette
        open={palette.open}
        onOpenChange={palette.setOpen}
        sessionHistory={sessionHistory}
        activeSessionId={activeSessionId}
        onOpenSession={openSession}
        onSelectFile={handleSelectFile}
        onCreateSession={createSession}
        onCommand={handleCommand}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {commandNotice && (
        <div className="command-notice" role="status" aria-live="polite">
          <span>{commandNotice}</span>
          <button
            type="button"
            aria-label={t('app.notice.close')}
            onClick={() => setCommandNotice(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
