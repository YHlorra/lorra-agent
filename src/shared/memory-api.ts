/**
 * 记忆 IPC 契约单一事实源（design 落地锚点 / 教训）：
 * 通道名与参数形状只在本文件定义，preload 与主进程共用，renderer 测试
 * mock 引用同一类型——漂移在编译期暴露。
 *
 * （自主记忆）：拆除候选确认闸门——写入直落 active，无 confirm/
 * reject/批量通道；维护靠 agent 自审计（update 走 supersedes 链、retire）
 * + 用户浮出触点自然纠正（纠正由 agent 代为执行，不设计纠正管线）。
 * edit handler 不重写 entries.evidence（「证据不因写入而改变」）。
 */

import type { MemoryKind, MemoryScope } from './memory-schema';

export type { MemoryEntry } from './memory-schema';

// ---- 列表 ----

export interface ListActiveArgs {
  /** 按类别过滤；缺省返回全部生效条目。 */
  kind?: MemoryKind;
}

/** 审计视图：entryId 缺省返回全部事件（ts 倒序）。 */
export interface ListEventsArgs {
  entryId?: string;
}

/**
 * 图谱数据出口：entry_links 全量边列表（展示阶段消费——
 * 网络图/关系面板数据源）。无参数、无排序保证。
 */
export interface MemoryLink {
  fromId: string;
  toId: string;
}

// ---- 操作（全部以 entryId 寻址， opaque id） ----

export interface RetireArgs {
  entryId: string;
}

/**
 * 用户侧编辑（记忆页触点③）：语义 = store.update——以补丁字段新建 entry
 * （supersedes 指向原 entry，kind/producer/source/scope/workspace/evidence
 * 继承，basis 缺省继承），原 entry → superseded，新 entry 直落 active。
 * 内容超 MEMORY_CONTENT_MAX_BYTES → 结构化拒绝。
 */
export interface EditArgs {
  entryId: string;
  title: string;
  content: string;
  basis?: string;
  /** 类别可改（2026-08-10 放开；evidence/scope 继承不变）。 */
  kind?: MemoryKind;
}

// ---- 搜索 ----

export interface SearchArgs {
  query: string;
  /** 缺省按当前工作区 scope 过滤（user 级全局 + 当前工作区）。 */
  scope?: MemoryScope;
  workspace?: string | null;
}

// ---- 素材消化 + 用户结晶（6.13） ----

/**
 * 文本粘贴消化：原文不落库（raw 只读），模型提取 → knowledge 条目
 * （evidence=extracted），直落 active（无闸门）。无模型/超时/失败
 * → 不落任何东西，结构化错误返回。
 */
export interface DigestTextArgs {
  text: string;
  title?: string;
}

/** 本地文件消化：读文件内容（≤ 阈值）→ 同 DigestTextArgs 语义。 */
export interface DigestFileArgs {
  filePath: string;
}

/**
 * 消化结果（ingest 编译）：
 * compiled=true 表示命中既有 knowledge 页并就地更新（supersedes 链），
 * matchedTitle 为被更新页原标题；false/缺省 = 新增。
 */
export interface DigestResult {
  entryId: string;
  compiled?: boolean;
  matchedTitle?: string;
}

/**
 * 用户主动结晶（会话内「记住这段」）：content ≤ MEMORY_CONTENT_MAX_BYTES，
 * source=user-crystallization，evidence=user-stated（用户明说），直落 active。
 */
export interface CrystallizeArgs {
  content: string;
  title?: string;
}

export interface CoreProjectionDto {
  text: string;
  workspaceIdentity: string;
  entryIds: string[];
}

export interface WorkingMemorySnapshotDto {
  goal?: string;
  constraints: string[];
  openLoops: string[];
  recentCorrections: string[];
  recentDecisions: string[];
  pendingFacts: string[];
  updatedAt: number;
  lastCompactedAt?: number;
}

export type ArchivalTrigger =
  | 'session-start'
  | 'history'
  | 'preference'
  | 'workspace'
  | 'correction'
  | 'resume';

export interface ArchivalAuditDto {
  reason: string;
  triggeredBy: ArchivalTrigger;
  sources: Array<'memory' | 'ofk'>;
  query?: string;
  memoryEntryIds: string[];
  ofkPaths: string[];
  text: string;
  updatedAt: number;
}

export interface ExperienceCaseDto {
  caseId: string;
  title: string;
  problem: string;
  solution: string;
  constraints: string[];
  sourceEntryIds: string[];
  workspace: string;
  updatedAt: number;
}

export interface ExperienceAuditDto {
  skillName: string;
  generated: boolean;
  filePath: string | null;
  caseIds: string[];
  entryIds: string[];
  warnings: string[];
}

export interface OkfIssueDto {
  level: 'info' | 'warn';
  code: string;
  message: string;
}

export interface OkfCheckResultDto {
  path: string;
  type: string | null;
  generated: boolean;
  verified: boolean;
  issues: OkfIssueDto[];
}

// ---- 通道名 ----

export const MEMORY_CHANNEL_LIST_ACTIVE = 'lorra.memory.list-active';
export const MEMORY_CHANNEL_LIST_ARCHIVED = 'lorra.memory.list-archived';
export const MEMORY_CHANNEL_LIST_EVENTS = 'lorra.memory.list-events';
export const MEMORY_CHANNEL_LIST_LINKS = 'lorra.memory.list-links';
export const MEMORY_CHANNEL_EDIT = 'lorra.memory.edit';
export const MEMORY_CHANNEL_RETIRE = 'lorra.memory.retire';
export const MEMORY_CHANNEL_SEARCH = 'lorra.memory.search';
export const MEMORY_CHANNEL_DIGEST_TEXT = 'lorra.memory.digest-text';
export const MEMORY_CHANNEL_DIGEST_FILE = 'lorra.memory.digest-file';
export const MEMORY_CHANNEL_CRYSTALLIZE = 'lorra.memory.crystallize';
export const KNOWLEDGE_CHANNEL_READ = 'lorra.knowledge.read';
export const MEMORY_CHANNEL_GET_CORE_PROJECTION = 'lorra.memory.get-core-projection';
export const MEMORY_CHANNEL_GET_WORKING_MEMORY = 'lorra.memory.get-working-memory';
export const MEMORY_CHANNEL_GET_ARCHIVAL_AUDIT = 'lorra.memory.get-archival-audit';
export const MEMORY_CHANNEL_GET_EXPERIENCE_AUDIT = 'lorra.memory.get-experience-audit';
export const MEMORY_CHANNEL_OKF_CHECK = 'lorra.memory.okf-check';
