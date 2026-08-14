/**
 * Today 页测试数据(agent-memory-today-timeline,,审查对齐后版本)。
 *
 * mock 数据 = 后端真实产出形状(独立审查 NO-GO 修复项):
 * 1. workspace = header.cwd 全路径形态(如 'E:/work/demo'),非占位短名
 * 2. byPeriod 只喂原始活跃毫秒数(≥60_000 的 ms 值);0-1 占比形态已被
 * 审查否决——任何把 byPeriod 当占比乘的渲染都会得到天文数字而变红
 * 3. IPC 信封 = 生产 SerializedResult {status:'ok',value} / {status:'error',error},
 * 与 src/main/ipc/today-ipc.ts 返回值同构;{ok:true} 视图形状是死分支,不喂
 * 4. workspaces[].color = 工作区 token 名('ws-1'..'ws-6'),
 * 浅/深双主题各配一套色值(ui-design/today-timeline-v2.html --ws-N),非 hex
 * 5. facts 形状与 src/shared/facts-schema.ts SessionFact 同源(类型即契约)
 */
import { type Mock, vi } from 'vitest';
import type { SessionFact } from '../../src/shared/facts-schema';
import type { SessionCategory, TimelineSegment } from '../../src/shared/ofk-schema';
import { isSessionCategory } from '../../src/shared/ofk-schema';
import { type LorraMock, makeLorraMock } from './lorra-test-helpers';

/** 生产 SessionFact(类型即契约,与 src/shared/facts-schema.ts 同源)。 */
export type TodaySessionFact = SessionFact;

export interface TodayDayStats {
  totalActiveMs: number;
  sessionCount: number;
  tokens: number;
  /** 时段分布:原始活跃毫秒数(morning<12 / afternoon 12-18 / evening≥18,本地时)。 */
  byPeriod: { morning: number; afternoon: number; evening: number };
}

export interface TodayWorkspaceStat {
  name: string;
  color: string;
  totalActiveMs: number;
}

/** 大类分区统计(与 src/main/memory/day-summary.ts TodayCategoryStat 同形)。 */
export interface TodayCategoryStat {
  category: SessionCategory;
  label: string;
  count: number;
  totalActiveMs: number;
}

export interface TodayDayData {
  facts: TodaySessionFact[];
  stats: TodayDayStats;
  workspaces: TodayWorkspaceStat[];
  categories: TodayCategoryStat[];
  /** 渲染段(生产聚合合成:LLM 段 > breaks 切段 > 单段);缺省按 facts 派生单段。 */
  segments: TimelineSegment[];
}

/** 工作区 = 会话 jsonl header.cwd 的全路径(与后端产出同形)。 */
export const WORKSPACE_A = 'E:/work/demo';
export const WORKSPACE_B = 'E:/work/side-project';
/** 设计系统工作区 token 名(ui-design v2 --ws-1..--ws-6,双主题自适应)。 */
export const WS_TOKEN_A = 'ws-1';
export const WS_TOKEN_B = 'ws-2';
export const WS_TOKEN_IDLE = 'ws-3';

/** 固定测试日 2026-08-08(本地时区),保证 start/end 落在同一自然日。 */
export function at(hour: number, minute = 0): number {
  return new Date(2026, 7, 8, hour, minute).getTime();
}

export function makeFact(
  over: Partial<TodaySessionFact> & { start: number; end: number },
): TodaySessionFact {
  return {
    schemaVersion: 1,
    collector: 'pi-sdk',
    runtime: 'pi-sdk',
    agentId: 'pi-sdk',
    sessionRef: `sess-${over.start}`,
    scope: 'workspace',
    summaryRef: null,
    privacy: 'public_safe',
    factId: `fact-${over.start}`,
    workspace: WORKSPACE_A,
    activeMs: over.end - over.start,
    title: '今日会话',
    tokens: 1234,
    model: 'claude-sonnet-4',
    tools: [],
    unfinished: false,
    containsTodo: false,
    ...over,
  };
}

/** 便捷造数:hour:minute 起、durMin 分钟长的会话。 */
export function fact(
  opts: { hour: number; minute?: number; durMin: number } & Partial<TodaySessionFact>,
): TodaySessionFact {
  const { hour, minute = 0, durMin, ...over } = opts;
  const start = at(hour, minute);
  return makeFact({ start, end: start + durMin * 60_000, activeMs: durMin * 60_000, ...over });
}

/** 便捷造段:生产聚合的渲染段形状(单段 = 整概念;无 LLM 段无 breaks 时)。 */
export function seg(f: TodaySessionFact, over?: Partial<TimelineSegment>): TimelineSegment {
  return {
    sessionRef: f.sessionRef,
    workspace: f.workspace,
    category: isSessionCategory(f.category) ? f.category : 'uncategorized',
    start: f.start,
    end: f.end,
    activeMs: f.activeMs,
    title: f.title,
    unfinished: f.unfinished,
    containsTodo: f.containsTodo,
    model: f.model,
    tools: f.tools,
    ...over,
  };
}

/** 标准一日:上午 wsA 30 分钟 + 下午 wsB 60 分钟(byPeriod 为原始毫秒)。 */
export function makeDayData(over?: Partial<TodayDayData>): TodayDayData {
  const { facts: overFacts, segments: overSegments, ...rest } = over ?? {};
  const facts = overFacts ?? [
    fact({ hour: 9, durMin: 30, workspace: WORKSPACE_A, title: '上午任务' }),
    fact({ hour: 14, durMin: 60, workspace: WORKSPACE_B, title: '下午任务' }),
  ];
  return {
    facts,
    stats: {
      totalActiveMs: facts.reduce((s, f) => s + f.activeMs, 0),
      sessionCount: facts.length,
      tokens: facts.reduce((s, f) => s + f.tokens, 0),
      byPeriod: { morning: 1_800_000, afternoon: 3_600_000, evening: 0 },
    },
    workspaces: [
      { name: WORKSPACE_A, color: WS_TOKEN_A, totalActiveMs: 1_800_000 },
      { name: WORKSPACE_B, color: WS_TOKEN_B, totalActiveMs: 3_600_000 },
    ],
    // 生产聚合(P1)对无 category 的概念恒产 uncategorized 分区;缺省即该形态。
    categories: [
      { category: 'uncategorized', label: '未分类', count: facts.length, totalActiveMs: 5_400_000 },
    ],
    // 渲染段:无 LLM 段无 breaks → 每概念单段(与最终 facts 同源派生)
    segments: overSegments ?? facts.map((f) => seg(f)),
    ...rest,
  };
}

/** 空日:一条事实都没有。 */
export function emptyDayData(): TodayDayData {
  return {
    facts: [],
    stats: {
      totalActiveMs: 0,
      sessionCount: 0,
      tokens: 0,
      byPeriod: { morning: 0, afternoon: 0, evening: 0 },
    },
    workspaces: [],
    categories: [],
    segments: [],
  };
}

// ---------------------------------------------------------------------------
// IPC 信封:生产 SerializedResult 形状(src/main/ipc/today-ipc.ts 返回值)。
// ---------------------------------------------------------------------------

export function okToday(data: TodayDayData): { status: 'ok'; value: TodayDayData } {
  return { status: 'ok', value: data };
}

export function errToday(
  code: string,
  message: string,
): { status: 'error'; error: { code: string; message: string } } {
  return { status: 'error', error: { code, message } };
}

// ---------------------------------------------------------------------------
// window.lorra mock(含今日页 IPC 面)
// ---------------------------------------------------------------------------

export interface TodayLorraMock extends LorraMock {
  today: { getDayFacts: Mock; onDayCompiled: Mock };
}

export function makeTodayLorraMock(): TodayLorraMock {
  const m = makeLorraMock() as TodayLorraMock;
  m.today = {
    getDayFacts: vi.fn(),
    // S6:订阅返回退订函数(组件 cleanup 调);回调由测试用例手动触发。
    onDayCompiled: vi.fn(() => () => {}),
  };
  return m;
}

export function installTodayLorraMock(): TodayLorraMock {
  const mock = makeTodayLorraMock();
  Object.defineProperty(window, 'lorra', {
    value: mock,
    writable: true,
    configurable: true,
  });
  return mock;
}
