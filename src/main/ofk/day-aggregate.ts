import {
  FACTS_SCHEMA_VERSION,
  type FactPrivacy,
  factIdOf,
  type SessionFact,
} from '../../shared/facts-schema';
import {
  isSessionCategory,
  type SessionConceptDoc,
  type TimelineSegment,
} from '../../shared/ofk-schema';
import { type TodayDayData, workspaceColor } from '../memory/day-summary';
import type { SegmentSpec } from './day-digest';

/**
 * OFK 日聚合(step 5):当日会话概念 → 今日页只读投影。
 * 口径与旧 summarizeDay 完全一致(stats/workspaces/byPeriod 同源),
 * 新增 categories 大类分区统计。概念解析失败由调用方跳过(本函数
 * 只收合法 SessionConceptDoc[])。
 */

function isFactPrivacy(value: string): value is FactPrivacy {
  return value === 'public_safe' || value === 'local_private' || value === 'private_pointer';
}

/** 概念 → 事实:日期不可解析 → null(调用方已过滤,此处防御)。 */
function conceptToFact(doc: SessionConceptDoc): SessionFact | null {
  const start = Date.parse(doc.start);
  const end = Date.parse(doc.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const base: Omit<SessionFact, 'factId'> = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: 'ofk',
    runtime: 'ofk',
    agentId: 'ofk',
    sessionRef: doc.sessionRef,
    workspace: doc.workspace,
    scope: 'workspace',
    start,
    end,
    activeMs: doc.activeMs,
    title: doc.title,
    summaryRef: null,
    tokens: doc.tokens,
    model: doc.model,
    tools: doc.tools,
    unfinished: doc.unfinished,
    containsTodo: doc.containsTodo,
    // 空串/非法值落 '未分类'(与 stats 分区同口径)
    category: isSessionCategory(doc.category) ? doc.category : '未分类',
    privacy: isFactPrivacy(doc.privacy) ? doc.privacy : 'public_safe',
  };
  return { factId: factIdOf(base), ...base };
}

/**
 * 概念 + LLM 段 + breaks → 渲染段列表(D6)。LLM 段优先;无则 breaks 切;再无则单段。
 * 段 activeMs 按时间占比从概念 activeMs 分配(D5,概念跨度为 0 时 = 概念 activeMs);
 * 同一概念的段合计 ≈ 概念 activeMs(四舍五入误差可接受,KPI 统计仍以概念 facts 为准)。
 */
export function segmentsOfConcept(
  concept: SessionConceptDoc,
  llmSegments: SegmentSpec[] | undefined,
): TimelineSegment[] {
  const conceptStart = Date.parse(concept.start);
  const conceptEnd = Date.parse(concept.end);
  if (!Number.isFinite(conceptStart) || !Number.isFinite(conceptEnd)) return [];
  const span = conceptEnd > conceptStart ? conceptEnd - conceptStart : 0;
  const alloc = (segStart: number, segEnd: number): number =>
    span > 0 ? Math.round((concept.activeMs * (segEnd - segStart)) / span) : concept.activeMs;
  // 块标题来源:LLM 段 summary > 概念 description(模型整会话归纳,编译写回)> 概念 title。
  // description 与 title 相同(清洗播种初值,未编译过)时不视作归纳。
  const conceptSummary =
    concept.description.trim().length > 0 && concept.description !== concept.title
      ? concept.description
      : undefined;
  const mk = (category: string, start: number, end: number, summary?: string): TimelineSegment => ({
    sessionRef: concept.sessionRef,
    workspace: concept.workspace,
    category,
    collector: concept.collector,
    start,
    end,
    activeMs: alloc(start, end),
    title: concept.title,
    ...(summary !== undefined
      ? { summary }
      : conceptSummary !== undefined
        ? { summary: conceptSummary }
        : {}),
    unfinished: concept.unfinished,
    containsTodo: concept.containsTodo,
    model: concept.model,
    tools: concept.tools,
  });

  // ① LLM 语义段:逐段映射(start/end Date.parse 失败丢弃);不要求覆盖概念全区间
  if (llmSegments && llmSegments.length > 0) {
    const out: TimelineSegment[] = [];
    for (const spec of llmSegments) {
      const s = Date.parse(spec.start);
      const e = Date.parse(spec.end);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      out.push(mk(spec.category, s, e, spec.summary));
    }
    return out;
  }
  // ② 确定性断口:按 breaks 切成 n+1 段,段 category 继承概念;越界断口丢弃
  if (concept.breaks.length > 0) {
    const out: TimelineSegment[] = [];
    let prev = conceptStart;
    for (const brk of [...concept.breaks]
      .sort((a, b) => a - b)
      .filter((b) => b > conceptStart && b < conceptEnd)) {
      out.push(mk(concept.category, prev, brk));
      prev = brk;
    }
    out.push(mk(concept.category, prev, conceptEnd));
    return out;
  }
  // ③ 单段(整概念)
  return [mk(concept.category, conceptStart, conceptEnd)];
}

/**
 * 聚合一日概念:
 * - facts 按 start 升序(概念→事实,含 category)
 * - stats:totalActiveMs/tokens 求和、byPeriod 原始活跃毫秒按本地小时分桶
 * (上午 <12 / 下午 12-18 / 晚上 ≥18)、sessionCount = 概念数
 * - workspaces 按工作区聚合 activeMs,着色稳定(token 名),按活跃时长降序
 * - segments 渲染段(LLM 段 > breaks 切段 > 单段),按 start 升序
 * - categories 按段统计(与渲染同源;count = 段数,totalActiveMs = 段 activeMs
 * 合计),按段 start 升序的首现顺序,label = tag 本身(空串/非法值落 '未分类')
 */
export function summarizeOfkDay(
  concepts: SessionConceptDoc[],
  _dateISO: string,
  digestSegments: Map<string, SegmentSpec[]>,
): TodayDayData {
  const facts = concepts
    .map(conceptToFact)
    .filter((f): f is SessionFact => f !== null)
    .sort((a, b) => a.start - b.start);

  const segments = concepts
    .flatMap((c) => segmentsOfConcept(c, digestSegments.get(c.sessionRef)))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const totalActiveMs = facts.reduce((sum, f) => sum + f.activeMs, 0);
  const tokens = facts.reduce((sum, f) => sum + f.tokens, 0);

  const byPeriod = { morning: 0, afternoon: 0, evening: 0 };
  for (const fact of facts) {
    const hour = new Date(fact.start).getHours();
    const bucket = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    byPeriod[bucket] += fact.activeMs;
  }

  const byWorkspace = new Map<string, number>();
  for (const fact of facts) {
    byWorkspace.set(fact.workspace, (byWorkspace.get(fact.workspace) ?? 0) + fact.activeMs);
  }
  const workspaces = [...byWorkspace.entries()]
    .map(([name, total]) => ({ name, color: workspaceColor(name), totalActiveMs: total }))
    .sort((a, b) => b.totalActiveMs - a.totalActiveMs);

  // categories 按渲染段统计(与今日页分区同源):count = 段数,totalActiveMs = 段合计;
  // 顺序 = 段按 start 升序的首现顺序;label = tag 本身(不再有六值枚举映射)。
  const byCategory = new Map<string, { count: number; totalActiveMs: number }>();
  const order: string[] = [];
  for (const seg of segments) {
    const cat = isSessionCategory(seg.category) ? seg.category : '未分类';
    if (!byCategory.has(cat)) order.push(cat);
    const stat = byCategory.get(cat) ?? { count: 0, totalActiveMs: 0 };
    stat.count += 1;
    stat.totalActiveMs += seg.activeMs;
    byCategory.set(cat, stat);
  }
  const categories: Array<{
    category: string;
    label: string;
    count: number;
    totalActiveMs: number;
  }> = [];
  for (const cat of order) {
    const stat = byCategory.get(cat);
    if (!stat) continue;
    categories.push({
      category: cat,
      label: cat,
      count: stat.count,
      totalActiveMs: stat.totalActiveMs,
    });
  }

  return {
    facts,
    stats: { totalActiveMs, sessionCount: facts.length, tokens, byPeriod },
    workspaces,
    categories,
    segments,
  };
}
