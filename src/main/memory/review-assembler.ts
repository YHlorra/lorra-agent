import { DEFAULT_TAGS } from '../../shared/ofk-schema';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import {
  type DayConcept,
  ensureDayCompiled,
  readDayConcepts,
  readDayDigestBodies,
} from '../ofk/day-digest';
import { readSettings } from '../workspace/settings';
import { localDateString } from './day-summary';

/**
 * 复盘数据组装契约(spec review-engine「复盘数据组装契约」,design D8):
 * 在注入 LLM 前完成对话压缩,输出 JSON 可被固化的复盘提示模板直接消费。
 * 起组装端直读 OFK bundle:对窗口内每天 ensureDayCompiled(日摘要
 * 编译,Err 记 console.error 继续)→ 读 sessions 概念 + days 摘要 → 组装。
 * 不再经 facts.db(该层已删)。
 */

export interface ReviewRequest {
  kind: 'daily' | 'weekly';
  dateISO?: string;
}

/** 压缩后的单条对话(控制注入 LLM 的 token 量)。 */
export interface ConversationDigest {
  title: string;
  question: string;
  /** 当日 OFK 日摘要正文(同工作区同日多会话共享同一摘要字符串)。 */
  summary: string;
  tools: string[];
  lastMessageRole: 'user' | 'assistant';
  containsTodo: boolean;
}

export interface ReviewWorkspace {
  workspaceName: string;
  conversations: ConversationDigest[];
  usage: { tokens: number; models: string[] };
  /** 该工作区窗口内各日日摘要正文(种子优先引用做当日概览)。 */
  dailyDigest?: string;
}

export interface ReviewPayload {
  date: string;
  workspaces: ReviewWorkspace[];
  globalStats: {
    totalConversations: number;
    totalActiveMs: number;
    timeAllocation: Record<string, number>;
  };
}

/**
 * 周窗:dateISO 为末日的 7 天本地日窗(本地构造,非 UTC)。
 * days 恰 7 个本地日键、末位=dateISO;跨月/跨年由 new Date(y, m-1, d-6)
 * 本地构造正确处理。根因:new Date(ISO 字符串) 是 UTC 零点语义,与本地日
 * 构造错位,负偏移时区会丢当天 —— 一律用本地日期组件构造。
 */
export function weeklyWindow(dateISO: string): { startISO: string; days: string[] } {
  const [y, m, d] = dateISO.split('-').map(Number);
  const start = new Date(y, m - 1, d - 6);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(
      localDateString(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)),
    );
  }
  return { startISO: localDateString(start), days };
}

/** 概念正文「用户要求」首条 bullet 文本(剥 - [HH:MM] 前缀)。 */
function extractFirstUserRequest(body: string): string {
  const section = body.split('## 用户要求')[1];
  if (!section) return '';
  const bullet = section.split('\n').find((line) => line.trimStart().startsWith('- '));
  if (!bullet) return '';
  const text = bullet
    .trim()
    .replace(/^-\s*/, '')
    .replace(/^\[\d{1,2}:\d{2}\]\s*/, '');
  return text.slice(0, 500);
}

function toDigest(concept: DayConcept, digest: string | null): ConversationDigest {
  return {
    title: concept.doc.title,
    question: extractFirstUserRequest(concept.body) || concept.doc.title,
    summary: digest ?? '',
    tools: [...concept.doc.tools],
    lastMessageRole: concept.doc.unfinished ? 'user' : 'assistant',
    containsTodo: concept.doc.containsTodo,
  };
}

/** 去重且保持首次出现顺序。 */
function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * 组装复盘载荷(OFK 直读):
 * - daily:仅 dateISO 当天;weekly:weeklyWindow(dateISO) 七天窗
 * - 每天先 ensureDayCompiled(日摘要编译;Err 记 console.error 继续,不中断)
 * - payload.date:weekly 为 '<start>..<end>'
 * - timeAllocation 原始毫秒:daily 键=工作区名,weekly 键=本地日
 * - workspaces 按 activeMs 降序,conversations 按 start 升序
 * - usage.models 去重保序、排除空串
 */
export async function assembleReviewPayload(
  kind: ReviewRequest['kind'],
  dateISO: string,
): Promise<Result<ReviewPayload>> {
  if (kind !== 'daily' && kind !== 'weekly') {
    return err({ code: 'invalid-review-kind', message: `unsupported review kind: ${kind}` });
  }
  const days = kind === 'daily' ? [dateISO] : weeklyWindow(dateISO).days;

  // 标签列表入口读一次(settings.tags ?? 内置默认;fail-open 缺省)。
  let tags: string[] = [...DEFAULT_TAGS];
  try {
    const settings = await readSettings();
    tags = settings.tags ?? [...DEFAULT_TAGS];
  } catch {
    // fail-open:读设置失败用内置默认标签
  }

  interface WorkspaceBucket {
    conversations: Array<{ digest: ConversationDigest; start: number }>;
    tokens: number;
    models: string[];
    totalActiveMs: number;
    dayDigests: string[];
  }
  const byWorkspace = new Map<string, WorkspaceBucket>();

  for (const day of days) {
    const compiled = await ensureDayCompiled(day, { tags });
    if (compiled.isErr()) {
      console.error('[review-assembler] day digest compile failed:', compiled.error);
    }
    const conceptsRes = await readDayConcepts(day);
    if (conceptsRes.isErr()) return conceptsRes;
    const digestsRes = await readDayDigestBodies(day);
    if (digestsRes.isErr()) return digestsRes;
    const digests = digestsRes.value;

    for (const concept of conceptsRes.value) {
      const workspaceName = concept.doc.workspace;
      // 摘要按概念目录 slug 关联(days/<slug>/<day>.md)
      const slug = concept.rel.split('/')[1] ?? 'unknown';
      const digest = digests.get(slug) ?? null;
      const bucket = byWorkspace.get(workspaceName) ?? {
        conversations: [],
        tokens: 0,
        models: [],
        totalActiveMs: 0,
        dayDigests: [],
      };
      bucket.conversations.push({
        digest: toDigest(concept, digest),
        start: Date.parse(concept.doc.start),
      });
      bucket.tokens += concept.doc.tokens;
      bucket.totalActiveMs += concept.doc.activeMs;
      if (concept.doc.model.length > 0) bucket.models.push(concept.doc.model);
      if (digest !== null && !bucket.dayDigests.includes(digest)) {
        bucket.dayDigests.push(digest);
      }
      byWorkspace.set(workspaceName, bucket);
    }
  }

  const workspaces = [...byWorkspace.entries()]
    .map(([workspaceName, bucket]) => ({
      workspaceName,
      conversations: bucket.conversations.sort((a, b) => a.start - b.start).map((c) => c.digest),
      usage: {
        tokens: bucket.tokens,
        models: dedupePreserveOrder(bucket.models),
      },
      totalActiveMs: bucket.totalActiveMs,
      ...(bucket.dayDigests.length > 0
        ? { dailyDigest: bucket.dayDigests.join('\n\n---\n\n') }
        : {}),
    }))
    .sort((a, b) => b.totalActiveMs - a.totalActiveMs)
    .map(({ totalActiveMs: _total, ...workspace }) => workspace);

  const timeAllocation: Record<string, number> = {};
  for (const day of days) {
    const conceptsRes = await readDayConcepts(day);
    if (conceptsRes.isErr()) return conceptsRes;
    for (const concept of conceptsRes.value) {
      const key = kind === 'weekly' ? day : concept.doc.workspace;
      timeAllocation[key] = (timeAllocation[key] ?? 0) + concept.doc.activeMs;
    }
  }

  const totalConversations = workspaces.reduce((sum, w) => sum + w.conversations.length, 0);
  const totalActiveMs = [...byWorkspace.values()].reduce((sum, b) => sum + b.totalActiveMs, 0);

  return ok({
    date: kind === 'weekly' ? `${weeklyWindow(dateISO).startISO}..${dateISO}` : dateISO,
    workspaces,
    globalStats: {
      totalConversations,
      totalActiveMs,
      timeAllocation,
    },
  });
}
