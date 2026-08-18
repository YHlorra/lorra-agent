import type { SessionFact } from '../../shared/facts-schema';
import type { TimelineSegment } from '../../shared/ofk-schema';

/**
 * 今日页只读投影类型与工作区着色工具(合并解读层):
 * 聚合实现(P1 起)在 src/main/ofk/day-aggregate.ts 的 summarizeOfkDay ——
 * 本文件只保留类型 + 常量,不承载聚合逻辑。
 */

export interface TodayPeriodStats {
  morning: number;
  afternoon: number;
  evening: number;
}

export interface TodayWorkspaceStat {
  name: string;
  color: string;
  totalActiveMs: number;
}

/** 标签统计(2026-08-14 标签分类改造):category = tag 字符串;label 恒等于 category。 */
export interface TodayCategoryStat {
  category: string;
  label: string;
  count: number;
  totalActiveMs: number;
}

export interface TodayDayData {
  facts: SessionFact[];
  stats: {
    totalActiveMs: number;
    sessionCount: number;
    tokens: number;
    byPeriod: TodayPeriodStats;
  };
  workspaces: TodayWorkspaceStat[];
  categories: TodayCategoryStat[];
  /** 渲染段列表(plan D4/D6):LLM 段 > breaks 切段 > 单段,按 start 升序。 */
  segments: TimelineSegment[];
}

/**
 * 工作区 6 色板 token 名(design token,非 hex;样式层经 CSS 变量解析):
 * ws-1..ws-6,按工作区名稳定分配。
 */
export const WORKSPACE_COLORS = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6'] as const;

/** 工作区名 → 色板稳定映射(同名恒同色,顺序无关)。 */
export function workspaceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length];
}

/** 本地日键 YYYY-MM-DD(queryDay 的日期键按本地日对齐)。 */
export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
