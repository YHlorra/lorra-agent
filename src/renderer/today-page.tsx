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
import { ThinkingOrb } from 'thinking-orbs';
import { useAppStore } from '@/lib/app-store';
import { cn } from '@/lib/utils';
import type { TodayDayData } from '../main/memory/day-summary';
import type { MessageKey } from '../shared/i18n-core';
import type { TimelineSegment } from '../shared/ofk-schema';
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

/** 时间线几何:每小时 64px(24h = 1536px),块高 ∝ active_ms,最小高度 BLOCK_MIN_PX 兜底。 */
export const PX_PER_HOUR = 64;
/** 块最小高度(与 CSS --tl-block-min-h 同源):保证单行文字可读。 */
const BLOCK_MIN_PX = 24;
/** 同列相邻块垂直缝(下推留缝,块互不覆盖)。 */
const BLOCK_GAP_PX = 2;
/** 甘特列缝(宽度百分比扣除量,视觉留缝)。 */
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

/** 分区内每块的最终几何:会话列号/列数 + 下推后的 top/height(px,相对本分区轨道)。 */
export interface BlockLayout {
  lane: number;
  laneCount: number;
  top: number;
  height: number;
}

/**
 * 会话分列(2026-08-17 按会话数量均分):每段一列,列号 = sessionRef 首次出现序
 * (按 start 升序),列数 N = 当日不同会话数;宽 = 100/N − 缝、left = 列号 × 100/N,
 * 列不相交(N=1 时单块宽 98% 占整行是公式自然结果,单会话无列可分)。
 * 同一会话的多段共享同一列并纵向堆叠;跨会话列垂直重叠不互推(列水平不相交)。
 * 第二遍按时间序全局下推:height = max(时长高, 最小高),仅同 lane 前块底 + 缝
 * 超过本块时间位时下推留缝(只推不拉,最小高度撑出时段不越位)。
 * 未完成段(今天)延伸至当前时刻线 nowTop;完成段(今天)的最小高度延伸
 * 不得越过当前时刻线(会越线时截断回自然时长高,线下方是未来);
 * 历史日期 nowTop 传 null 按 activeMs。
 */
export function layoutSection(
  segments: TimelineSegment[],
  opts: { pxPerHour: number; minH: number; gap: number; nowTop: number | null },
): BlockLayout[] {
  const order = segments
    .map((seg, idx) => ({ seg, idx }))
    .sort(
      (a, b) =>
        a.seg.start - b.seg.start ||
        a.seg.end - b.seg.end ||
        a.seg.sessionRef.localeCompare(b.seg.sessionRef),
    );
  const laneOf = new Map<string, number>();
  for (const { seg } of order) {
    if (!laneOf.has(seg.sessionRef)) laneOf.set(seg.sessionRef, laneOf.size);
  }
  const laneCount = laneOf.size;
  if (laneCount === 0) return [];
  const placed = new Array<{ lane: number; top: number; height: number }>(segments.length);
  for (const { seg, idx } of order) {
    const top0 = (minutesOfDay(seg.start) * opts.pxPerHour) / 60;
    const activeH = (seg.activeMs * opts.pxPerHour) / 3_600_000;
    const height =
      seg.unfinished && opts.nowTop !== null
        ? Math.max(opts.nowTop - top0, opts.minH)
        : opts.nowTop !== null && top0 + Math.max(activeH, opts.minH) > opts.nowTop
          ? activeH // 完成块最小高度延伸不得越过当前时刻线 → 截断回自然时长高
          : Math.max(activeH, opts.minH);
    placed[idx] = { lane: laneOf.get(seg.sessionRef) ?? 0, top: top0, height };
  }
  // 第二遍按时间序全局下推:会话列不相交,跨列垂直重叠不遮挡;
  // 仅同 lane 前块(最小高度撑出时段)底部越界时下推留缝(只推不拉,不越位)。
  const out = new Array<BlockLayout>(segments.length);
  for (let k = 0; k < order.length; k++) {
    const p = placed[order[k].idx];
    for (let j = 0; j < k; j++) {
      const q = placed[order[j].idx];
      if (q.lane === p.lane) p.top = Math.max(p.top, q.top + q.height + opts.gap);
    }
    out[order[k].idx] = { lane: p.lane, laneCount, top: p.top, height: p.height };
  }
  return out;
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

/** 智能体显示名映射(collector → 展示名;未知回退原串)。 */
const AGENT_LABELS: Record<string, string> = {
  'pi-sdk': 'lorra',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  'oh-my-pi': 'Oh My Pi',
  workbuddy: 'WorkBuddy',
};

/**
 * 标签 → 色板 token 稳定映射(与后端 workspaceColor 同款 31 哈希 % 6;
 * renderer 不引 main 模块,复制同源算法,token 名与 --ws-N 同源)。
 */
function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_TOKENS[hash % FALLBACK_TOKENS.length];
}

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
  const theme = useAppStore((s) => s.theme);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [data, setData] = useState<TodayDayData | null>(null);
  const [error, setError] = useState<LorraError | null>(null);
  const [filterTag, setFilterTag] = useState<string | null>(null);
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
          if (res.ok) {
            setData(res.value);
            setPhase('ready');
          } else {
            setError(res.error);
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
        if (res.ok) {
          setData(res.value);
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
  // 进行中会话时长增长可见。S6 增:后台编译完成推送(lorra.today.dayCompiled)
  // → 同款防抖重取(编译完成的大类分区/分段自动出现)。只读投影测试断言的是
  // 「挂载时 1 次调用」,事件触发增量不受影响。
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let unsubscribeDayCompiled: (() => void) | undefined;
    try {
      unsubscribe = window.lorra?.events?.subscribe(() => scheduleRefresh());
      unsubscribeDayCompiled = window.lorra?.today?.onDayCompiled?.(() => scheduleRefresh());
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
        unsubscribeDayCompiled?.();
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
   * 单条 24h 轨道(2026-08-14 标签分类改造):不再按类别分区;所有段合成
   * 一条时间线,块颜色 = tag(tagColor),tag 过滤 chip 行 + 图例做筛选。
   */
  const allSegments = useMemo(
    () => [...(data?.segments ?? [])].sort((a, b) => a.start - b.start || a.end - b.end),
    [data],
  );
  const allGaps = useMemo(() => gapRuns(allSegments, t), [allSegments, t]);
  // 单轨几何(局部簇分列 + 甘特不相交列 + 最小高度下推):今天未完成段延伸至当前时刻线。
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = (nowMin * PX_PER_HOUR) / 60;

  const sectionLayouts = useMemo(() => {
    const extendTop = isToday ? nowTop : null;
    return [
      layoutSection(allSegments, {
        pxPerHour: PX_PER_HOUR,
        minH: BLOCK_MIN_PX,
        gap: BLOCK_GAP_PX,
        nowTop: extendTop,
      }),
    ];
  }, [allSegments, isToday, nowTop]);
  // 标签统计与图例:以聚合 categories(段计数/段时长)为准;图例 = 当日出现的标签。
  const tagStats = useMemo(() => {
    const map = new Map<string, { count: number; totalActiveMs: number }>();
    for (const c of data?.categories ?? []) {
      const prev = map.get(c.category) ?? { count: 0, totalActiveMs: 0 };
      map.set(c.category, {
        count: prev.count + c.count,
        totalActiveMs: prev.totalActiveMs + c.totalActiveMs,
      });
    }
    return map;
  }, [data]);
  const legendEntries = useMemo(
    () =>
      Array.from(tagStats.entries()).map(([tag, stat]) => ({
        tag,
        color: tagColor(tag),
        count: stat.count,
        totalActiveMs: stat.totalActiveMs,
      })),
    [tagStats],
  );

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

          {/* 标签图例:可点选高亮对应会话块;颜色与时间线块同源(data-color)。
 空数据时无标签出现,不渲染(与恒渲染的 KPI 卡解耦)。 */}
          {legendEntries.length > 0 && (
            <section
              className="legend"
              aria-label={t('today.legend.label')}
              data-testid="today-legend"
            >
              <span className="legend-label">{t('today.legend.title')}</span>
              {legendEntries.map((tag) => {
                const on = filterTag === tag.tag;
                return (
                  <button
                    key={tag.tag}
                    type="button"
                    data-testid="today-legend-item"
                    data-tag={tag.tag}
                    className={cn('legend-chip', on && 'is-on')}
                    aria-pressed={on}
                    data-color={tag.color}
                    style={{ '--chip-color': toColorVar(tag.color) } as CSSProperties}
                    onClick={() => setFilterTag(on ? null : tag.tag)}
                  >
                    <i className="legend-dot" aria-hidden="true" />
                    {tag.tag}
                    <span className="dur">{tag.count}</span>
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
                  <section className="tl-cat" data-testid="today-category" data-category="all">
                    <div className="tl-cat-head">
                      <span className="tl-cat-name">{t('today.timeline.sectionAll')}</span>
                      <span className="tl-cat-count" data-testid="today-category-count">
                        {allSegments.length}
                      </span>
                    </div>
                    {/* 标签过滤 chip 行:全部 + 当日出现的标签(色点 = tagColor);点击过滤 */}
                    <div className="tag-filter" data-testid="today-tag-filter">
                      <button
                        type="button"
                        className={cn('tag-chip', filterTag === null && 'is-on')}
                        data-tag="all"
                        aria-pressed={filterTag === null}
                        onClick={() => setFilterTag(null)}
                      >
                        {t('today.filter.all')}
                      </button>
                      {legendEntries.map((tag) => (
                        <button
                          key={tag.tag}
                          type="button"
                          className={cn('tag-chip', filterTag === tag.tag && 'is-on')}
                          data-tag={tag.tag}
                          aria-pressed={filterTag === tag.tag}
                          style={{ '--chip-color': toColorVar(tag.color) } as CSSProperties}
                          onClick={() => setFilterTag(filterTag === tag.tag ? null : tag.tag)}
                        >
                          <i className="legend-dot" aria-hidden="true" />
                          {tag.tag}
                          <span className="dur">{tag.count}</span>
                        </button>
                      ))}
                    </div>
                    <div className="tl-lane">
                      {/* 时间轴刻度(单条 24h 轨道) */}
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
                      {allGaps.map((g, i) => (
                        <div
                          key={i}
                          className="tl-gap"
                          style={{ top: `${(g.centerMin * PX_PER_HOUR) / 60}px` }}
                        >
                          {g.label}
                        </div>
                      ))}
                      {/* 会话块:top∝段开始时刻(下推只推不拉),height∝段 active_ms 且
 ≥ 最小高度;同会话列相邻块下推留缝互不覆盖;会话分列——
 宽 = 100/会话数 − 2% 缝、left = 会话列号 × 100/会话数,列不相交 */}
                      {allSegments.map((seg, i) => {
                        const color = tagColor(seg.category);
                        const unfinished = seg.unfinished;
                        const geo = sectionLayouts[0][i];
                        const dimmed = filterTag !== null && filterTag !== seg.category;
                        const colW = 100 / geo.laneCount;
                        const delay = Math.min(i * ENTRANCE_STAGGER_MS, ENTRANCE_STAGGER_MAX_MS);
                        return (
                          <button
                            key={`${seg.workspace}-${seg.sessionRef}-${seg.start}`}
                            type="button"
                            data-testid="today-block"
                            data-workspace={seg.workspace}
                            data-tag={seg.category}
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
                                top: `${geo.top}px`,
                                height: `${geo.height}px`,
                                left: `${geo.lane * colW}%`,
                                width: `${colW - GAP_PCT}%`,
                                animationDelay: `${delay}ms`,
                                '--block-color': toColorVar(color),
                                '--z': String(geo.lane + 1),
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
                                <>
                                  {/* 进行中光球(thinking-orbs breathing):时间线唯一持续动效,
 与聊天窗思考环同组件同语汇;theme 随 深浅。 */}
                                  <span className="tl-live-orb" aria-hidden="true">
                                    <ThinkingOrb state="breathing" size={20} theme={theme} />
                                  </span>
                                  <span className="b-badge">{t('today.block.unfinished')}</span>
                                </>
                              )}
                              <span className="b-title">{seg.summary ?? seg.title}</span>
                              <span className="b-dur">{fmtDuration(seg.activeMs, t)}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                  {/* 悬停详情(标题/起止/标签/智能体/时长) */}
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
                      <div className="tt-title">{tip.block.summary ?? tip.block.title}</div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.period')}</span>
                        <span className="tt-v">
                          {fmtTime(tip.block.start)} – {fmtTime(tip.block.end)}
                        </span>
                      </div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.tag')}</span>
                        <span className="tt-v">{tip.block.category}</span>
                      </div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.agent')}</span>
                        <span className="tt-v">
                          {AGENT_LABELS[tip.block.collector] ?? tip.block.collector}
                        </span>
                      </div>
                      <div className="tt-row">
                        <span className="tt-k">{t('today.tooltip.duration')}</span>
                        <span className="tt-v">{fmtDuration(tip.block.activeMs, t)}</span>
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
