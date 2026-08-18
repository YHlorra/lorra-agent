import { readFileSync } from 'node:fs';
import type { SessionFact } from '../../shared/facts-schema';
import { SEGMENT_BREAK_GAP_MS } from '../../shared/gap';
import {
  isSessionCategory,
  parseSessionConcept,
  type SessionCategory,
  yamlQuote,
} from '../../shared/ofk-schema';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import {
  cleanseSession,
  extractToolNames,
  messageText,
  type RawSessionEntry,
  resolveActiveSequence,
} from '../memory/cleanse';
import { parseSessionJsonl } from '../memory/collectors/pi-sdk-collector';
import { localDateString } from '../memory/day-summary';
import {
  appendLog,
  readConcept,
  refreshIndex,
  sessionConceptPath,
  writeConcept,
} from './ofk-bundle';

/**
 * OFK 会话概念写入:pi-sdk 会话清洗 → D3 概念文档(确定性正文,
 * 无 LLM)→ 原子写 bundle → 根索引/变更日志同步。原始 jsonl 全程只读。
 */

/** 正文「用户要求/结果」条目文本截断定长(前缀保留 + 长度变短 + 确定性)。 */
export const CONCEPT_TEXT_LIMIT = 500;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 活跃序列 → 断口时刻数组(D2):相邻消息间隔 > SEGMENT_BREAK_GAP_MS 时,
 * 后一条消息时刻为断口。插件源(sequence=null)→ []。
 */
export function computeBreaks(sequence: RawSessionEntry[] | null): number[] {
  if (sequence === null) return [];
  const stamps = sequence.map((e) => e.timestamp).sort((a, b) => a - b);
  const breaks: number[] = [];
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i] - stamps[i - 1] > SEGMENT_BREAK_GAP_MS) breaks.push(stamps[i]);
  }
  return breaks;
}

function buildBody(fact: SessionFact, sequence: RawSessionEntry[] | null): string {
  if (!sequence) {
    // 非 pi 源(插件):无消息序列,仅工具名列表
    return `## 智能体做了什么\n- 调用工具：${fact.tools.join('、') || '无'}\n`;
  }
  const parts: string[] = [];
  const userItems: string[] = [];
  for (const entry of sequence) {
    if (entry.message?.role !== 'user') continue;
    const text = collapseWs(messageText(entry));
    if (!text) continue;
    userItems.push(`- [${hhmm(entry.timestamp)}] ${truncate(text, CONCEPT_TEXT_LIMIT)}`);
  }
  parts.push('## 用户要求');
  if (userItems.length > 0) parts.push(...userItems);

  // 工具名列表 = 去重后的 fact.tools;「共 N 次」的 N = 序列中 tool 块总数。
  const count = sequence.reduce(
    (sum, entry) =>
      sum +
      (entry.message?.role === 'assistant' ? extractToolNames(entry.message.content).length : 0),
    0,
  );
  parts.push('## 智能体做了什么');
  parts.push(`- 调用工具：${fact.tools.join('、') || '无'}（共 ${count} 次）`);

  const lastAssistant = [...sequence].reverse().find((e) => e.message?.role === 'assistant');
  parts.push('## 结果');
  if (lastAssistant) {
    const text = collapseWs(messageText(lastAssistant));
    if (text) parts.push(`- ${truncate(text, CONCEPT_TEXT_LIMIT)}`);
  }
  return `${parts.join('\n')}\n`;
}

/**
 * 构建完整概念文档(plan D3):frontmatter 手写模板,字段序 = D3 精确序
 * (sessionRef 为概念写回字段,加在 workspace 之后);generated.at 取
 * fact.end(内容确定性:同一 jsonl 两次构建产出同一文档,diff-skip 生效,
 * 且「会话最后消息晚于摘要」天然驱动 P2 摘要过期判定)。
 */
export function buildSessionConcept(
  fact: SessionFact,
  sequence: RawSessionEntry[] | null,
  category: SessionCategory,
  sourceJsonl?: string,
  /** LLM 整会话归纳(P2 编译写回);重清洗时保留,缺省 = title 播种初值。 */
  description?: string,
): string {
  const startISO = new Date(fact.start).toISOString();
  const endISO = new Date(fact.end).toISOString();
  const toolsStr = fact.tools.length === 0 ? '[]' : `[${fact.tools.map(yamlQuote).join(', ')}]`;
  const breaks = computeBreaks(sequence);
  const lines = [
    '---',
    'type: Session',
    `title: ${yamlQuote(fact.title)}`,
    `description: ${yamlQuote(description ?? fact.title)}`,
    `category: ${category}`,
    `workspace: ${yamlQuote(fact.workspace)}`,
    `sessionRef: ${yamlQuote(fact.sessionRef)}`,
    `start: ${startISO}`,
    `end: ${endISO}`,
    `active_ms: ${fact.activeMs}`,
    ...(breaks.length > 0 ? [`breaks: [${breaks.join(', ')}]`] : []),
    `tokens: ${fact.tokens}`,
    `model: ${yamlQuote(fact.model)}`,
    `tools: ${toolsStr}`,
    `unfinished: ${fact.unfinished}`,
    `contains_todo: ${fact.containsTodo}`,
    `privacy: ${fact.privacy}`,
    'sources:',
    `  - id: ${yamlQuote(fact.collector)}`,
    ...(sourceJsonl ? [`    resource: ${yamlQuote(sourceJsonl)}`] : []),
    `generated: { by: process:lorra-cleanse/1, at: ${endISO} }`,
    '---',
    '',
    buildBody(fact, sequence),
  ];
  return `${lines.join('\n')}`;
}

/** 内容与磁盘相同则跳过(不刷 index/log);否则写入 + 刷索引 + 追加日志。 */
async function writeWithMeta(
  rel: string,
  content: string,
  logEntry: string,
): Promise<Result<void>> {
  const existing = await readConcept(rel);
  if (existing.isErr()) return existing;
  if (existing.value === content) return ok();
  const written = await writeConcept(rel, content);
  if (written.isErr()) return written;
  const idx = await refreshIndex();
  if (idx.isErr()) return idx;
  return appendLog(localDateString(new Date()), logEntry);
}

/** 写会话概念(插件源:sequence=null、无 jsonl 源);失败透传 Err。 */
export async function writeSessionConcept(
  fact: SessionFact,
  category: SessionCategory,
  sequence: RawSessionEntry[] | null = null,
  sourceJsonl?: string,
  description?: string,
): Promise<Result<void>> {
  const content = buildSessionConcept(fact, sequence, category, sourceJsonl, description);
  const rel = sessionConceptPath(fact);
  const logEntry = `**Creation**: [${fact.title.replace(/[[\]]/g, '')}](${rel})`;
  return writeWithMeta(rel, content, logEntry);
}

/**
 * 冷路径全量同步(step 4/5):读 jsonl → parseSessionJsonl →
 * cleanseSession(校验+事实)→ resolveActiveSequence(正文序列)→
 * writeSessionConcept(内容相同跳过)。坏文件 → Err,调用方 fail-open。
 * category 与 description 保持概念现有值(agent/编译维护;P2 摘要编译
 * 写回后不被清洗覆盖)。
 */
export async function syncSessionFile(
  jsonlPath: string,
  workspaceFallback: string,
): Promise<Result<SessionFact>> {
  let content: string;
  try {
    content = readFileSync(jsonlPath, 'utf8');
  } catch (cause) {
    return err(toLorraError(cause, 'session-file-unreadable'));
  }
  const parsed = parseSessionJsonl(content);
  if (!parsed.header) {
    return err({ code: 'session-header-missing', message: `no session header: ${jsonlPath}` });
  }
  if (parsed.skippedLines.length > 0) {
    console.error(
      `[session-writer] ${jsonlPath}: skipped ${parsed.skippedLines.length} malformed line(s)`,
    );
  }
  const resolvedWorkspace =
    parsed.header.cwd && parsed.header.cwd.length > 0 ? parsed.header.cwd : workspaceFallback;
  const cleansed = cleanseSession(parsed.header, parsed.entries, resolvedWorkspace);
  if (cleansed.isErr()) return cleansed;
  const fact = cleansed.value;
  const sequenceResult = resolveActiveSequence(parsed.header, parsed.entries);
  const sequence = sequenceResult.isOk() ? sequenceResult.value : null;
  const existing = await readExistingMeta(fact);
  const written = await writeSessionConcept(
    fact,
    existing.category,
    sequence,
    jsonlPath,
    existing.description,
  );
  if (written.isErr()) return written;
  return ok(fact);
}

/** 读概念现有 category + description(缺失/解析失败 → 未分类 / undefined)。
 * description 与 title 相同(清洗播种初值)→ undefined,不写回旧值。 */
export async function readExistingMeta(fact: SessionFact): Promise<{
  category: SessionCategory;
  description?: string;
}> {
  const read = await readConcept(sessionConceptPath(fact));
  if (read.isErr() || read.value === null) return { category: '未分类' };
  const parsed = parseSessionConcept(read.value);
  if (!parsed) return { category: '未分类' };
  const description =
    parsed.description.trim().length > 0 && parsed.description !== parsed.title
      ? parsed.description
      : undefined;
  return {
    category: isSessionCategory(parsed.category) ? parsed.category : '未分类',
    ...(description !== undefined ? { description } : {}),
  };
}
