import type { SessionCategory, SessionConceptDoc } from '../../shared/ofk-schema';
import {
  isSessionCategory,
  parseConceptFrontmatter,
  parseDigestSegments,
  parseSessionConcept,
  yamlQuote,
} from '../../shared/ofk-schema';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import type { ModelInvoke } from '../memory/review-generator';
import { createCompileModelInvoke } from '../memory/review-model';
import { OFK_DIGEST_SEED } from './digest-seed';
import {
  dayConceptPath,
  listDayConceptFiles,
  listDayDigestFiles,
  readConcept,
  writeConcept,
} from './ofk-bundle';

/**
 * OFK 每日摘要编译(step 4):按工作区把当日会话概念编译成
 * ① 每会话 category 写回(frontmatter 原样正则替换,其余字节不动)
 * ② days/<ws-slug>/<dateISO>.md 日摘要。
 *
 * 判定需生成:日摘要缺失 或 任一会话概念 generated.at > 日摘要 generated.at。
 * 编译经 createCompileModelInvoke(可注入 fake);模型调用 Err → 整体 Err
 * 且该工作区不写任何文件;调用方 fail-open。
 */

/** prompt 正文总量上限(超 32KB 截断)。 */
export const DIGEST_PROMPT_MAX_CHARS = 32 * 1024;

export interface DayConcept {
  rel: string;
  doc: SessionConceptDoc;
  /** frontmatter generated.at(fact.end 口径)解析值;缺失 = 0。 */
  generatedAt: number;
  /** 概念正文(不含 frontmatter)。 */
  body: string;
}

/** LLM 语义分段规格(plan D3):category 六值枚举,start/end ISO 串,summary 可选。 */
export interface SegmentSpec {
  category: SessionCategory;
  start: string;
  end: string;
  summary?: string;
}

interface DayDigestDoc {
  categoryBySession: Record<string, SessionCategory>;
  segmentsBySession: Record<string, SegmentSpec[]>;
  digest: string;
}

/** 读当日全部会话概念(解析失败跳过,与 today-ipc 同纪律)。 */
export async function readDayConcepts(dateISO: string): Promise<Result<DayConcept[]>> {
  const listed = await listDayConceptFiles(dateISO);
  if (listed.isErr()) return listed;
  const out: DayConcept[] = [];
  for (const rel of listed.value) {
    const content = await readConcept(rel);
    if (content.isErr()) {
      console.error('[day-digest] concept read failed:', content.error);
      continue;
    }
    if (content.value === null) continue;
    const parsed = parseConceptFrontmatter(content.value);
    if (!parsed) continue;
    const doc = parseSessionConcept(content.value);
    if (!doc) continue;
    const generated =
      parsed.frontmatter.generated !== null && typeof parsed.frontmatter.generated === 'object'
        ? (parsed.frontmatter.generated as Record<string, unknown>).at
        : undefined;
    const generatedAt = typeof generated === 'string' ? Date.parse(generated) : Number.NaN;
    out.push({
      rel,
      doc,
      generatedAt: Number.isFinite(generatedAt) ? generatedAt : 0,
      body: parsed.body,
    });
  }
  return ok(out);
}

/** 读某工作区现有日摘要的 generated.at 与「是否含 segments 块」;无文件/解析失败 → 两者取空。 */
async function readDigestMeta(rel: string): Promise<{
  generatedAt: number | null;
  hasSegments: boolean;
}> {
  const read = await readConcept(rel);
  if (read.isErr() || read.value === null) return { generatedAt: null, hasSegments: false };
  const parsed = parseConceptFrontmatter(read.value);
  if (!parsed) return { generatedAt: null, hasSegments: false };
  const generated = parsed.frontmatter.generated;
  let generatedAt: number | null = null;
  if (generated !== null && typeof generated === 'object') {
    const at = (generated as Record<string, unknown>).at;
    if (typeof at === 'string') {
      const ms = Date.parse(at);
      if (Number.isFinite(ms)) generatedAt = ms;
    }
  }
  const hasSegments =
    Array.isArray(parsed.frontmatter.segments) && parsed.frontmatter.segments.length > 0;
  return { generatedAt, hasSegments };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

/** 拼装编译 prompt:种子方法论 + 当日概念清单(正文按总量预算截断)。 */
export function composeDigestPrompt(
  dateISO: string,
  workspaceSlug: string,
  concepts: DayConcept[],
): string {
  const budget = DIGEST_PROMPT_MAX_CHARS - OFK_DIGEST_SEED.length - 1024;
  const sessions: Array<Record<string, unknown>> = [];
  let used = 0;
  for (const c of concepts) {
    const body = c.body.length > 0 ? truncate(c.body, 8_000) : '';
    const entry: Record<string, unknown> = {
      sessionRef: c.doc.sessionRef,
      title: c.doc.title,
      description: c.doc.description,
      start: c.doc.start,
      end: c.doc.end,
      active_ms: c.doc.activeMs,
      tokens: c.doc.tokens,
      model: c.doc.model,
      tools: c.doc.tools,
      unfinished: c.doc.unfinished,
      contains_todo: c.doc.containsTodo,
      ...(body ? { body } : {}),
    };
    // 正文预算:超过预算的会话只留 frontmatter 摘要字段
    if (body) {
      const est = body.length;
      if (used + est > budget) {
        delete entry.body;
      } else {
        used += est;
      }
    }
    sessions.push(entry);
  }
  const payload = JSON.stringify({ date: dateISO, workspace: workspaceSlug, sessions }, null, 2);
  return `${OFK_DIGEST_SEED}\n\n以下为当日会话数据(JSON):\n${payload}`;
}

/** fence-tolerant JSON 解析(照 session-memory-extractor parseExtractionJson 模式)。 */
function parseDigestJson(text: string): Result<DayDigestDoc> {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(text);
  if (parsed === undefined) {
    const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenced) parsed = tryParse(fenced[1]);
  }
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return err({ code: 'ofk-digest-parse-failed', message: 'digest output is not JSON' });
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.digest !== 'string') {
    return err({ code: 'ofk-digest-parse-failed', message: 'digest output missing digest' });
  }
  const categoryBySession: Record<string, SessionCategory> = {};
  if (record.categoryBySession !== null && typeof record.categoryBySession === 'object') {
    for (const [sessionRef, value] of Object.entries(record.categoryBySession)) {
      // 类别值不在枚举 → 'uncategorized'
      categoryBySession[sessionRef] = isSessionCategory(value) ? value : 'uncategorized';
    }
  }
  // segmentsBySession:逐 sessionRef 取数组,逐项校验(category 六值、start/end
  // 可解析、summary 可选字符串);非法项丢弃;key 仅在数组非空时保留。
  const segmentsBySession: Record<string, SegmentSpec[]> = {};
  if (record.segmentsBySession !== null && typeof record.segmentsBySession === 'object') {
    for (const [sessionRef, rawSpecs] of Object.entries(record.segmentsBySession)) {
      if (!Array.isArray(rawSpecs)) continue;
      const specs: SegmentSpec[] = [];
      for (const raw of rawSpecs) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const r = raw as Record<string, unknown>;
        if (!isSessionCategory(r.category)) continue;
        const start = typeof r.start === 'string' ? r.start : '';
        const end = typeof r.end === 'string' ? r.end : '';
        if (
          !start ||
          !end ||
          !Number.isFinite(Date.parse(start)) ||
          !Number.isFinite(Date.parse(end))
        ) {
          continue;
        }
        const spec: SegmentSpec = { category: r.category, start, end };
        if (typeof r.summary === 'string') spec.summary = r.summary;
        specs.push(spec);
      }
      if (specs.length > 0) segmentsBySession[sessionRef] = specs;
    }
  }
  return ok({ categoryBySession, segmentsBySession, digest: record.digest });
}

/** 只动 frontmatter 的 category 行,其余字节不动。 */
function replaceCategoryInConcept(content: string, category: SessionCategory): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, (block) =>
    block.replace(/^category:.*$/m, `category: ${category}`),
  );
}

/** 日摘要文档(D3 形态):frontmatter(workspace 行后按 sessionRef 序写 segments 块)+ digest 正文。 */
function buildDigestDoc(
  workspaceSlug: string,
  dateISO: string,
  digest: string,
  segmentsBySession: Record<string, SegmentSpec[]>,
): string {
  const now = new Date().toISOString();
  const lines = [
    '---',
    'type: Daily Digest',
    `title: ${dateISO} 摘要`,
    `date: ${dateISO}`,
    `workspace: ${workspaceSlug}`,
  ];
  const segLines: string[] = [];
  for (const sessionRef of Object.keys(segmentsBySession).sort()) {
    for (const spec of segmentsBySession[sessionRef]) {
      segLines.push(`  - ref: ${yamlQuote(sessionRef)}`);
      segLines.push(`    category: ${spec.category}`);
      segLines.push(`    start: ${yamlQuote(spec.start)}`);
      segLines.push(`    end: ${yamlQuote(spec.end)}`);
      if (spec.summary !== undefined) segLines.push(`    summary: ${yamlQuote(spec.summary)}`);
    }
  }
  if (segLines.length > 0) lines.push('segments:', ...segLines);
  lines.push(`generated: { by: process:lorra-digest/1, at: ${now} }`, '---', '', digest);
  return lines.join('\n');
}

/** 编译某工作区:概念 → 模型一次调用 → 写回 category + 日摘要。 */
async function compileWorkspace(
  dateISO: string,
  workspaceSlug: string,
  concepts: DayConcept[],
  invoke: ModelInvoke,
): Promise<Result<void>> {
  const prompt = composeDigestPrompt(dateISO, workspaceSlug, concepts);
  const invoked = await invoke(prompt);
  if (invoked.isErr()) return invoked; // 模型失败原样透传,不写任何文件
  const parsed = parseDigestJson(invoked.value);
  if (parsed.isErr()) return parsed;

  // category 写回:逐概念读文件 → frontmatter category 替换 → 原子写
  for (const c of concepts) {
    const target = c.doc.sessionRef;
    const category =
      c.doc.sessionRef in parsed.value.categoryBySession
        ? parsed.value.categoryBySession[target]
        : undefined;
    if (category === undefined) continue; // 模型未给出 → 保持现状
    const content = await readConcept(c.rel);
    if (content.isErr()) return content;
    if (content.value === null) continue;
    const next = replaceCategoryInConcept(content.value, category);
    if (next === content.value) continue; // 已是该类别 → 跳过
    const written = await writeConcept(c.rel, next);
    if (written.isErr()) return written;
  }

  const digestRel = dayConceptPath(workspaceSlug, dateISO);
  return writeConcept(
    digestRel,
    buildDigestDoc(workspaceSlug, dateISO, parsed.value.digest, parsed.value.segmentsBySession),
  );
}

/** 读当日全部日摘要正文(按 slug 关联):days/<ws-slug>/<dateISO>.md → body。 */
export async function readDayDigestBodies(dateISO: string): Promise<Result<Map<string, string>>> {
  const listed = await listDayDigestFiles(dateISO);
  if (listed.isErr()) return listed;
  const out = new Map<string, string>();
  for (const rel of listed.value) {
    const content = await readConcept(rel);
    if (content.isErr()) {
      console.error('[day-digest] digest read failed:', content.error);
      continue;
    }
    if (content.value === null) continue;
    const parsed = parseConceptFrontmatter(content.value);
    if (!parsed) continue;
    // rel 形态 days/<ws-slug>/<dateISO>.md → slug 在第二段(与概念 rel 同位置)
    const slug = rel.split('/')[1] ?? 'unknown';
    out.set(slug, parsed.body.trim());
  }
  return ok(out);
}

/** 读当日全部日摘要的语义分段(按 sessionRef 聚合):days/<slug>/<dateISO>.md frontmatter。 */
export async function readDayDigestSegments(
  dateISO: string,
): Promise<Result<Map<string, SegmentSpec[]>>> {
  const listed = await listDayDigestFiles(dateISO);
  if (listed.isErr()) return listed;
  const out = new Map<string, SegmentSpec[]>();
  for (const rel of listed.value) {
    const content = await readConcept(rel);
    if (content.isErr()) {
      console.error('[day-digest] digest read failed:', content.error);
      continue;
    }
    if (content.value === null) continue;
    const parsed = parseConceptFrontmatter(content.value);
    if (!parsed) continue;
    for (const seg of parseDigestSegments(parsed.frontmatter)) {
      const list = out.get(seg.ref) ?? [];
      list.push({
        category: seg.category,
        start: seg.start,
        end: seg.end,
        ...(seg.summary !== undefined ? { summary: seg.summary } : {}),
      });
      out.set(seg.ref, list);
    }
  }
  return ok(out);
}

/**
 * 编译当日全部工作区的日摘要(入口):按概念目录 slug 分组,
/** stale 工作区组:缺摘要或有过期概念(plan S5/D4)。 */
export interface StaleDayGroup {
  slug: string;
  concepts: DayConcept[];
}

/**
 * 判定当日 stale 工作区组(plan S5/D4 拆分):readDayConcepts + 按目录 slug
 * 分组 + 逐 slug readDigestMeta 过期判定;不含任何 invoke。
 * 判定规则不变:digest 缺 generatedAt → stale;概念 generatedAt > digest
 * generatedAt 或 hasSegments=false → stale。
 */
export async function dayDigestStaleGroups(dateISO: string): Promise<Result<StaleDayGroup[]>> {
  const conceptsResult = await readDayConcepts(dateISO);
  if (conceptsResult.isErr()) return conceptsResult;
  const concepts = conceptsResult.value;

  // 按目录 slug 分组(sessions/<ws-slug>/<YYYY>/<dateISO>/<ref>.md)
  const bySlug = new Map<string, DayConcept[]>();
  for (const c of concepts) {
    const slug = c.rel.split('/')[1] ?? 'unknown';
    const list = bySlug.get(slug) ?? [];
    list.push(c);
    bySlug.set(slug, list);
  }

  const stale: StaleDayGroup[] = [];
  for (const [slug, group] of bySlug) {
    const digestRel = dayConceptPath(slug, dateISO);
    const meta = await readDigestMeta(digestRel);
    if (meta.generatedAt === null) {
      stale.push({ slug, concepts: group });
      continue;
    }
    const generatedAt = meta.generatedAt; // 收窄为 number(闭包内属性收窄不传播)
    const isStale = group.some((c) => c.generatedAt > generatedAt) || !meta.hasSegments;
    if (isStale) stale.push({ slug, concepts: group });
  }
  return ok(stale);
}

/**
 * 编译当日 stale 工作区(plan S5/D4 拆分):对 dayDigestStaleGroups 每组调
 * compileWorkspace;空组 → ok;首个 Err 返回(调用方 fail-open)。
 */
export async function compileDay(
  dateISO: string,
  deps: { invoke?: ModelInvoke } = {},
): Promise<Result<void>> {
  const groupsResult = await dayDigestStaleGroups(dateISO);
  if (groupsResult.isErr()) return groupsResult;
  const groups = groupsResult.value;
  if (groups.length === 0) return ok(); // 当日无 stale 工作区 → 无需编译

  const invoke = deps.invoke ?? createCompileModelInvoke();
  for (const group of groups) {
    const compiled = await compileWorkspace(dateISO, group.slug, group.concepts, invoke);
    if (compiled.isErr()) return compiled;
  }
  return ok();
}

/**
 * 编译当日全部工作区的日摘要(入口,语义与拆分前一致):概念按
 * 目录 slug 分组,每组缺摘要或有过期概念 → invoke 一次编译。模型 Err →
 * 整体 Err(调用方 fail-open);解析/写失败同 Err。S5 起为 compileDay 薄封装。
 */
export async function ensureDayCompiled(
  dateISO: string,
  deps: { invoke?: ModelInvoke } = {},
): Promise<Result<void>> {
  return compileDay(dateISO, deps);
}
