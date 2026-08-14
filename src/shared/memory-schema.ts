/**
 * 记忆系统 schema（agent-memory-today-timeline D12 / +
 * + 演进）：八类 corpus、evidence 四态、双层架构在 6.1
 * 建表前钉死； 拆除候选闸门——lifecycle 收窄为
 * active/superseded/retired，写入直落 active，agent 自审计自维护，用户仅
 * 在浮出触点自然纠正； 扩展八类 corpus（user_profile/event）与
 * 第五写入通道 session-extraction（会话自动提取）。
 * 沉淀层唯一数据形状，主进程存储与 renderer 页面共用；演进通过提升
 * MEMORY_SCHEMA_VERSION，不得破坏性修改已落盘记录（facts-schema.ts 同款纪律）。
 *
 * 分类对齐 OpenViking 存储结构：user_profile↔profile、soft_preference↔
 * preferences、knowledge↔entities/cases、procedural_experience↔
 * experiences/trajectories、run_bound_feedback↔tools、event↔events；
 * identity/soul（agent 人格）不适用。
 *
 * 产品哲学锚点（/D2/D3 + /D4/D5）：
 * - raw 只读：会话 jsonl / 事实库 / 素材输入永不改写、永不直接进召回池。
 * - 无写前闸门：五写入通道产物直落 active（confirmedAt=now）；维护靠 agent
 * 自审计（update 走 supersedes 链 / retire）+ 浮出触点纠正（/D3）+
 * 会话自动提取。
 * - evidence 不因写入而改变：权威来自用户显式表达，可信度来自证据，两维度永不分叉。
 * - 内容为 markdown 页面形态（≤2KB），仍禁原文全文。
 *
 * 注意：本模块被 renderer(vite client) 打包，必须保持纯类型 + 纯常量、
 * 零 node:* 导入（node:crypto 在浏览器侧被 externalize 会运行期崩溃，
 * boot smoke 实证）。entryIdOf 哈希实现位于 src/main/memory/entry-hash.ts。
 */

export const MEMORY_SCHEMA_VERSION = 2;

/** 内容上限：记忆/知识页 markdown 形态上限，超限拒写入。 */
export const MEMORY_CONTENT_MAX_BYTES = 2048;

/** 长内容拆分阈值：utf8 字节超过该值的存量条目迁 OFK 文档，条目留摘要+指针。 */
export const MEMORY_SPLIT_THRESHOLD_BYTES = 1024;

/** 迁移摘要上限：拆分子段 ≤512 字节（首段优先），后附指针行。 */
export const MEMORY_SPLIT_SUMMARY_MAX_BYTES = 512;

/** 会话启动召回注入条数上限（design 6.6 默认值，可常量调整）。 */
export const MEMORY_RECALL_TOP_K = 5;

/**
 * 八类 corpus（+ 扩展）：五类行为记忆谱系 + knowledge
 * 知识页 + user_profile 用户档案 + event 事件记录。
 * 顺序即记忆页生效区分组顺序（尾部追加新类，前六项不动，最小化 UI 快照变动）。
 */
export type MemoryKind =
  | 'hard_policy'
  | 'soft_preference'
  | 'procedural_experience'
  | 'run_bound_feedback'
  | 'working_context'
  | 'knowledge'
  | 'user_profile'
  | 'event';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'hard_policy',
  'soft_preference',
  'procedural_experience',
  'run_bound_feedback',
  'working_context',
  'knowledge',
  'user_profile',
  'event',
];

/** 八类 corpus 中文标签(页面侧唯一事实源,会话卡片与记忆页共用)。 */
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  hard_policy: '硬性规则',
  soft_preference: '软性偏好',
  procedural_experience: '经验教训',
  run_bound_feedback: '运行反馈',
  working_context: '工作上下文',
  knowledge: '知识页',
  user_profile: '用户档案',
  event: '事件记录',
};

/**
 * 证据等级四态（替代 confidence）：
 * user-stated 用户明说 / extracted 从行为或素材观察提取 /
 * inferred agent 推断 / unverified 未验证。
 * 召回排序倾向即数组顺序；任何等级不提升权威（检索永不授权）。
 */
export type MemoryEvidence = 'user-stated' | 'extracted' | 'inferred' | 'unverified';

export const MEMORY_EVIDENCE_ORDER: readonly MemoryEvidence[] = [
  'user-stated',
  'extracted',
  'inferred',
  'unverified',
];

/** 证据徽标中文标签（你明说的/观察/推断/未验证）。 */
export const MEMORY_EVIDENCE_LABELS: Record<MemoryEvidence, string> = {
  'user-stated': '你明说的',
  extracted: '观察',
  inferred: 'agent 推断',
  unverified: '未验证',
};

/**
 * 生命周期（收窄三态；candidate/rejected 随闸门拆除）：
 * active 生效（唯一进召回池态，写入即达）/ superseded 被覆盖（supersedes 链，
 * update/edit 产生）/ retired 撤销（即时生效，agent 自维护）。
 */
export type MemoryLifecycle = 'active' | 'superseded' | 'retired';

/** scope 分级（与 SessionFact.scope 对齐）：user 级跨工作区共享。 */
export type MemoryScope = 'user' | 'workspace' | 'project' | 'agent';

export const MEMORY_SCOPE_LABELS: Record<MemoryScope, string> = {
  user: '用户级',
  workspace: '工作区',
  project: '项目',
  agent: 'agent',
};

/** 五写入通道（+ ：会话自动提取）。 */
export type MemorySource =
  | 'agent-proposal'
  | 'review-distillation'
  | 'material-digestion'
  | 'user-crystallization'
  | 'session-extraction';

export const MEMORY_SOURCE_LABELS: Record<MemorySource, string> = {
  'agent-proposal': 'agent 提议',
  'review-distillation': '复盘蒸馏',
  'material-digestion': '素材消化',
  'user-crystallization': '用户结晶',
  'session-extraction': '会话自动提取',
};

/** 审计事件类型（event_log 追加表； 重定，proposed→recorded，
 * confirmed/rejected 随闸门移除；旧库遗留的 proposed/confirmed/rejected
 * 行保留原文，类型收窄不影响读回）。 */
export type MemoryEventKind = 'recorded' | 'edited' | 'retired' | 'superseded';

export interface MemoryEvent {
  id: number;
  ts: number;
  entryId: string;
  event: MemoryEventKind;
  /** 结构化详情（如编辑前后 entry_id 链、拒绝原因），JSON 序列化。 */
  detail: string | null;
}

/**
 * 记忆条目（沉淀层唯一记录形状）。entry_id = sha256(规范化内容哈希)：
 * 同内容必然同 id（幂等去重）；内容任一变化 id 随之变化。
 * 编辑激活 = 以新内容新建 entry（新 entry_id，supersedes 指向原 entry），
 * 原 entry → superseded——哈希幂等与 supersedes 链同时成立。
 */
export interface MemoryEntry {
  // 身份
  entryId: string;
  schemaVersion: number;
  // 类别与内容（markdown 页面形态，≤ MEMORY_CONTENT_MAX_BYTES）
  kind: MemoryKind;
  title: string;
  content: string;
  // 标签（2026-08-10 标准化词表， ）：
  // 运行规定类（规定/偏好/经验/反馈/上下文/档案/事件）+
  // 项目类型类（项目〈名称〉/技术栈〈名〉/领域〈名〉/性质〈名〉）。
  // 空数组 = 无标签；来源/证据类词禁止作标签。不入内容哈希（幂等稳定）。
  tags: string[];
  // 来源
  producer: string;
  source: MemorySource;
  // 范围
  scope: MemoryScope;
  /** scope 为 workspace/project 时非空；user 级为 null。 */
  workspace: string | null;
  // 证据（确认不改变）
  evidence: MemoryEvidence;
  basis: string;
  // 生命周期
  lifecycle: MemoryLifecycle;
  /** 覆盖链：本条目取代的 entry_id。 */
  supersedes: string | null;
  // 时间
  createdAt: number;
  updatedAt: number;
  /** 激活时间戳：写入直落 active 即记录（无确认环节）；
 * 开库迁移的旧 candidate 行无此值（null），其后 update 的新条目必非空。 */
  confirmedAt: number | null;
  /**
 * OFK 文档指针：bundle 相对路径（/memory/<entryId>.md 形态）。
 * 长内容（> MEMORY_SPLIT_THRESHOLD_BYTES）拆分子段 + 指针；仅改指针走就地
 * UPDATE 不产 supersedes。不入内容哈希（contentId 白名单不含此字段）。
 */
  ofkRef: string | null;
}
