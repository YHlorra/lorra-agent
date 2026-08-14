/**
 * 会话启动记忆召回注入(design 6.6,任务 6.5/6.6):
 * 从共享 MemoryStore 召回「user 级全局 + 当前工作区」的生效条目,组装为注入
 * 文本块。检索永不授权:召回仅作参考注入,唯一有否决权的是用户
 * 显式 hard_policy。
 *
 * fail-open 铁律:store 未就绪 / recall Err / 抛错 / 无候选 → 一律返回空串,
 * 绝不抛异常、绝不阻塞会话启动(注入挂点拿到空串即原样发送)。
 */

import {
  MEMORY_EVIDENCE_LABELS,
  MEMORY_RECALL_TOP_K,
  type MemoryEntry,
} from '../../shared/memory-schema';
import { getSharedMemoryStore } from './shared-memory-store';

// marker 与显示剥离实现位于纯共享模块 src/shared/recall-context.ts
// (event-mapper/client 测试图引用,零 node 依赖);此处再导出保持既有导入面。
export { RECALL_CONTEXT_MARKER, stripRecallContext } from '../../shared/recall-context';

/** 单条记忆内容注入时的最大字符数(design 6.6:截断 ~200 字)。 */
export const RECALL_CONTENT_MAX_CHARS = 200;

export interface BuildRecallContextArgs {
  /** 当前工作区路径:recall 的 workspace 过滤键。 */
  workspace: string;
  /** 召回条数上限;缺省 MEMORY_RECALL_TOP_K。 */
  k?: number;
  /** 可选查询词(design 6.14):透传 recall 参与 BM25 排序,命中条目注入取「含词段」而非首段。 */
  query?: string;
}

/**
 * 组装召回注入块。scope 传 'workspace' 单次查询即含 user 级全局条目
 * (user/agent 级恒命中 + 当前工作区 workspace/project 级匹配,由 store 保证)。
 * 每条记忆渲染为「类别 + 标题 + 内容(段落感知截断 ~200 字)+ 证据标注」。
 * 无候选 → 返回空串(不注入任何内容)。
 */
export function buildRecallContext(args: BuildRecallContextArgs): string {
  const k = args.k ?? MEMORY_RECALL_TOP_K;
  const query = args.query?.trim() || undefined;
  let entries: MemoryEntry[];
  try {
    const storeResult = getSharedMemoryStore();
    if (storeResult.isErr()) return '';
    const recallResult = storeResult.value.recall({
      scope: 'workspace',
      workspace: args.workspace,
      k,
      ...(query !== undefined ? { query } : {}),
    });
    if (recallResult.isErr()) return '';
    entries = recallResult.value;
  } catch {
    // fail-open:任何异常都视为无召回,绝不阻断会话启动
    return '';
  }
  if (entries.length === 0) return '';
  const hits = entries.slice(0, k).map((entry) => formatEntry(entry, query));
  const hops = entries.slice(k).map((entry) => {
    const content = truncateContent(entry.content);
    const label = MEMORY_EVIDENCE_LABELS[entry.evidence];
    return `- [${entry.kind}] ${entry.title}：${content}(${label}，关联页)`;
  });
  return [...hits, ...hops].join('\n');
}

function formatEntry(entry: MemoryEntry, query?: string): string {
  const content = truncateContent(entry.content, query);
  const label = MEMORY_EVIDENCE_LABELS[entry.evidence];
  // :条目带 OFK 指针 → 行尾标注文档位置(内容已是摘要,截断逻辑不变)。
  const docSuffix = entry.ofkRef ? `（文档：${entry.ofkRef}）` : '';
  return `- [${entry.kind}] ${entry.title}：${content}(${label})${docSuffix}`;
}

/**
 * 段落感知截断(design 6.14):内容不超上限 → 原样;超限 → 取「首段」
 * (首个 \n\n 块,无空行分段时按首行);有查询词时取「命中段」(含查询词
 * 所在段落,按 \n\n 切分;无命中段回退首段)。选中段仍超上限 → 段落尾部
 * 裁剪附省略号,标题恒在(标题在 formatEntry 中独立渲染,不受此限)。
 */
function truncateContent(content: string, query?: string): string {
  if (content.length <= RECALL_CONTENT_MAX_CHARS) return content;
  const selected = selectParagraph(content, query);
  if (selected.length <= RECALL_CONTENT_MAX_CHARS) return selected;
  return `${truncateToMaxChars(selected, RECALL_CONTENT_MAX_CHARS)}…`;
}

function selectParagraph(content: string, query?: string): string {
  if (query !== undefined) {
    const hit = content.split('\n\n').find((paragraph) => paragraph.includes(query));
    if (hit !== undefined) return hit;
  }
  const blockEnd = content.indexOf('\n\n');
  if (blockEnd !== -1) return content.slice(0, blockEnd);
  const lineEnd = content.indexOf('\n');
  return lineEnd === -1 ? content : content.slice(0, lineEnd);
}

/**
 * 上限内安全裁剪:不切断 UTF-16 代理对。朴素 slice 会把 astral 字符劈成
 * 孤立代理,编码(UTF-8 落盘/IPC 序列化)后退化为 U+FFFD;此处边界落在低
 * 代理上时回退一个单元,保证输出恒为合法字符序列。
 */
function truncateToMaxChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max);
  const end = code >= 0xdc00 && code <= 0xdfff ? max - 1 : max;
  return text.slice(0, end);
}
