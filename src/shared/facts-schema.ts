import { createHash } from 'node:crypto';
import type { SessionCategory } from './ofk-schema';

/**
 * 标准事实 schema(agent-memory-today-timeline D2):
 * 收集清洗层与合并解读层之间的唯一契约。schema 演进通过提升
 * FACTS_SCHEMA_VERSION 实现,不得破坏性修改已落盘记录。
 */
export const FACTS_SCHEMA_VERSION = 1;

/** 隐私三分枚举:可公开 / 本地私有 / 私有指针。 */
export type FactPrivacy = 'public_safe' | 'local_private' | 'private_pointer';

export interface SessionFact {
  // 身份
  factId: string;
  schemaVersion: number;
  // 来源
  collector: string;
  runtime: string;
  agentId: string;
  sessionRef: string;
  // 范围
  workspace: string;
  scope: 'user' | 'workspace' | 'project' | 'agent';
  // 时间
  start: number;
  end: number;
  activeMs: number;
  // 内容
  title: string;
  summaryRef: string | null;
  // 用量
  tokens: number;
  model: string;
  tools: string[];
  // 标记
  unfinished: boolean;
  containsTodo: boolean;
  /**
 * 会话大类(OFK 概念层附加,plan D2):pi-sdk 清洗不设置(undefined →
 * JSON.stringify 丢弃,factIdOf 不受影响);OFK 聚合(day-aggregate)从
 * 概念 frontmatter 写入。今日页按此分组,缺省归「未分类」。
 */
  category?: SessionCategory;
  // 隐私
  privacy: FactPrivacy;
}

/**
 * 规范化内容哈希:对除 factId 外全部字段做键排序 + 紧凑 JSON 序列化后取
 * sha256。同内容(字段键序无关)必然得到同一 factId;内容任一变化(如会话
 * 增长后 end/activeMs 变大)factId 随之变化。
 */
export function factIdOf(fact: Omit<SessionFact, 'factId'>): string {
  const canonical = JSON.stringify(sortKeys(fact));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
