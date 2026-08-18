import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  PenLine,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useAppStore } from '@/lib/app-store';
import type { MessageKey } from '../shared/i18n-core';
import type {
  ArchivalAuditDto,
  CoreProjectionDto,
  OkfCheckResultDto,
  WorkingMemorySnapshotDto,
} from '../shared/memory-api';
import {
  MEMORY_EVIDENCE_LABELS,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryEvent,
  type MemoryKind,
} from '../shared/memory-schema';
import type { LorraError, SerializedResult } from '../shared/result';
import { useT } from './lib/i18n';
import { resolveWikilinks } from './lib/knowledge-links';
import { SafeMarkdown } from './safe-markdown';

/**
 * 记忆页(2026-08-10 方向 B 重设计, 锚):
 * 三栏知识树工作台(llm-wiki 主工作台同构)。
 *
 * ① 左栏 · 知识树:八类 kind 分组(顺序照 MEMORY_KINDS) + active 条目行;
 * 组尾归档折叠行(retired 删除线 / superseded「取代」标记,默认收起);
 * 底部「最近变更」审计折叠(审计视图保留,默认收起)。
 * ② 中栏 · 条目流:搜索框 + 当前组 active 条目(分隔线列表,非卡片);
 * 条目 = 标题 + 摘要首行 + 标准化标签 chips。
 * ③ 右栏 · 条目页面:选中条目文档页(serif 标题 + 结构化 markdown 全 kind
 * 渲染 + 标签 chips + kind/证据徽标) + 关系面板(反向/出站链接,数据源
 * entry_links) + 操作条(编辑/撤销)。
 *
 * 用户三问题对应:
 * - 无法编辑:页面内编辑 dialog,kind 可改(evidence/scope 继承,铁律);
 * - 查看不便:三栏聚焦 + 结构化渲染 + 关系面板(双链展示给用户);
 * - 已撤销仍显示:中栏只渲染 active,归档折叠进左栏灰态行;
 * 标签语言(2026-08-10 用户拍板):标准化词表(运行规定类 + 项目类型类),
 * 禁止来源类标签——来源徽标移除,证据徽标保留。
 * 消化素材入口已移除(2026-08-10):记忆是对话 loop 的产物(设计文档 1.1
 * 被否的入口思维),记忆页不再提供显式「喂素材」入口;digest IPC 能力保留
 * 供对话侧/未来入口接入。
 * 状态:加载 / 错误(LorraError + 重试)/ 空态。
 * 视觉对齐 Kami token:纸面底 + 藏青 accent + 编辑式留白。
 */

export interface MemoryPageProps {
  /** 返回工作台(缺省走 app-store setPage('workspace'))。 */
  onBack?: () => void;
}

interface MemoryLinkEdge {
  fromId: string;
  toId: string;
}

interface MemoryLists {
  events: MemoryEvent[];
  active: MemoryEntry[];
  archived: MemoryEntry[];
  links: MemoryLinkEdge[];
}

interface LayeredMemoryAuditState {
  core: CoreProjectionDto | null;
  working: WorkingMemorySnapshotDto | null;
  archival: ArchivalAuditDto | null;
  sessionId: string | null;
}

function listEvents(): Promise<SerializedResult<MemoryEvent[]>> {
  const bridge = window.lorra.memory as unknown as {
    listEvents(args: { entryId?: string }): Promise<SerializedResult<MemoryEvent[]>>;
  };
  return bridge.listEvents({});
}

function listLinks(): Promise<SerializedResult<MemoryLinkEdge[]>> {
  const bridge = window.lorra.memory as unknown as {
    listLinks(): Promise<SerializedResult<MemoryLinkEdge[]>>;
  };
  return bridge.listLinks();
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 词条取值函数形状(纯格式化模块函数经此参数注入,组件内传 useT 结果)。 */
type Tr = (key: MessageKey, params?: Record<string, string | number>) => string;

/** 生命周期徽标(retired 已撤销 / superseded 已取代;其余按原值展示)。 */
function lifecycleLabel(lifecycle: string, tr: Tr): string {
  if (lifecycle === 'retired') return tr('memory.lifecycle.retired');
  if (lifecycle === 'superseded') return tr('memory.lifecycle.superseded');
  return lifecycle;
}

/** 审计事件标签(event_log 四态;旧 proposed/confirmed 行不再出现,按原值展示)。 */
function eventKindLabel(kind: string, tr: Tr): string {
  switch (kind) {
    case 'recorded':
      return tr('memory.event.recorded');
    case 'edited':
      return tr('memory.event.edited');
    case 'retired':
      return tr('memory.event.retired');
    case 'superseded':
      return tr('memory.event.superseded');
    default:
      return kind;
  }
}

/** 条目摘要首行(列表行预览用;markdown 剥标题符号)。 */
function summaryLine(entry: MemoryEntry): string {
  const first = entry.content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  return (first ?? '').replace(/^[-*]\s+/, '').slice(0, 60);
}

export function MemoryPage({ onBack }: MemoryPageProps): JSX.Element {
  const setPage = useAppStore((s) => s.setPage);
  const t = useT();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<LorraError | null>(null);
  const [actionError, setActionError] = useState<LorraError | null>(null);
  const [lists, setLists] = useState<MemoryLists>({
    events: [],
    active: [],
    archived: [],
    links: [],
  });
  /** 左栏选中组:'all' 或某 kind。 */
  const [treeKind, setTreeKind] = useState<MemoryKind | 'all'>('all');
  /** 各组归档折叠展开态。 */
  const [archivedOpen, setArchivedOpen] = useState<Set<MemoryKind>>(new Set());
  /** 审计折叠展开态。 */
  const [eventsOpen, setEventsOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** 非 null = 搜索态:中栏列表展示搜索结果。 */
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null);
  /** 右栏选中条目。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** :OFK 文档视图(entryId + 文档内容);切条目/切回记忆条目时清空。 */
  const [docView, setDocView] = useState<{ entryId: string; content: string } | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [layeredAudit, setLayeredAudit] = useState<LayeredMemoryAuditState>({
    core: null,
    working: null,
    archival: null,
    sessionId: null,
  });
  const [okfAudit, setOkfAudit] = useState<OkfCheckResultDto | null>(null);
  // 编辑 dialog 状态。
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftBasis, setDraftBasis] = useState('');
  const [draftKind, setDraftKind] = useState<MemoryKind>('knowledge');

  const loadLayeredAudit = useCallback(async (): Promise<void> => {
    try {
      const memory = window.lorra?.memory as unknown as {
        getCoreProjection?: () => Promise<SerializedResult<CoreProjectionDto>>;
        getWorkingMemory?: (
          sessionId: string,
        ) => Promise<SerializedResult<WorkingMemorySnapshotDto | null>>;
        getArchivalAudit?: (
          sessionId: string,
        ) => Promise<SerializedResult<ArchivalAuditDto | null>>;
      };
      const coreRes = memory.getCoreProjection ? await memory.getCoreProjection() : null;
      const workspace = await window.lorra.workspace.get();
      const sessions =
        workspace.path !== null
          ? await window.lorra.session.list({ workspaceId: workspace.path })
          : null;
      const sessionId = sessions?.ok ? (sessions.value[0]?.id ?? null) : null;
      const [workingRes, archivalRes] =
        sessionId && memory.getWorkingMemory && memory.getArchivalAudit
          ? await Promise.all([
              memory.getWorkingMemory(sessionId),
              memory.getArchivalAudit(sessionId),
            ])
          : [null, null];
      setLayeredAudit({
        core: coreRes?.ok ? coreRes.value : null,
        working: workingRes?.ok ? workingRes.value : null,
        archival: archivalRes?.ok ? archivalRes.value : null,
        sessionId,
      });
    } catch {
      setLayeredAudit({ core: null, working: null, archival: null, sessionId: null });
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading');
    setActionError(null);
    setSearchResults(null);
    try {
      const memory = window.lorra?.memory;
      if (!memory) throw new Error(t('memory.channelUnavailable'));
      const [evs, act, arch, lks] = await Promise.all([
        listEvents(),
        memory.listActive({}),
        memory.listArchived(),
        listLinks(),
      ]);
      if (!evs.ok) {
        setError(evs.error);
        setPhase('error');
        return;
      }
      if (!act.ok) {
        setError(act.error);
        setPhase('error');
        return;
      }
      if (!arch.ok) {
        setError(arch.error);
        setPhase('error');
        return;
      }
      if (!lks.ok) {
        setError(lks.error);
        setPhase('error');
        return;
      }
      const active = act.value ?? [];
      setLists({
        events: evs.value ?? [],
        active,
        archived: arch.value ?? [],
        links: lks.value ?? [],
      });
      setError(null);
      setPhase('ready');
      void loadLayeredAudit();
      // 默认选中第一条 active(右栏开箱即见内容)。
      setSelectedId((prev) => {
        if (prev && active.some((e) => e.entryId === prev)) return prev;
        return active[0]?.entryId ?? null;
      });
    } catch (cause) {
      setError({
        code: 'memory-load-failed',
        message: cause instanceof Error ? cause.message : String(cause),
      });
      setPhase('error');
    }
  }, [loadLayeredAudit, t]);

  const didMount = useRef(false);
  useEffect(() => {
    if (didMount.current) return;
    didMount.current = true;
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  const handleActionError = useCallback((res: { ok: false; error: LorraError }) => {
    setActionError(res.error);
  }, []);

  const retireOne = useCallback(
    async (entryId: string) => {
      const res = await window.lorra.memory.retire({ entryId });
      if (!res.ok) handleActionError(res);
      if (res.ok && selectedId === entryId) setSelectedId(null);
      reload();
    },
    [handleActionError, reload, selectedId],
  );

  const openEdit = useCallback((entry: MemoryEntry) => {
    setEditing(entry);
    setDraftTitle(entry.title);
    setDraftContent(entry.content);
    setDraftBasis(entry.basis);
    setDraftKind(entry.kind);
    setActionError(null);
  }, []);

  const closeEdit = useCallback(() => setEditing(null), []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const res = await window.lorra.memory.edit({
      entryId: editing.entryId,
      title: draftTitle,
      content: draftContent,
      basis: draftBasis.trim() ? draftBasis.trim() : undefined,
      kind: draftKind,
    });
    if (!res.ok) {
      handleActionError(res);
      return;
    }
    setEditing(null);
    reload();
  }, [editing, draftTitle, draftContent, draftBasis, draftKind, handleActionError, reload]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const res = await window.lorra.memory.search({ query: q });
    if (!res.ok) {
      handleActionError(res);
      setSearchResults(null);
      return;
    }
    setSearchResults(res.value ?? []);
  }, [query, handleActionError]);

  /** 标题映射(active + archived,关系面板与审计展示用)。 */
  const entryTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of lists.active) map.set(e.entryId, e.title);
    for (const e of lists.archived) map.set(e.entryId, e.title);
    return map;
  }, [lists.active, lists.archived]);

  const entryById = useMemo(() => {
    const map = new Map<string, MemoryEntry>();
    for (const e of lists.active) map.set(e.entryId, e);
    for (const e of lists.archived) map.set(e.entryId, e);
    return map;
  }, [lists.active, lists.archived]);

  const selected = selectedId ? (entryById.get(selectedId) ?? null) : null;

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      if (!selected?.ofkRef) {
        setOkfAudit(null);
        return;
      }
      const memory = window.lorra?.memory as unknown as {
        okfCheck?: (path: string) => Promise<SerializedResult<OkfCheckResultDto>>;
      };
      if (!memory.okfCheck) {
        setOkfAudit(null);
        return;
      }
      const res = await memory.okfCheck(selected.ofkRef);
      if (!cancelled) setOkfAudit(res.ok ? res.value : null);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [selected?.ofkRef]);

  /** :查看 OFK 文档(记忆页跳转读取);加载失败 → 内联错误。 */
  const openDocument = useCallback(
    async (entry: MemoryEntry) => {
      setDocError(null);
      if (!entry.ofkRef) return;
      try {
        const res = await window.lorra.memory.readDocument(entry.ofkRef);
        if (res.ok && res.value.content !== null) {
          setDocView({ entryId: entry.entryId, content: res.value.content });
        } else {
          setDocError(res.ok ? t('memory.docLoadError') : res.error.message);
        }
      } catch (cause) {
        setDocError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [t],
  );

  /** 关系面板:入链(谁指向我) / 出链(我指向谁)。 */
  const relations = useMemo(() => {
    if (!selected) return { inbound: [], outbound: [] };
    const inbound: Array<{ entry: MemoryEntry | undefined; title: string; active: boolean }> = [];
    const outbound: Array<{ entry: MemoryEntry | undefined; title: string; active: boolean }> = [];
    for (const l of lists.links) {
      if (l.toId === selected.entryId) {
        const e = entryById.get(l.fromId);
        inbound.push({
          entry: e,
          title: e?.title ?? l.fromId.slice(0, 10),
          active: e?.lifecycle === 'active',
        });
      }
      if (l.fromId === selected.entryId) {
        const e = entryById.get(l.toId);
        outbound.push({
          entry: e,
          title: e?.title ?? l.toId.slice(0, 10),
          active: e?.lifecycle === 'active',
        });
      }
    }
    return { inbound, outbound };
  }, [selected, lists.links, entryById]);

  const sortedEvents = useMemo(() => [...lists.events].sort((a, b) => b.ts - a.ts), [lists.events]);

  /** 中栏条目流:搜索态 → 搜索结果;否则当前组 active。 */
  const listEntries = useMemo(() => {
    if (searchResults !== null) return searchResults;
    if (treeKind === 'all') return lists.active;
    return lists.active.filter((e) => e.kind === treeKind);
  }, [searchResults, treeKind, lists.active]);

  const archivedByKind = useMemo(() => {
    const map = new Map<MemoryKind, MemoryEntry[]>();
    for (const e of lists.archived) {
      const list = map.get(e.kind) ?? [];
      list.push(e);
      map.set(e.kind, list);
    }
    return map;
  }, [lists.archived]);

  const toggleArchived = useCallback((kind: MemoryKind) => {
    setArchivedOpen((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const isAllEmpty =
    lists.events.length === 0 && lists.active.length === 0 && lists.archived.length === 0;

  const handleBack = onBack ?? (() => setPage('workspace'));

  return (
    <main className="memory-page" data-testid="memory-page">
      <header className="memory-head">
        <button
          type="button"
          className="back-btn"
          aria-label={t('memory.back')}
          onClick={handleBack}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <div className="head-title">
          <h1>
            <Archive className="tl-icon" aria-hidden="true" />
            {t('nav.memory')}
          </h1>
        </div>
        <div className="memory-head-actions">
          <button
            type="button"
            className="btn btn-ghost memory-refresh"
            aria-label={t('memory.refresh')}
            onClick={reload}
          >
            <RefreshCw className="btn-icon" aria-hidden="true" />
          </button>
        </div>
      </header>

      {actionError && (
        <div className="memory-action-error" role="alert">
          {actionError.message}
          <button
            type="button"
            aria-label={t('memory.actionErrorClose')}
            onClick={() => setActionError(null)}
          >
            ×
          </button>
        </div>
      )}

      {phase === 'loading' && (
        <div className="memory-loading" data-testid="memory-loading" role="status">
          <span className="orb" aria-hidden="true" />
          {t('memory.loading')}
        </div>
      )}

      {phase === 'error' && (
        <div className="memory-error" data-testid="memory-error" role="alert">
          <span className="memory-error-msg">{error?.message ?? t('memory.errorFallback')}</span>
          <button type="button" className="btn btn-primary" onClick={reload}>
            {t('memory.retry')}
          </button>
        </div>
      )}

      {phase === 'ready' && isAllEmpty && (
        <div className="memory-empty" data-testid="memory-empty">
          <Archive aria-hidden="true" />
          <div className="e-title">{t('memory.empty.title')}</div>
          <div className="e-sub">
            <div>{t('memory.empty.sub')}</div>
            <div className="memory-empty-hint">{t('memory.empty.hint')}</div>
          </div>
        </div>
      )}

      {phase === 'ready' && !isAllEmpty && (
        <div className="memory-workspace" data-testid="memory-workspace">
          {/* ① 左栏 · 知识树 */}
          <aside
            className="memory-tree"
            data-testid="memory-tree"
            aria-label={t('memory.tree.label')}
          >
            <button
              type="button"
              className={`memory-tree-group ${treeKind === 'all' ? 'on' : ''}`}
              onClick={() => setTreeKind('all')}
            >
              <span className="memory-tree-label">{t('memory.tree.all')}</span>
              <span className="memory-tree-count">{lists.active.length}</span>
            </button>
            {MEMORY_KINDS.map((kind) => {
              const active = lists.active.filter((e) => e.kind === kind);
              const archived = archivedByKind.get(kind) ?? [];
              if (active.length === 0 && archived.length === 0) return null;
              const open = archivedOpen.has(kind);
              return (
                <div className="memory-tree-group-wrap" key={kind} data-kind={kind}>
                  <div className="memory-tree-group-head">
                    <button
                      type="button"
                      className={`memory-tree-group ${treeKind === kind ? 'on' : ''}`}
                      onClick={() => setTreeKind(kind)}
                    >
                      <span className="memory-tree-label">{MEMORY_KIND_LABELS[kind]}</span>
                      <span className="memory-tree-count">{active.length}</span>
                    </button>
                    {archived.length > 0 && (
                      <button
                        type="button"
                        className="memory-tree-archive-toggle"
                        aria-label={t('memory.tree.expandArchived', {
                          name: MEMORY_KIND_LABELS[kind],
                        })}
                        onClick={() => toggleArchived(kind)}
                      >
                        {open ? (
                          <ChevronDown aria-hidden="true" />
                        ) : (
                          <ChevronRight aria-hidden="true" />
                        )}
                        <span>{t('memory.tree.archived', { count: archived.length })}</span>
                      </button>
                    )}
                  </div>
                  {active.map((e) => (
                    <button
                      type="button"
                      key={e.entryId}
                      className={`memory-tree-item ${selectedId === e.entryId ? 'on' : ''}`}
                      data-entry-id={e.entryId}
                      onClick={() => {
                        setDocView(null);
                        setDocError(null);
                        setSelectedId(e.entryId);
                      }}
                    >
                      {e.title}
                    </button>
                  ))}
                  {open &&
                    archived.map((e) => (
                      <button
                        type="button"
                        key={e.entryId}
                        className={`memory-tree-item archived ${e.lifecycle}`}
                        data-entry-id={e.entryId}
                        onClick={() => {
                          setDocView(null);
                          setDocError(null);
                          setSelectedId(e.entryId);
                        }}
                        title={lifecycleLabel(e.lifecycle, t)}
                      >
                        <span className="memory-tree-item-text">{e.title}</span>
                        <span className={`memory-tree-lifecycle is-${e.lifecycle}`}>
                          {lifecycleLabel(e.lifecycle, t)}
                        </span>
                      </button>
                    ))}
                </div>
              );
            })}
            {/* 底部:最近变更审计折叠(保留,默认收起) */}
            <div className="memory-tree-events">
              <button
                type="button"
                className={`memory-tree-group ${eventsOpen ? 'on' : ''}`}
                onClick={() => setEventsOpen((v) => !v)}
              >
                {eventsOpen ? (
                  <ChevronDown aria-hidden="true" />
                ) : (
                  <ChevronRight aria-hidden="true" />
                )}
                <span className="memory-tree-label">{t('memory.tree.recentChanges')}</span>
                <span className="memory-tree-count">{sortedEvents.length}</span>
              </button>
              {eventsOpen && (
                <div className="memory-tree-event-list" data-testid="memory-audit-list">
                  {sortedEvents.map((ev) => (
                    <div
                      className="memory-tree-event-item"
                      data-testid="memory-audit-item"
                      data-event-kind={ev.event}
                      key={ev.id}
                    >
                      <span className={`memory-badge memory-badge-event is-${ev.event}`}>
                        {eventKindLabel(ev.event, t)}
                      </span>
                      <span className="memory-tree-event-title" title={ev.entryId}>
                        {entryTitleById.get(ev.entryId) ?? ev.entryId}
                      </span>
                      <span className="memory-tree-event-time">{fmtDateTime(ev.ts)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>

          {/* ② 中栏 · 条目流 */}
          <section
            className="memory-list"
            data-testid="memory-zone-active"
            aria-label={t('memory.list.region')}
          >
            <search className="memory-search">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runSearch();
                }}
              >
                <Search className="memory-search-icon" aria-hidden="true" />
                <input
                  data-testid="memory-search-input"
                  type="search"
                  aria-label={t('memory.search.label')}
                  placeholder={t('memory.search.placeholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </form>
            </search>
            <div className="memory-list-summary">
              {searchResults !== null
                ? t('memory.search.resultCount', { count: searchResults.length })
                : treeKind === 'all'
                  ? t('memory.list.allCount', { count: lists.active.length })
                  : t('memory.list.kindCount', {
                      kind: MEMORY_KIND_LABELS[treeKind],
                      count: listEntries.length,
                    })}
            </div>
            <div className="memory-list-items" data-testid="memory-list-items">
              {listEntries.length === 0 && (
                <div className="memory-zone-empty">
                  {searchResults !== null
                    ? t('memory.list.noSearchMatch')
                    : t('memory.list.noActive')}
                </div>
              )}
              {listEntries.map((entry) => (
                <button
                  type="button"
                  key={entry.entryId}
                  className={`memory-list-item ${selectedId === entry.entryId ? 'on' : ''}`}
                  data-testid="memory-entry"
                  data-entry-id={entry.entryId}
                  onClick={() => setSelectedId(entry.entryId)}
                >
                  <span className="memory-list-item-title">{entry.title}</span>
                  {entry.tags.length > 0 && (
                    <span className="memory-list-item-tags">
                      {entry.tags.map((t) => (
                        <span className="memory-tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="memory-list-item-summary">{summaryLine(entry)}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ③ 右栏 · 条目页面 */}
          <section
            className="memory-page-view"
            data-testid="memory-page-view"
            aria-label={t('memory.detail.label')}
          >
            {!selected && <div className="memory-page-empty">{t('memory.detail.empty')}</div>}
            {selected && (
              <div className="memory-doc" key={selected.entryId} data-testid="memory-doc">
                <h2 className="memory-doc-title">{selected.title}</h2>
                <div className="memory-doc-badges">
                  <span className="memory-badge memory-badge-kind">
                    {MEMORY_KIND_LABELS[selected.kind]}
                  </span>
                  <span className="memory-badge memory-badge-evidence">
                    {MEMORY_EVIDENCE_LABELS[selected.evidence]}
                  </span>
                  {selected.lifecycle !== 'active' && (
                    <span className={`memory-badge memory-badge-lifecycle ${selected.lifecycle}`}>
                      {lifecycleLabel(selected.lifecycle, t)}
                    </span>
                  )}
                  {selected.ofkRef && (
                    <button
                      type="button"
                      className="memory-badge memory-badge-doc"
                      data-testid="memory-doc-link"
                      onClick={() => void openDocument(selected)}
                    >
                      {t('memory.docLink')}
                    </button>
                  )}
                </div>
                {selected.tags.length > 0 && (
                  <div className="memory-doc-tags">
                    {selected.tags.map((t) => (
                      <span className="memory-tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {(layeredAudit.core ||
                  layeredAudit.working ||
                  layeredAudit.archival ||
                  okfAudit) && (
                  <div className="memory-layered-audit" data-testid="memory-layered-audit">
                    {layeredAudit.core && (
                      <div className="memory-layered-block" data-testid="memory-core-audit">
                        <strong>Core</strong>
                        <div>
                          工作区：{layeredAudit.core.workspaceIdentity}；来源{' '}
                          {layeredAudit.core.entryIds.length} 条
                        </div>
                      </div>
                    )}
                    {(layeredAudit.working || layeredAudit.archival) && (
                      <div className="memory-layered-block" data-testid="memory-session-audit">
                        <strong>Session</strong>
                        {layeredAudit.working?.goal && <div>目标：{layeredAudit.working.goal}</div>}
                        {layeredAudit.working && layeredAudit.working.constraints.length > 0 && (
                          <div>约束：{layeredAudit.working.constraints.join('；')}</div>
                        )}
                        {layeredAudit.archival && (
                          <div>
                            召回：{layeredAudit.archival.triggeredBy}；
                            {layeredAudit.archival.reason}
                          </div>
                        )}
                      </div>
                    )}
                    {okfAudit && (
                      <div className="memory-layered-block" data-testid="memory-okf-audit">
                        <strong>OKF</strong>
                        <div>
                          {okfAudit.type ?? 'unknown'}；verified=
                          {okfAudit.verified ? 'true' : 'false'}；问题 {okfAudit.issues.length} 项
                        </div>
                        {okfAudit.issues.slice(0, 3).map((issue) => (
                          <div key={issue.code}>{issue.message}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {docView?.entryId === selected.entryId ? (
                  <div className="memory-doc-view" data-testid="memory-doc-view">
                    <button
                      type="button"
                      className="memory-doc-back"
                      data-testid="memory-doc-back"
                      onClick={() => {
                        setDocView(null);
                        setDocError(null);
                      }}
                    >
                      ← {t('memory.docBack')}
                    </button>
                    {docError && (
                      <div className="memory-doc-error" role="alert" data-testid="memory-doc-error">
                        {docError}
                      </div>
                    )}
                    <SafeMarkdown content={docView.content} variant="document" />
                  </div>
                ) : (
                  <>
                    {docError && (
                      <div className="memory-doc-error" role="alert" data-testid="memory-doc-error">
                        {docError}
                      </div>
                    )}
                    <EntryBody
                      entry={selected}
                      activeEntries={lists.active}
                      archivedEntries={lists.archived}
                      onOpenEntry={(e) => {
                        setDocView(null);
                        setDocError(null);
                        setSelectedId(e.entryId);
                      }}
                    />
                  </>
                )}
                {/* 关系面板:双链展示给用户(llm-wiki page-links-panel 同构) */}
                <div className="memory-relations" data-testid="memory-relations">
                  <div className="memory-relations-sec">
                    <span className="memory-relations-label">
                      {t('memory.relations.inbound', { count: relations.inbound.length })}
                    </span>
                    {relations.inbound.length === 0 && (
                      <span className="memory-relations-empty">{t('memory.relations.empty')}</span>
                    )}
                    {relations.inbound.map((r) => (
                      <button
                        type="button"
                        key={r.title}
                        className={`memory-relations-item ${r.active ? '' : 'dead'}`}
                        onClick={() => r.entry && setSelectedId(r.entry.entryId)}
                        disabled={!r.entry}
                        title={r.active ? '' : t('memory.relations.sourceArchived')}
                      >
                        ← {r.title}
                      </button>
                    ))}
                  </div>
                  <div className="memory-relations-sec">
                    <span className="memory-relations-label">
                      {t('memory.relations.outbound', { count: relations.outbound.length })}
                    </span>
                    {relations.outbound.length === 0 && (
                      <span className="memory-relations-empty">{t('memory.relations.empty')}</span>
                    )}
                    {relations.outbound.map((r) => (
                      <button
                        type="button"
                        key={r.title}
                        className={`memory-relations-item ${r.active ? '' : 'dead'}`}
                        onClick={() => r.entry && setSelectedId(r.entry.entryId)}
                        disabled={!r.entry}
                        title={r.active ? '' : t('memory.relations.targetArchived')}
                      >
                        → {r.title}
                      </button>
                    ))}
                  </div>
                </div>
                {selected.lifecycle === 'active' && (
                  <div className="memory-doc-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={t('memory.detail.edit')}
                      onClick={() => openEdit(selected)}
                    >
                      <PenLine className="btn-icon" aria-hidden="true" />
                      {t('memory.detail.edit')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={t('memory.detail.retire')}
                      onClick={() => void retireOne(selected.entryId)}
                    >
                      <Trash2 className="btn-icon" aria-hidden="true" />
                      {t('memory.detail.retire')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 编辑 dialog:title/content/basis/kind(类别可改 2026-08-10;evidence/scope 继承——铁律) */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && closeEdit()}>
        <DialogContent aria-label={t('memory.edit.title')}>
          <div className="memory-edit" data-testid="memory-edit-dialog">
            <h2 className="memory-edit-title">{t('memory.edit.title')}</h2>
            <label className="memory-field">
              <span>{t('memory.edit.titleField')}</span>
              <input
                aria-label={t('memory.edit.titleField')}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
              />
            </label>
            <label className="memory-field">
              <span>{t('memory.edit.contentField')}</span>
              <textarea
                aria-label={t('memory.edit.contentField')}
                rows={6}
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
              />
            </label>
            <label className="memory-field">
              <span>{t('memory.edit.kindField')}</span>
              <select
                aria-label={t('memory.edit.kindField')}
                value={draftKind}
                onChange={(e) => setDraftKind(e.target.value as MemoryKind)}
              >
                {MEMORY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {MEMORY_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="memory-field">
              <span>{t('memory.edit.basisField')}</span>
              <input
                aria-label={t('memory.edit.basisField')}
                value={draftBasis}
                onChange={(e) => setDraftBasis(e.target.value)}
              />
            </label>
            {editing && (
              <p className="memory-edit-note">
                {t('memory.edit.note', { evidence: MEMORY_EVIDENCE_LABELS[editing.evidence] })}
              </p>
            )}
            <div className="memory-edit-actions">
              <button type="button" className="btn btn-ghost" onClick={closeEdit}>
                {t('memory.edit.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!draftTitle.trim() || !draftContent.trim()}
                onClick={() => void saveEdit()}
              >
                {t('memory.edit.save')}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 素材消化入口已移除(2026-08-10):记忆是对话 loop 的产物,不在记忆页
 提供显式「喂素材」入口——设计文档 1.1 被否的入口思维。digest IPC
 能力保留,供对话侧/未来入口接入。 */}
    </main>
  );
}

/** 条目正文:全 kind 结构化 markdown 渲染(knowledge 双链可点击导航)。 */
function EntryBody({
  entry,
  activeEntries,
  archivedEntries,
  onOpenEntry,
}: {
  entry: MemoryEntry;
  activeEntries: MemoryEntry[];
  archivedEntries: MemoryEntry[];
  onOpenEntry: (entry: MemoryEntry) => void;
}): JSX.Element {
  const activeKnowledge = useMemo(
    () => activeEntries.filter((e) => e.kind === 'knowledge'),
    [activeEntries],
  );
  const archivedKnowledge = useMemo(
    () => archivedEntries.filter((e) => e.kind === 'knowledge'),
    [archivedEntries],
  );
  const resolved = useMemo(
    () => resolveWikilinks(entry.content, activeKnowledge, archivedKnowledge),
    [entry.content, activeKnowledge, archivedKnowledge],
  );
  const brokenTargets = useMemo(() => {
    const map = new Map<string, 'missing' | 'archived'>();
    for (const [target, res] of resolved) {
      if ('broken' in res) map.set(target, res.broken);
    }
    return map;
  }, [resolved]);

  const activateWikilink = useCallback(
    (target: string | null): void => {
      if (!target) return;
      const res = resolved.get(target);
      if (res && 'entry' in res) onOpenEntry(res.entry);
    },
    [resolved, onOpenEntry],
  );

  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest('span.wikilink');
      if (!(el instanceof HTMLElement)) return;
      if (el.hasAttribute('data-broken')) return;
      activateWikilink(el.getAttribute('data-target'));
    },
    [activateWikilink],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = (e.target as HTMLElement).closest('span.wikilink');
      if (!(el instanceof HTMLElement)) return;
      if (el.hasAttribute('data-broken')) return;
      e.preventDefault();
      activateWikilink(el.getAttribute('data-target'));
    },
    [activateWikilink],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: 文档正文是可变内容容器,role=group 表达「双链导航组」语义(fieldset 是表单分组语义,不适用);点击/键盘事件经内部 span.wikilink 委托,Enter/Space 可激活导航
    <div
      className="memory-doc-body"
      data-testid="knowledge-content"
      role="group"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <SafeMarkdown content={entry.content} variant="document" wikilinkBroken={brokenTargets} />
    </div>
  );
}
