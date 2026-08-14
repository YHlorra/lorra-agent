import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Hourglass,
  MessagesSquare,
  PieChart,
} from 'lucide-react';
import {
  Component,
  type CSSProperties,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAppStore } from '@/lib/app-store';
import { cn } from '@/lib/utils';
import type { TodayDayData } from '../main/memory/day-summary';
import type { MessageKey } from '../shared/i18n-core';
import {
  isSessionCategory,
  SESSION_CATEGORIES,
  SESSION_CATEGORY_LABELS,
  type SessionCategory,
  type TimelineSegment,
} from '../shared/ofk-schema';
import type { LorraError } from '../shared/result';
import { useT } from './lib/i18n';
import { ReviewRail } from './review-rail';

/** 词条取值函数形状(纯格式化模块函数经此参数注入,组件内传 useT 结果)。 */
type Tr = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * 今日页(agent-memory-today-timeline )。
 * 只读投影:所有数据经 window.lorra.today.getDayFacts IPC 获取,页面不持久化任何状态;
 * 打开期间监听会话活动事件/回前台 → 防抖重取,进行中会话时长增长可见。
 * 视觉对齐 ui-design/today-timeline-v2.html:hero KPI 卡 + 24h 纵向时间线 +
 * 归并块发丝接缝 + 空档标签 + 可点选图例 + 悬停 tooltip + 空态/错误态。
 */

/** 时间线几何(design.md D7):每小时 32px,块高∝active_ms,最小高度由 CSS 兜底。 */
export const PX_PER_HOUR = 32;
/** 甘特列间距(列宽百分比扣除量,视觉留缝)。 */
const GAP_PCT = 2;
/** 空档标签阈值:≥60 分钟的空档才标注(留白即信息)。 */
const GAP_LABEL_MS = 60 * 60_000;
/** 入场 stagger:28ms/块,上限 340ms(设计稿动效参数,MOTION 3/10)。 */
const ENTRANCE_STAGGER_MS = 28;
const ENTRANCE_STAGGER_MAX_MS = 340;
/** 实时重取防抖:活动事件/回前台后 1.5s 内合并为一次 IPC。 */
const REFRESH_DEBOUNCE_MS = 1500;

export interface TodayPageProps {
  /** 返回工作台(缺省走 app-store setPage('workspace'))。 */
  onBack?: () => void;
  /** 点击会话块下钻:通知宿主切工作区 + 开会话(缺省时本组件直接走 IPC,供独立使用)。 */
  onOpenSession?: (workspace: string, sessionId: string) => void;
}

interface TipState {
  block: TimelineSegment;
  x: number;
  y: number;
}

// 渲染层 IPC 响应兼容两种判别形状(公开契约 SerializedResult + 既有 RpcEnvelope/LorraResult 现状)。
type TodayResponse =
  | { status: 'ok'; value: TodayDayData }
  | { status: 'error'; error: LorraError }
  | { ok: true; value: TodayDayData }
  | { ok: false; error: LorraError };

function unwrapToday(
  res: TodayResponse,
): { ok: true; value: TodayDayData } | { ok: false; error: LorraError } {
  if ('status' in res) {
    return res.status === 'ok' ? { ok: true, value: res.value } : { ok: false, error: res.error };
  }
  return res;
}

/** ISO 字符串 / epoch ms / "HH:MM" 兜底 → 当日分钟数。 */
function minutesOfDay(iso: string | number): number {
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(iso));
  if (m) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0);
  return 0;
}

/** ISO 字符串 / epoch ms / "HH:MM" → "HH:MM"。 */
function fmtTime(iso: string | number): string {
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(String(iso));
  if (m) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  return String(iso);
}

/** 时长展示(design.md D6 口径,仅格式化不重算)。 */
function fmtDuration(ms: number, tr: Tr): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return tr('today.duration.hm', { h, m });
  if (h > 0) return tr('today.duration.h', { h });
  return tr('today.duration.m', { m });
}

function fmtTokens(n: number): string {
  return n.toLocaleString('zh-CN');
}

function fmtGap(ms: number, tr: Tr): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? tr('today.gap.hm', { h, m }) : tr('today.gap.h', { h });
  return tr('today.gap.m', { m });
}

/**
 * 区间堆叠(interval partitioning):段按 start 升序(同 start 按 end 升序),
 * 贪心放入第一个可容纳的列(laneEnds[i] <= seg.start);返回每段的列号(0 起)。
 * 列数无上限(重叠列数即最大重叠深度)。不做任何相邻段合并(语义段是细分单元)。
 */
export function assignLanes(segments: TimelineSegment[]): number[] {
  const sorted = segments
    .map((seg, idx) => ({ seg, idx }))
    .sort((a, b) => a.seg.start - b.seg.start || a.seg.end - b.seg.end);
  const laneEnds: number[] = [];
  const laneOf = new Array<number>(segments.length);
  for (const { seg, idx } of sorted) {
    const free = laneEnds.findIndex((end) => end <= seg.start);
    if (free === -1) {
      laneEnds.push(seg.end);
      laneOf[idx] = laneEnds.length - 1;
    } else {
      laneEnds[free] = seg.end;
      laneOf[idx] = free;
    }
  }
  return laneOf;
}

/** ≥60 分钟的空档给出淡色标签(00:00 起至 24:00)。 */
function gapRuns(segments: TimelineSegment[], tr: Tr): Array<{ centerMin: number; label: string }> {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const bounds: Array<[number, number]> = [];
  let prevEnd = 0;
  for (const seg of sorted) {
    const startMin = minutesOfDay(seg.start);
    const endMin = Math.max(minutesOfDay(seg.end), startMin);
    bounds.push([prevEnd, startMin]);
    prevEnd = Math.max(prevEnd, endMin);
  }
  bounds.push([prevEnd, 24 * 60]);
  const out: Array<{ centerMin: number; label: string }> = [];
  for (const [a, b] of bounds) {
    const gapMs = Math.max(0, b - a) * 60_000;
    if (gapMs >= GAP_LABEL_MS)
      out.push({
        centerMin: (a + b) / 2,
        label: tr('today.gap.label', { duration: fmtGap(gapMs, tr) }),
      });
  }
  return out;
}

/** 工作区色板回退 token(与 styles.css --ws-1..6 同源;缺省时按出现顺序取色)。 */
const FALLBACK_TOKENS = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6'] as const;

/** 本地日键 YYYY-MM-DD(与后端 day-summary.localDateString 同口径)。 */
function localDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayKey(): string {
  return localDateKey(new Date());
}

/** YYYY-MM-DD → 本地 Date(避免 ISO 日期按 UTC 解析导致跨日)。 */
function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** YYYY-MM-DD → "YYYY 年 M 月 D 日"(词条格式化,双语气象)。 */
function formatDateLabel(key: string, tr: Tr): string {
  const [y, m, d] = key.split('-').map(Number);
  return tr('today.date.format', { y, m, d });
}

/** 某月第一天(本地,避免 Date 月份进位)。 */
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** 周一为起首的 7 列月格(前后空位补 null);日期为本地日键。 */
function monthCells(year: number, month: number): Array<{ day: number; dateISO: string } | null> {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // 周一 → 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ day: number; dateISO: string } | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, dateISO: localDateKey(new Date(year, month, d)) });
  }
  return cells;
}

/** token 名 → CSS 变量引用;未知值回退 ws-1(不直接消费 hex,深浅主题由 token 自适应)。 */
function toColorVar(token: string | undefined): string {
  if (token && /^ws-\d+$/.test(token)) return `var(--${token})`;
  return 'var(--ws-1)';
}

/** 复盘栏错误边界:ReviewRail 渲染抛错时降级占位,不波及时间线/KPI(PM 需求①)。 */
interface RailBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}
class ReviewRailErrorBoundary extends Component<RailBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render(): JSX.Element {
    if (this.state.hasError) return <>{this.props.fallback}</>;
    return <>{this.props.children}</>;
  }
}

export function TodayPage({ onBack, onOpenSession }: TodayPageProps): JSX.Element {
  const setPage = useAppStore((s) => s.setPage);
  const t = useT();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [data, setData] = useState<TodayDayData | null>(null);
  const [error, setError] = useState<LorraError | null>(null);
  const [filterWs, setFilterWs] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  // 所选日期:null = 今天(getDayFacts 省略 dateISO);其他 = YYYY-MM-DD(本地日)。
  const [dateISO, setDateISO] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const selectedKey = dateISO ?? todayKey();
  const isToday = dateISO === null || dateISO === todayKey();

  const load = useCallback(
    (iso: string | null) => {
      let cancelled = false;
      setPhase('loading');
      Promise.resolve()
        .then(() => window.lorra?.today?.getDayFacts(iso ?? undefined))
        .then((res) => {
          if (cancelled) return;
          if (!res) throw new Error(t('today.channelUnavailable'));
          const unwrapped = unwrapToday(res as TodayResponse);
          if (unwrapped.ok) {
            setData(unwrapped.value);
            setPhase('ready');
          } else {
            setError(unwrapped.error);
            setPhase('error');
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError({
            code: 'today-load-failed',
            message: err instanceof Error ? err.message : String(err),
          });
          setPhase('error');
        });
      return () => {
        cancelled = true;
      };
    },
    [t],
  );

  // 只读投影:挂载仅 1 次(StrictMode 双挂载由 ref 守卫)。
  const didMount = useRef(false);
  useEffect(() => {
    if (didMount.current) return;
    didMount.current = true;
    return load(null); // 挂载默认今天
  }, [load]);

  // 每次日期切换重取 1 次(跳过首次挂载,避免与上面的挂载调用重复)。
  const skipFirstDateEffect = useRef(true);
  useEffect(() => {
    if (skipFirstDateEffect.current) {
      skipFirstDateEffect.current = false;
      return;
    }
    load(dateISO);
  }, [dateISO, load]);

  /** 日历 popover:打开态 + 显示月(打开时重置到所选日期所在月)。 */
  const [calOpen, setCalOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(() => startOfMonth(new Date()));
  const calRef = useRef<HTMLDivElement>(null);

  const openCalendar = useCallback(() => {
    setCalMonth(startOfMonth(dateFromKey(selectedKey)));
    setCalOpen(true);
  }, [selectedKey]);

  /** 选日:今天 = 回到今天(dateISO 置 null → 传今日或省略);其他 = 该日;随后关闭 popover。 */
  const selectDate = useCallback((iso: string) => {
    setDateISO(iso === todayKey() ? null : iso);
    setCalOpen(false);
  }, []);

  const backToToday = useCallback(() => {
    setDateISO(null);
    setCalOpen(false);
  }, []);

  const shiftMonth = useCallback((delta: number) => {
    setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  }, []);

  // 日历关闭:Esc / 点击 popover 外部。
  useEffect(() => {
    if (!calOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCalOpen(false);
    };
    const onPointer = (e: PointerEvent): void => {
      if (calRef.current && !calRef.current.contains(e.target as Node)) setCalOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [calOpen]);

  const calCells = useMemo(
    () => monthCells(calMonth.getFullYear(), calMonth.getMonth()),
    [calMonth],
  );
  const now = new Date();
  // 显示月 ≥ 当前月 → 不可再往后翻(整月为未来,日期全部禁用)。
  const nextMonthDisabled =
    calMonth.getTime() >= new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  /** 重试当前日期(IPC +1)。 */
  const retry = useCallback(() => {
    load(dateISO);
  }, [dateISO, load]);

  /** 静默重取:不切 loading,新数据到达后直接替换(事件触发的增量刷新)。 */
  const refresh = useCallback((iso: string | null) => {
    Promise.resolve()
      .then(() => window.lorra?.today?.getDayFacts(iso ?? undefined))
      .then((res) => {
        if (!res) return;
        const unwrapped = unwrapToday(res as TodayResponse);
        if (unwrapped.ok) {
          setData(unwrapped.value);
          setPhase('ready');
        }
      })
      .catch(() => {
        // 静默失败:保留现有数据,不打断页面。
      });
  }, []);

  const debounceRef = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      refresh(dateISO);
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh, dateISO]);

  // 页面实时性(审查 #5):会话活动事件 / visibilitychange 回前台 → 防抖重取,
  // 进行中会话时长增长可见。只读投影测试断言的是「挂载时 1 次调用」,事件触发增量不受影响。
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.lorra?.events?.subscribe(() => scheduleRefresh());
    } catch {
      // 事件通道不可用时退化为仅 visibilitychange。
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') scheduleRefresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      try {
        unsubscribe?.();
      } catch {
        // noop
      }
      document.removeEventListener('visibilitychange', onVisibility);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [scheduleRefresh]);

  const handleBack = useCallback(() => {
    if (onBack) onBack();
    else setPage('workspace');
  }, [onBack, setPage]);

  /** 点击块:切回工作台 + 开会话(段所属概念 = sessionRef)。 */
  const handleOpen = useCallback(
    (seg: TimelineSegment) => {
      setPage('workspace');
      if (onOpenSession) {
        onOpenSession(seg.workspace, seg.sessionRef);
      } else {
        // 独立使用兜底:直接走 IPC,不依赖宿主。
        void window.lorra.workspace?.activate(seg.workspace).catch(() => undefined);
        void window.lorra.session?.open({ sessionId: seg.sessionRef }).catch(() => undefined);
      }
    },
    [onOpenSession, setPage],
  );

  const showTip = useCallback((e: React.MouseEvent, seg: TimelineSegment) => {
    const rect = scrollerRef.current?.getBoundingClientRect();
    setTip({ block: seg, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
  }, []);

  const moveTip = useCallback((e: React.MouseEvent) => {
    setTip((prev) => {
      if (!prev) return prev;
      const rect = scrollerRef.current?.getBoundingClientRect();
      return { ...prev, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    });
  }, []);

  const hideTip = useCallback(() => setTip(null), []);

  /** 键盘 focus 同样可调出 tooltip(设计稿验收:focus 可达)。 */
  const showTipAt = useCallback((el: HTMLElement, seg: TimelineSegment) => {
    const scroller = scrollerRef.current;
    const rect = el.getBoundingClientRect();
    const sRect = scroller?.getBoundingClientRect();
    setTip({
      block: seg,
      x: (sRect ? rect.left - sRect.left : 0) + rect.width / 2,
      y: (sRect ? rect.top - sRect.top : 0) + rect.height / 2,
    });
  }, []);

  /**
 * 大类分区(plan D1 step 7 + 分段改造):TodayDayData.segments 驱动,按
 * categories 序;每分区 = 类名 + 计数 + 该类渲染段(先按 category 过滤,
 * 段内不再合并——语义段是细分单元;每分区独立做区间堆叠分列)。
 * 兜底:旧数据无 categories → 按 SESSION_CATEGORIES 序补齐;段缺失 → 空分区。
 */
  const categorySections = useMemo(() => {
    if (!data) return [];
    const segs = data.segments ?? [];
    const byCategory = new Map<SessionCategory, TimelineSegment[]>();
    for (const seg of segs) {
      const cat = isSessionCategory(seg.category) ? seg.category : 'uncategorized';
      const list = byCategory.get(cat) ?? [];
      list.push(seg);
      byCategory.set(cat, list);
    }
    const ordered: SessionCategory[] = [];
    const seen = new Set<SessionCategory>();
    for (const c of data.categories ?? []) {
      if (!seen.has(c.category) && byCategory.has(c.category)) {
        ordered.push(c.category);
        seen.add(c.category);
      }
    }
    for (const cat of SESSION_CATEGORIES) {
      if (byCategory.has(cat) && !seen.has(cat)) {
        ordered.push(cat);
        seen.add(cat);
      }
    }
    if (ordered.length === 0 && segs.length > 0) ordered.push('uncategorized');
    const statOf = new Map((data.categories ?? []).map((c) => [c.category, c]));
    return ordered.map((cat) => {
      const catSegs = byCategory.get(cat) ?? [];
      const lanes = assignLanes(catSegs);
      const laneCount = catSegs.length > 0 ? Math.max(...lanes) + 1 : 1;
      const stat = statOf.get(cat);
      return {
        category: cat,
        label: SESSION_CATEGORY_LABELS[cat],
        count: stat?.count ?? catSegs.length,
        totalActiveMs: stat?.totalActiveMs ?? catSegs.reduce((s, x) => s + x.activeMs, 0),
        segments: catSegs,
        lanes,
        laneCount,
        gaps: gapRuns(catSegs, t),
      };
    });
  }, [data, t]);
  // 工作区信息:以投影 workspaces 为准(颜色/时长同源);图例只列当日有活动(时长>0)的工作区。
  // 事实中出现但投影未列出的工作区:块着色回退色板,不进图例(design「退出的工作区不出现」)。
  const wsInfo = useMemo(() => {
    const map = new Map<string, { color: string; totalActiveMs: number }>();
    const workspaces = data?.workspaces ?? [];
    let idx = 0;
    for (const ws of workspaces) {
      map.set(ws.name, {
        color: ws.color || FALLBACK_TOKENS[idx % FALLBACK_TOKENS.length],
        totalActiveMs: ws.totalActiveMs,
      });
      idx++;
    }
    for (const f of data?.facts ?? []) {
      if (!map.has(f.workspace)) {
        map.set(f.workspace, {
          color: FALLBACK_TOKENS[idx % FALLBACK_TOKENS.length],
          totalActiveMs: 0,
        });
        idx++;
      }
    }
    return map;
  }, [data]);
  const colorOf = useCallback((name: string) => wsInfo.get(name)?.color ?? 'ws-1', [wsInfo]);
  const legendEntries = useMemo(
    () =>
      Array.from(wsInfo.entries())
        .filter(([, info]) => info.totalActiveMs > 0)
        .map(([name, info]) => ({ name, color: info.color, totalActiveMs: info.totalActiveMs })),
    [wsInfo],
  );

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = (nowMin * PX_PER_HOUR) / 60;

  const head = (
    <header className="today-head">
      <button type="button" className="back-btn" aria-label={t('today.back')} onClick={handleBack}>
        <ArrowLeft aria-hidden="true" />
      </button>
      <div className="head-title">
        <h1>
          <CalendarDays className="tl-icon" aria-hidden="true" />
          {t('nav.today')}
        </h1>
        {/* 日期区:点击日期(或日历图标)弹出月份日历 popover 选日期;原前一天/后一天按钮已删。 */}
        <div className="head-date">
          <button
            type="button"
            className="date-label-btn"
            data-testid="today-date-label"
            aria-haspopup="dialog"
            aria-expanded={calOpen}
            onClick={openCalendar}
          >
            {formatDateLabel(selectedKey, t)}
            <ChevronDown className="cal-chev" aria-hidden="true" />
          </button>
          <span className="head-date-note">{t('today.dateNote')}</span>
          {calOpen && (
            <div
              className="today-calendar"
              data-testid="today-calendar"
              ref={calRef}
              role="dialog"
              aria-label={t('today.calendar.label')}
            >
              <div className="cal-head">
                <button
                  type="button"
                  className="cal-nav"
                  aria-label={t('today.calendar.prevMonth')}
                  onClick={() => shiftMonth(-1)}
                >
                  <ChevronLeft aria-hidden="true" />
                </button>
                <span className="cal-title">
                  {t('today.calendar.title', {
                    year: calMonth.getFullYear(),
                    month: calMonth.getMonth() + 1,
                  })}
                </span>
                <button
                  type="button"
                  className="cal-nav"
                  aria-label={t('today.calendar.nextMonth')}
                  onClick={() => shiftMonth(1)}
                  disabled={nextMonthDisabled}
                >
                  <ChevronRight aria-hidden="true" />
                </button>
              </div>
              <div className="cal-week" aria-hidden="true">
                {t('today.calendar.weekdays')
                  .split(',')
                  .map((w) => (
                    <span key={w}>{w}</span>
                  ))}
              </div>
              <div className="cal-grid">
                {calCells.map((c, i) => {
                  if (!c) return <span key={`pad-${i}`} className="cal-pad" aria-hidden="true" />;
                  const isFuture = c.dateISO > todayKey();
                  const isSelected = c.dateISO === selectedKey;
                  const isTodayCell = c.dateISO === todayKey();
                  return (
                    <button
                      key={c.dateISO}
                      type="button"
                      className={cn(
                        'cal-day',
                        isSelected && 'is-selected',
                        isTodayCell && 'is-today',
                      )}
                      data-date={c.dateISO}
                      disabled={isFuture}
                      aria-label={formatDateLabel(c.dateISO, t)}
                      onClick={() => selectDate(c.dateISO)}
                    >
                      {c.day}
                      {isTodayCell && <i className="cal-dot" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
              {!isToday && (
                <button type="button" className="cal-back-today" onClick={backToToday}>
                  {t('today.calendar.backToday')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );

  const ready = phase === 'ready' && data !== null && data.facts.length > 0;
  // PM 需求①:数据通道故障时时间线骨架仍渲染(刻度/网格线在位),不整页替换。
  const isEmpty = phase === 'ready' && data !== null && data.facts.length === 0;
  // KPI 卡恒渲染(除纯加载):有数据取 stats,空/错误相位零值占位(PM 需求②)。
  const stats = data?.stats ?? {
    totalActiveMs: 0,
    sessionCount: 0,
    tokens: 0,
    byPeriod: { morning: 0, afternoon: 0, evening: 0 },
  };
  const byPeriod = stats.byPeriod;
  const showStats = phase !== 'loading';
  // 时段分布:后端发原始活跃毫秒;占比唯一路径 = ms/总和(seg-bar 宽度),总和 0 → 空分布。
  const periodSum = byPeriod
    ? Math.max(byPeriod.morning, 0) +
      Math.max(byPeriod.afternoon, 0) +
      Math.max(byPeriod.evening, 0)
    : 0;
  const pct = (r: number): string => {
    const ratio = periodSum > 0 ? Math.max(0, r) / periodSum : 0;
    return `${(ratio * 100).toFixed(1)}%`;
  };

  const tooltipWidth = 320;
  const tipLeft = tip
    ? Math.max(8, Math.min(tip.x, (scrollerRef.current?.clientWidth ?? 0) - tooltipWidth - 8))
    : 0;

  return (
    <main className="today-page" data-testid="today-page">
      {head}

      {/* KPI 统计头(恒渲染,PM 需求②):phase ready 且有数据 → 真实数字(取 stats 不重算);
 空数据/加载错误 → 零值卡(数字 0、空分布)。图例仅当有活动工作区时渲染。 */}
      {showStats && (
        <>
          {/* KPI 统计头:数字直接取 stats,不做前端重算(hero 卡承载总量先看)。
 DOM 顺序 value 先行(textContent 契约),视觉顺序由 CSS flex order 还原为 label 在上。 */}
          <section className="stats" aria-label={t('today.stats.label')}>
            <div className="stat-card hero" data-testid="today-kpi" data-metric="total-active">
              <div className="stat-value">{fmtDuration(stats.totalActiveMs, t)}</div>
              <div className="stat-label">
                <Hourglass aria-hidden="true" /> {t('today.stats.totalLabel')}
              </div>
              <div className="stat-sub">{t('today.stats.totalSub')}</div>
            </div>
            <div className="stat-card" data-testid="today-kpi" data-metric="session-count">
              <div className="stat-value">{stats.sessionCount}</div>
              <div className="stat-label">
                <MessagesSquare aria-hidden="true" /> {t('today.stats.sessionsLabel')}
              </div>
              <div className="stat-sub">{t('today.stats.sessionsSub')}</div>
            </div>
            <div className="stat-card" data-testid="today-kpi" data-metric="tokens">
              <div className="stat-value">{fmtTokens(stats.tokens)}</div>
              <div className="stat-label">
                <Cpu aria-hidden="true" /> {t('today.stats.tokensLabel')}
              </div>
              <div className="stat-sub">{t('today.stats.tokensSub')}</div>
            </div>
            <div className="stat-card" data-testid="today-kpi" data-metric="period">
              <div className="stat-label">
                <PieChart aria-hidden="true" /> {t('today.stats.periodLabel')}
              </div>
              <div className="seg-bar" aria-hidden="true">
                <i className="seg-1" style={{ width: pct(byPeriod.morning) }} />
                <i className="seg-2" style={{ width: pct(byPeriod.afternoon) }} />
                <i className="seg-3" style={{ width: pct(byPeriod.evening) }} />
              </div>
              <div className="seg-legend">
                <span data-testid="today-kpi" data-metric="period-morning">
                  <i className="seg-dot s1" aria-hidden="true" />
                  {t('today.stats.morning')} {fmtDuration(byPeriod.morning, t)}
                </span>
                <span data-testid="today-kpi" data-metric="period-afternoon">
                  <i className="seg-dot s2" aria-hidden="true" />
                  {t('today.stats.afternoon')} {fmtDuration(byPeriod.afternoon, t)}
                </span>
                <span data-testid="today-kpi" data-metric="period-evening">
                  <i className="seg-dot s3" aria-hidden="true" />
                  {t('today.stats.evening')} {fmtDuration(byPeriod.evening, t)}
                </span>
              </div>
            </div>
          </section>

          {/* 工作区图例:可点选高亮对应会话块;颜色与时间线块同源(data-color)。
 空数据时无活动工作区,不渲染(与恒渲染的 KPI 卡解耦)。 */}
          {legendEntries.length > 0 && (
            <section
              className="legend"
              aria-label={t('today.legend.label')}
              data-testid="today-legend"
            >
              <span className="legend-label">{t('today.legend.title')}</span>
              {legendEntries.map((ws) => {
                const on = filterWs === ws.name;
                return (
                  <button
                    key={ws.name}
                    type="button"
                    data-testid="today-legend-item"
                    data-workspace={ws.name}
                    className={cn('legend-chip', on && 'is-on')}
                    aria-pressed={on}
                    data-color={ws.color}
                    style={{ '--chip-color': toColorVar(ws.color) } as CSSProperties}
                    onClick={() => setFilterWs(on ? null : ws.name)}
                  >
                    <i className="legend-dot" aria-hidden="true" />
                    {ws.name}
                    <span className="dur">{fmtDuration(ws.totalActiveMs, t)}</span>
                  </button>
                );
              })}
            </section>
          )}
        </>
      )}

      <div className="today-body">
        <div className="timeline-wrap">
          <div className="timeline-head">
            <span>{t('today.timeline.head')}</span>
            <span className="mode-hint">{t('today.timeline.hint')}</span>
          </div>
          <div className="timeline-scroll" ref={scrollerRef}>
            <div className="timeline">
              <div className="tl-axis" aria-hidden="true" />
              {/* 时间线骨架(PM 需求①):加载/错误时单条刻度轨道恒在位,
 数据通道故障也不整页替换。 */}
              {(phase === 'loading' || phase === 'error') && (
                <div className="tl-lane">
                  {/* 时间轴刻度(设计定稿 v2):每 2 小时标号,0:00/2:00/.../22:00 共 12 个 */}
                  {Array.from({ length: 12 }, (_, i) => i * 2).map((h) => (
                    <div
                      key={h}
                      className="tl-tick"
                      data-testid="today-hour"
                      data-hour={h}
                      style={{ top: `${h * PX_PER_HOUR}px` }}
                      aria-hidden="true"
                    >
                      <span>{String(h).padStart(2, '0')}:00</span>
                    </div>
                  ))}
                  {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                    <div
                      key={h}
                      className={cn('tl-gridline', h % 2 === 0 && 'major')}
                      style={{ top: `${h * PX_PER_HOUR}px` }}
                      aria-hidden="true"
                    />
                  ))}
                </div>
              )}
              {/* 有数据:按大类分区(step 7)——每分区 = 类名标题 + 计数 +
 该类会话块(独立 24h 轨道,块仍按时间定位) */}
              {ready && data && (
                <>
                  {categorySections.map((sec) => (
                    <section
                      key={sec.category}
                      className="tl-cat"
                      data-testid="today-category"
                      data-category={sec.category}
                    >
                      <div className="tl-cat-head">
                        <span className="tl-cat-name">{sec.label}</span>
                        <span className="tl-cat-count" data-testid="today-category-count">
                          {sec.count}
                        </span>
                      </div>
                      <div className="tl-lane">
                        {/* 时间轴刻度(每分区一条 24h 轨道) */}
                        {Array.from({ length: 12 }, (_, i) => i * 2).map((h) => (
                          <div
                            key={h}
                            className="tl-tick"
                            data-testid="today-hour"
                            data-hour={h}
                            style={{ top: `${h * PX_PER_HOUR}px` }}
                            aria-hidden="true"
                          >
                            <span>{String(h).padStart(2, '0')}:00</span>
                          </div>
                        ))}
                        {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                          <div
                            key={h}
                            className={cn('tl-gridline', h % 2 === 0 && 'major')}
                            style={{ top: `${h * PX_PER_HOUR}px` }}
                            aria-hidden="true"
                          />
                        ))}
                        {/* 当前时刻线(仅今天;查看历史日期不渲染) */}
                        {isToday && (
                          <div
                            className="tl-now"
                            data-testid="today-now-line"
                            style={{ top: `${nowTop}px` }}
                            aria-hidden="true"
                          >
                            <span className="now-tag">
                              {t('today.nowTag', {
                                time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
                              })}
                            </span>
                          </div>
                        )}
                        {/* 空档标签:≥60 分钟的空档是有效信息 */}
                        {sec.gaps.map((g, i) => (
                          <div
                            key={i}
                            className="tl-gap"
                            style={{ top: `${(g.centerMin * PX_PER_HOUR) / 60}px` }}
                          >
                            {g.label}
                          </div>
                        ))}
                        {/* 会话块:top∝段开始时刻,height∝段 active_ms;left/width 按
 lane 分列(区间堆叠,重叠段并排不覆盖);颜色与图例同源 */}
                        {sec.segments.map((seg, i) => {
                          const color = colorOf(seg.workspace);
                          const startMin = minutesOfDay(seg.start);
                          const top = (startMin * PX_PER_HOUR) / 60;
                          const unfinished = seg.unfinished;
                          // 未完成段(设计定稿 v2):今天延伸至当前时刻线(start→now),受最小高度约束;
                          // 查看历史日期(非今天)时高度按 activeMs,不延伸。
                          const height =
                            unfinished && isToday
                              ? Math.max(((nowMin - startMin) * PX_PER_HOUR) / 60, 2)
                              : Math.max((seg.activeMs * PX_PER_HOUR) / 3_600_000, 2);
                          const dimmed = filterWs !== null && filterWs !== seg.workspace;
                          const laneIdx = sec.lanes[i];
                          const laneWidthPct = 100 / sec.laneCount;
                          const delay = Math.min(i * ENTRANCE_STAGGER_MS, ENTRANCE_STAGGER_MAX_MS);
                          return (
                            <button
                              key={`${seg.workspace}-${seg.sessionRef}-${seg.start}`}
                              type="button"
                              data-testid="today-block"
                              data-workspace={seg.workspace}
                              data-session-count={1}
                              data-category={seg.category}
                              data-unfinished={unfinished ? 'true' : undefined}
                              className={cn(
                                'tl-block',
                                'tl-seg',
                                'in',
                                dimmed && 'dim',
                                unfinished && 'unfinished',
                              )}
                              style={
                                {
                                  top: `${top}px`,
                                  height: `${height}px`,
                                  left: `${laneIdx * laneWidthPct}%`,
                                  width: `${laneWidthPct - GAP_PCT}%`,
                                  animationDelay: `${delay}ms`,
                                  '--block-color': toColorVar(color),
                                } as CSSProperties
                              }
                              data-color={color}
                              onClick={() => handleOpen(seg)}
                              onMouseEnter={(e) => showTip(e, seg)}
                              onMouseMove={moveTip}
                              onMouseLeave={hideTip}
                              onFocus={(e) => showTipAt(e.currentTarget, seg)}
                              onBlur={hideTip}
                            >
                              <span className="tl-block-inner">
                                <span className="b-time">
                                  {fmtTime(seg.start)}–{fmtTime(seg.end)}
                                </span>
                                {unfinished && (
                                  <span className="b-badge">{t('today.block.unfinished')}</span>
                                )}
                                <span className="b-title">{seg.summary ?? seg.title}</span>
                                <span className="b-dur">{fmtDuration(seg.activeMs, t)}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                  {/* 悬停详情(工作区/起止/时长/模型/Token/工具数;token 取概念事实) */}
                  {tip && (
                    <div
                      className="tl-tooltip show"
                      role="tooltip"
                      style={{
                        left: tipLeft,
                        top: Math.max(
                          8,
                          Math.min(tip.y, (scrollerRef.current?.clientHeight ?? 0) - 160),
                        ),
                      }}
                    >
                      <div className="tt-title">{tip.block.workspace}</div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.period')}</span>
                        <span className="tt-v">
                          {fmtTime(tip.block.start)} – {fmtTime(tip.block.end)}
                        </span>
                      </div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.duration')}</span>
                        <span className="tt-v">{fmtDuration(tip.block.activeMs, t)}</span>
                      </div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.model')}</span>
                        <span className="tt-v">{tip.block.model}</span>
                      </div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.tokens')}</span>
                        <span className="tt-v">
                          {fmtTokens(
                            data?.facts.find((f) => f.sessionRef === tip.block.sessionRef)
                              ?.tokens ?? 0,
                          )}
                        </span>
                      </div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.tools')}</span>
                        <span className="tt-v">{tip.block.tools.join('、')}</span>
                      </div>
                    </div>
                  )}
                </>
              )}
              {phase === 'loading' && (
                <div className="today-loading" role="status">
                  <span className="orb" aria-hidden="true" />
                  {t('today.loading')}
                </div>
              )}
              {phase === 'error' && (
                <div className="tl-timeline-error" data-testid="today-timeline-error" role="alert">
                  <span className="tl-timeline-error-msg">
                    {error?.message ?? t('today.errorFallback')}
                  </span>
                  <button type="button" className="btn btn-primary" onClick={retry}>
                    {t('today.retry')}
                  </button>
                </div>
              )}
              {isEmpty && (
                <div className="tl-empty" data-testid="today-empty">
                  <CalendarDays aria-hidden="true" />
                  <div className="e-title">{t('today.empty.title')}</div>
                  <div className="e-sub">{t('today.empty.sub')}</div>
                  <div className="e-back">
                    <button type="button" className="btn btn-primary" onClick={handleBack}>
                      {t('today.empty.back')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* 复盘栏:今日/本周深度复盘入口 + 模块勾选 + 历史列表 + modal 阅读。
 React 错误边界:渲染抛错时降级占位,不波及时间线/KPI(PM 需求①)。 */}
        <aside className="reviews">
          <ReviewRailErrorBoundary
            fallback={
              <div className="review-rail-fallback" data-testid="review-rail-fallback">
                {t('today.reviewFallback')}
              </div>
            }
          >
            <ReviewRail />
          </ReviewRailErrorBoundary>
        </aside>
      </div>
    </main>
  );
}
