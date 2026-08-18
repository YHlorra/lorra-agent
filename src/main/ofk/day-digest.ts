import type { SessionCategory, SessionConceptDoc } from '../../shared/ofk-schema';
import {
  DEFAULT_TAGS,
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

/** LLM 语义分段规格(plan D3):category 自由标签,start/end ISO 串,summary 可选。 */
export interface SegmentSpec {
  category: SessionCategory;
  start: string;
  end: string;
  summary?: string;
}

interface DayDigestDoc {
  categoryBySession: Record<string, SessionCategory>;
  segmentsBySession: Record<string, SegmentSpec[]>;
  /** 整会话一句话归纳(模型产出,写回概念 description,作时间线块标题)。 */
  summaryBySession: Record<string, string>;
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

/** 读某工作区现有日摘要的 generated.at 与 tags 指纹;无文件/解析失败 → 空。 */
async function readDigestMeta(rel: string): Promise<{
  generatedAt: number | null;
  tagsSig: string;
}> {
  const read = await readConcept(rel);
  if (read.isErr() || read.value === null) return { generatedAt: null, tagsSig: '' };
  const parsed = parseConceptFrontmatter(read.value);
  if (!parsed) return { generatedAt: null, tagsSig: '' };
  const generated = parsed.frontmatter.generated;
  let generatedAt: number | null = null;
  if (generated !== null && typeof generated === 'object') {
    const at = (generated as Record<string, unknown>).at;
    if (typeof at === 'string') {
      const ms = Date.parse(at);
      if (Number.isFinite(ms)) generatedAt = ms;
    }
  }
  // tags 指纹:frontmatter.tags 数组 join('\u0000');缺省 ''(存量摘要无 tags → 必 stale)
  const rawTags = parsed.frontmatter.tags;
  const tagsSig = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === 'string').join('\u0000')
    : '';
  return { generatedAt, tagsSig };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

/** 拼装编译 prompt:种子方法论 + 当日概念清单 + 可用标签列表(正文按总量预算截断)。 */
export function composeDigestPrompt(
  dateISO: string,
  workspaceSlug: string,
  concepts: DayConcept[],
  tags: string[],
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
  const payload = JSON.stringify(
    { date: dateISO, workspace: workspaceSlug, tags, sessions },
    null,
    2,
  );
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
      // 空串/非字符串 → '未分类'(自由 tag,非空串即合法)
      categoryBySession[sessionRef] = isSessionCategory(value) ? value : '未分类';
    }
  }
  // segmentsBySession:逐 sessionRef 取数组,逐项校验(category 非空串、start/end
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
  const summaryBySession: Record<string, string> = {};
  if (record.summaryBySession !== null && typeof record.summaryBySession === 'object') {
    for (const [sessionRef, value] of Object.entries(record.summaryBySession)) {
      // 空串/非字符串丢弃;trim 后保留(块标题展示)
      if (typeof value === 'string' && value.trim().length > 0) {
        summaryBySession[sessionRef] = value.trim();
      }
    }
  }
  return ok({ categoryBySession, segmentsBySession, summaryBySession, digest: record.digest });
}

/** 只动 frontmatter 的 category 行,其余字节不动。 */
function replaceCategoryInConcept(content: string, category: SessionCategory): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, (block) =>
    block.replace(/^category:.*$/m, `category: ${category}`),
  );
}

/** 只动 frontmatter 的 description 行,其余字节不动。 */
function replaceDescriptionInConcept(content: string, description: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, (block) =>
    block.replace(/^description:.*$/m, `description: ${yamlQuote(description)}`),
  );
}

/** 日摘要文档(D3 形态):frontmatter(workspace 行后按 sessionRef 序写 segments 块,
 * tags 行写本次编译用的标签列表)+ digest 正文。 */
function buildDigestDoc(
  workspaceSlug: string,
  dateISO: string,
  digest: string,
  segmentsBySession: Record<string, SegmentSpec[]>,
  tags: string[],
): string {
  const now = new Date().toISOString();
  const lines = [
    '---',
    'type: Daily Digest',
    `title: ${dateISO} 摘要`,
    `date: ${dateISO}`,
    `workspace: ${workspaceSlug}`,
    `tags: [${tags.map(yamlQuote).join(', ')}]`,
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

/** 读某工作区日摘要的 generatedAt + tags 指纹 + 按 sessionRef 分组的冻结段;无文件 → 空。 */
async function readFrozenDigest(
  dateISO: string,
  workspaceSlug: string,
): Promise<{ generatedAt: number | null; tagsSig: string; byRef: Map<string, SegmentSpec[]> }> {
  const rel = dayConceptPath(workspaceSlug, dateISO);
  const meta = await readDigestMeta(rel);
  const byRef = new Map<string, SegmentSpec[]>();
  if (meta.generatedAt !== null) {
    const read = await readConcept(rel);
    if (read.isOk() && read.value !== null) {
      const parsed = parseConceptFrontmatter(read.value);
      if (parsed) {
        for (const seg of parseDigestSegments(parsed.frontmatter)) {
          const list = byRef.get(seg.ref) ?? [];
          list.push({
            category: seg.category,
            start: seg.start,
            end: seg.end,
            ...(seg.summary !== undefined ? { summary: seg.summary } : {}),
          });
          byRef.set(seg.ref, list);
        }
      }
    }
  }
  return { generatedAt: meta.generatedAt, tagsSig: meta.tagsSig, byRef };
}

/** 编译某工作区:概念 → 模型一次调用 → 写回 category + 日摘要。
 * 冻结(2026-08-14 增量编译):编译前读现有摘要;对「tags 指纹一致且概念未增长
 * (概念 generatedAt ≤ 摘要 generatedAt)且有旧段」的会话,用旧段覆盖模型输出
 * (逐字节不变),category 写回同样跳过该会话——只编译新增/变化会话。
 * tags 列表变化 → 冻结关闭 → 模型输出整体替换(已固定数据仍可删减)。 */
async function compileWorkspace(
  dateISO: string,
  workspaceSlug: string,
  concepts: DayConcept[],
  invoke: ModelInvoke,
  tags: string[],
): Promise<Result<void>> {
  const prompt = composeDigestPrompt(dateISO, workspaceSlug, concepts, tags);
  const invoked = await invoke(prompt);
  if (invoked.isErr()) return invoked; // 模型失败原样透传,不写任何文件
  const parsed = parseDigestJson(invoked.value);
  if (parsed.isErr()) return parsed;

  // 冻结段:摘要存在、tags 指纹一致(非全量重编译)且概念未增长 → 旧段覆盖模型
  // 输出(其余用模型输出)。tags 变化 → 冻结关闭 → 模型输出整体替换(可删减)。
  const frozen = await readFrozenDigest(dateISO, workspaceSlug);
  const digestGeneratedAt = frozen.generatedAt;
  const freezeEnabled = frozen.tagsSig === tags.join('\u0000');
  const finalSegmentsBySession: Record<string, SegmentSpec[]> = {};
  const finalCategoryBySession: Record<string, SessionCategory> = {};
  for (const c of concepts) {
    const target = c.doc.sessionRef;
    const frozenSpecs =
      freezeEnabled && digestGeneratedAt !== null && c.generatedAt <= digestGeneratedAt
        ? frozen.byRef.get(target)
        : undefined;
    if (frozenSpecs !== undefined && frozenSpecs.length > 0) {
      finalSegmentsBySession[target] = frozenSpecs; // 旧段逐字节不变
      continue; // 冻结会话:category 写回跳过(保持现值)
    }
    if (parsed.value.segmentsBySession[target] !== undefined) {
      finalSegmentsBySession[target] = parsed.value.segmentsBySession[target];
    }
    if (target in parsed.value.categoryBySession) {
      finalCategoryBySession[target] = parsed.value.categoryBySession[target];
    }
  }

  // category + description 写回(仅未冻结会话):逐概念读文件 → frontmatter
  // category/description 正则替换 → 原子写。description = 模型整会话归纳
  // (时间线块标题来源,禁止照抄用户提示词;清洗重跑不覆盖,见 session-writer)。
  for (const c of concepts) {
    const target = c.doc.sessionRef;
    const category = finalCategoryBySession[target];
    const summary = parsed.value.summaryBySession[target];
    if (category === undefined && summary === undefined) continue; // 模型未给出或已冻结 → 保持现状
    const content = await readConcept(c.rel);
    if (content.isErr()) return content;
    if (content.value === null) continue;
    let next = content.value;
    if (category !== undefined) next = replaceCategoryInConcept(next, category);
    if (summary !== undefined) next = replaceDescriptionInConcept(next, summary);
    if (next === content.value) continue; // 已是该值 → 跳过
    const written = await writeConcept(c.rel, next);
    if (written.isErr()) return written;
  }

  const digestRel = dayConceptPath(workspaceSlug, dateISO);
  return writeConcept(
    digestRel,
    buildDigestDoc(workspaceSlug, dateISO, parsed.value.digest, finalSegmentsBySession, tags),
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
 * 判定规则:digest 缺 generatedAt → stale;概念 generatedAt > digest
 * generatedAt → stale(会话增长);tags 指纹 != 本次标签列表 → stale
 * (标签列表变化 → 全量重编译)。2026-08-14 起不再以「缺 segments 块」为
 * stale 条件(永久 stale 陷阱根除:digest 存在且无新概念 → 不编译)。
 */
export async function dayDigestStaleGroups(
  dateISO: string,
  tags: string[],
): Promise<Result<StaleDayGroup[]>> {
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

  const tagsSig = tags.join('\u0000');
  const stale: StaleDayGroup[] = [];
  for (const [slug, group] of bySlug) {
    const digestRel = dayConceptPath(slug, dateISO);
    const meta = await readDigestMeta(digestRel);
    if (meta.generatedAt === null) {
      stale.push({ slug, concepts: group });
      continue;
    }
    const generatedAt = meta.generatedAt; // 收窄为 number(闭包内属性收窄不传播)
    const isStale = group.some((c) => c.generatedAt > generatedAt) || meta.tagsSig !== tagsSig;
    if (isStale) stale.push({ slug, concepts: group });
  }
  return ok(stale);
}

/**
 * 编译当日 stale 工作区(plan S5/D4 拆分):对 dayDigestStaleGroups 每组调
 * compileWorkspace;空组 → ok;首个 Err 返回(调用方 fail-open)。
 * tags 缺省 = DEFAULT_TAGS(用户未自定义标签时的内置列表)。
 */
export async function compileDay(
  dateISO: string,
  deps: { invoke?: ModelInvoke; tags?: string[] } = {},
): Promise<Result<void>> {
  const tags = deps.tags ?? [...DEFAULT_TAGS];
  const groupsResult = await dayDigestStaleGroups(dateISO, tags);
  if (groupsResult.isErr()) return groupsResult;
  const groups = groupsResult.value;
  if (groups.length === 0) return ok(); // 当日无 stale 工作区 → 无需编译

  const invoke = deps.invoke ?? createCompileModelInvoke();
  for (const group of groups) {
    const compiled = await compileWorkspace(dateISO, group.slug, group.concepts, invoke, tags);
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
  deps: { invoke?: ModelInvoke; tags?: string[] } = {},
): Promise<Result<void>> {
  return compileDay(dateISO, deps);
}
