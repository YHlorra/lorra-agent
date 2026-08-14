import type { SessionFact } from '../../shared/facts-schema';
import { FACTS_SCHEMA_VERSION, factIdOf } from '../../shared/facts-schema';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import { computeActiveMs } from './duration';

/**
 * pi-sdk jsonl 中一条会话记录的原始形状:带 id/parentId 的树节点。
 * message 仅存在于消息类条目(model_change/branch/compaction 等结构节点
 * 无 message,仍参与会话树的分支计算)。model_change 条目(provider/modelId)
 * 决定活跃路径上的 fact.model。
 */
export interface RawSessionEntry {
  id: string;
  parentId: string | null;
  timestamp: number;
  /** jsonl 记录类别(原始形状保留):'message' 消息 / 'model_change' 结构节点等。 */
  type?: string;
  message?: {
    role: string;
    content: unknown;
    /** SDK assistant 消息附带的 token 用量(缺省视为 0)。 */
    usage?: { totalTokens?: number };
  };
  /** SDK model_change 条目:provider + modelId(拼接为 'provider/modelId')。 */
  modelChange?: { provider: string; modelId: string };
}

/** title = 首条 user 消息截断的定长(前缀保留 + 长度变短 + 确定性)。 */
export const TITLE_MAX_LENGTH = 60;

/**
 * 把一条会话的原始记录清洗成标准事实(spec 标准事实 schema 契约)。
 *
 * 分支会话树处理:
 * - 全部叶子中时间戳最大者为活跃叶
 * - 活跃路径上「最深的分叉节点」之下为分支独有序列;无分叉(单叶)时取
 * 整条路径
 * - start/end/activeMs/title/unfinished/containsTodo 均只反映该序列
 *
 * title = 首条 user 消息文本截断(确定性规则,不依赖 LLM)。
 * unfinished = 序列最后一条消息 role 为 user。
 * containsTodo = 序列任一消息文本含 todo 表述(/\btodo\b/i)。
 */
export function cleanseSession(
  header: { id: string; cwd: string },
  entries: RawSessionEntry[],
  workspace: string,
): Result<SessionFact> {
  if (!header || typeof header.id !== 'string' || header.id.length === 0) {
    return err({ code: 'session-header-missing', message: 'session header missing id' });
  }
  if (entries.length === 0) {
    return err({ code: 'empty-session', message: `session ${header.id} has no entries` });
  }
  // 退化输入防御:非法时间戳 / 消息缺 role 的条目直接判整会话 Err。
  for (const entry of entries) {
    if (typeof entry?.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) {
      return err({
        code: 'invalid-entry-timestamp',
        message: `session ${header.id} entry ${entry?.id ?? '?'} has invalid timestamp`,
      });
    }
    if (
      entry.message &&
      (typeof entry.message.role !== 'string' || entry.message.role.length === 0)
    ) {
      return err({
        code: 'message-missing-role',
        message: `session ${header.id} entry ${entry.id} message missing role`,
      });
    }
  }

  const branchResult = resolveActiveBranch(header, entries);
  if (branchResult.isErr()) return branchResult;
  const { path, sequence } = branchResult.value;

  const timestamps = sequence.map((e) => e.timestamp).sort((a, b) => a - b);
  const start = timestamps[0];
  const end = timestamps[timestamps.length - 1];
  const activeMs = computeActiveMs(timestamps);
  const title = truncateTitle(firstUserText(sequence));
  const last = sequence[sequence.length - 1];
  const unfinished = last?.message?.role === 'user';
  const containsTodo = sequence.some((e) => /\btodo\b/i.test(messageText(e)));

  // usage 提取:
  // - model:活跃路径(根→叶)上最后一条 model_change 的 'provider/modelId'
  // (model_change 是结构节点,不在消息序列内,故按路径取)
  // - tokens:活跃分支序列内全部 assistant 消息 usage.totalTokens 之和
  // (与 title/时长口径一致;usage 缺失贡献 0)
  // - tools:序列内 assistant 消息 content 的 tool_use/toolUse/toolCall 块
  // 工具名去重、按首次出现顺序
  let model = '';
  const tokens = sequence.reduce(
    (sum, entry) =>
      sum + (entry.message?.role === 'assistant' ? (entry.message.usage?.totalTokens ?? 0) : 0),
    0,
  );
  const seenTools: string[] = [];
  for (const entry of path) {
    const mc = entry.modelChange;
    if (
      mc &&
      typeof mc.provider === 'string' &&
      mc.provider &&
      typeof mc.modelId === 'string' &&
      mc.modelId
    ) {
      model = `${mc.provider}/${mc.modelId}`;
    }
  }
  for (const entry of sequence) {
    if (entry.message?.role !== 'assistant') continue;
    for (const name of extractToolNames(entry.message.content)) {
      if (!seenTools.includes(name)) seenTools.push(name);
    }
  }

  const fact: Omit<SessionFact, 'factId'> = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: 'pi-sdk',
    runtime: 'pi-sdk',
    agentId: 'pi-sdk',
    sessionRef: header.id,
    workspace,
    scope: 'workspace',
    start,
    end,
    activeMs,
    title,
    summaryRef: null,
    tokens,
    model,
    tools: seenTools,
    unfinished,
    containsTodo,
    privacy: 'public_safe',
  };
  return ok({ ...fact, factId: factIdOf(fact) });
}

/**
 * 分支树活跃序列解析(cleanseSession 分支处理核心,抽离供 OFK 概念正文
 * 构建复用;行为与原 cleanseSession 内联实现零变化):
 * - 全部叶子中时间戳最大者为活跃叶
 * - 活跃路径上「最深的分叉节点」之下为分支独有序列;无分叉(单叶)时取
 * 整条路径
 * - 退化:活跃分支无消息(如活跃叶是 model_change)回退整条路径消息;
 * 仍无消息 → Err('no-session-content')
 * - 无叶子 → Err('no-session-leaf')
 */
export function resolveActiveSequence(
  header: { id: string; cwd?: string },
  entries: RawSessionEntry[],
): Result<RawSessionEntry[]> {
  const branch = resolveActiveBranch(header, entries);
  if (branch.isErr()) return branch;
  return ok(branch.value.sequence);
}

/** 活跃路径(根→叶,含 model_change 等结构节点)+ 活跃序列;cleanseSession 单次调用取两者。 */
function resolveActiveBranch(
  header: { id: string; cwd?: string },
  entries: RawSessionEntry[],
): Result<{ path: RawSessionEntry[]; sequence: RawSessionEntry[] }> {
  const byId = new Map<string, RawSessionEntry>();
  const children = new Map<string, RawSessionEntry[]>();
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || entry.id.length === 0) continue;
    byId.set(entry.id, entry);
    if (entry.parentId != null) {
      const list = children.get(entry.parentId) ?? [];
      list.push(entry);
      children.set(entry.parentId, list);
    }
  }

  // 叶子 = 无子节点的条目;活跃叶 = 时间戳最大的叶子。
  const leaves = [...byId.values()].filter((e) => (children.get(e.id)?.length ?? 0) === 0);
  if (leaves.length === 0) {
    return err({ code: 'no-session-leaf', message: `session ${header.id} has no leaf entries` });
  }
  const activeLeaf = leaves.reduce((best, e) => (e.timestamp > best.timestamp ? e : best));

  // 根 → 活跃叶路径。
  const path: RawSessionEntry[] = [];
  let cursor: RawSessionEntry | undefined = activeLeaf;
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentId != null ? byId.get(cursor.parentId) : undefined;
  }

  // 分叉点 = 活跃路径上最深、且拥有「非活跃叶」后代节点的节点;
  // 其子节点起为分支独有序列(分叉节点自身的消息不属独有部分)。
  const leafIds = new Set(leaves.map((l) => l.id));
  let forkIndex = -1;
  for (let i = 0; i < path.length; i++) {
    if (hasOtherLeafDescendant(path[i].id, children, activeLeaf.id, leafIds)) forkIndex = i;
  }

  let sequence = path.slice(forkIndex + 1).filter((e) => e.message);
  if (sequence.length === 0) {
    // 退化:活跃分支无消息(如活跃叶是 model_change)。回退到整条路径消息。
    sequence = path.filter((e) => e.message);
  }
  if (sequence.length === 0) {
    return err({
      code: 'no-session-content',
      message: `session ${header.id} has no message content`,
    });
  }
  return ok({ path, sequence });
}

/** 从 assistant 消息 content 提取 tool_use/toolUse/toolCall 块的工具名(按出现顺序)。 */
export function extractToolNames(content: unknown): string[] {
  const blocks = Array.isArray(content) ? content : [content];
  const names: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === 'object') {
      const record = block as { type?: unknown; name?: unknown };
      if (
        (record.type === 'tool_use' || record.type === 'toolUse' || record.type === 'toolCall') &&
        typeof record.name === 'string' &&
        record.name.length > 0
      ) {
        names.push(record.name);
      }
    }
  }
  return names;
}

/** 从节点向下(含自身)是否存在一个非活跃叶的叶子后代。 */
function hasOtherLeafDescendant(
  nodeId: string,
  children: Map<string, RawSessionEntry[]>,
  activeLeafId: string,
  leafIds: Set<string>,
): boolean {
  const stack = [...(children.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    if (node.id === activeLeafId) continue;
    if (leafIds.has(node.id)) return true;
    stack.push(...(children.get(node.id) ?? []));
  }
  return false;
}

/** 序列中第一条 user 消息的文本(首条为空则继续找下一条)。 */
function firstUserText(sequence: RawSessionEntry[]): string {
  for (const entry of sequence) {
    if (entry.message?.role !== 'user') continue;
    const text = messageText(entry).trim();
    if (text) return text;
  }
  return '';
}

function truncateTitle(text: string): string {
  if (text.length <= TITLE_MAX_LENGTH) return text;
  return text.slice(0, TITLE_MAX_LENGTH);
}

/** 从 message.content 提取纯文本(text 块数组 / 字符串 / {type:text})。 */
export function messageText(entry: RawSessionEntry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object') {
          const record = block as { type?: unknown; text?: unknown };
          if (record.type === 'text' && typeof record.text === 'string') return record.text;
        }
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') return record.text;
  }
  return '';
}
