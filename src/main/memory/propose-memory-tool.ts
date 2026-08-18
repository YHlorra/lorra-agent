import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_EVIDENCE_LABELS,
  MEMORY_EVIDENCE_ORDER,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  MEMORY_RECALL_TOP_K,
  type MemoryEntry,
  type MemoryEvidence,
  type MemoryKind,
  type MemoryScope,
  type MemorySource,
} from '../../shared/memory-schema';
import { isValidOfkRef } from '../../shared/ofk-schema';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
// 类型级引用（esbuild 剔除 type import, 不把 node:sqlite 拉进 vitest client
// 测试图）。UpdatePatch 由 StoreContract 在 memory-store.ts 定稿（D1 update 语义）。
import type { UpdatePatch } from './memory-store';

/**
 * memory 工具（/ design D3, agent 自维护的双手）:
 * 候选确认闸门已拆除, agent 自主维护记忆, 用户只在浮出触点
 * （召回注入/引用/记忆页）顺口纠正。单工具四操作:
 * - propose: 参数同旧 propose_memory（kind/title/content/scope/workspace?/
 * evidence/basis）→ 直落 active（confirmedAt=now）, 返回
 * 「已记住：<title>（证据：<label>）」+ emit memory.recorded
 * - update: {entryId, title?, content?, basis?} → store.update 就地更新
 * （supersedes 链, 新条目取代原条目）, 返回新 entry_id + emit memory.recorded
 * - retire: {entryId} → 撤销（active→retired）, 返回确认文本
 * - search: {query, scope?, k?} → 命中条目文本（含 evidence 标注）, 供引用/自查
 *
 * 工具侧一律文本返回、不抛异常:
 * - 参数非法/超限 → 结构化拒绝文本（携带 LorraError code）
 * - store 错误/不可用 → 错误文本
 * - 成功 → 对应操作的成功文本 + emitRecorded 回调（propose/update）
 * 校验不变（2KB 上限拒原文 / 枚举 / workspace 组合）;「被拒不重复提议」语义随
 * 闸门删除（D1 不再有 rejected 状态）。
 */

export const MEMORY_TOOL_NAME = 'memory';

/** 工具定义类型:消费者（测试/注册处）引用命名类型而非 ReturnType。 */
export type MemoryTool = ToolDefinition<typeof memoryToolSchema>;

/** 工具侧所需 store 方法面（D3 四操作 + audit;结构化类型,不依赖 MemoryStore 全类）。 */
export interface MemoryToolStore {
  propose(input: MemoryProposeInput): Result<MemoryEntry>;
  update(entryId: string, patch: UpdatePatch): Result<MemoryEntry>;
  retire(entryId: string): Result<MemoryEntry>;
  search(input: MemorySearchInput): Result<MemoryEntry[]>;
  listActive(kind?: MemoryKind): Result<MemoryEntry[]>;
}

/** propose 入参（producer/source 由 execute 补全;字段面 = store ProposeInput）。 */
export interface MemoryProposeInput {
  kind: MemoryKind;
  title: string;
  content: string;
  producer: string;
  source: MemorySource;
  scope: MemoryScope;
  workspace: string | null;
  evidence: MemoryEvidence;
  basis: string;
  /** 标准化标签（可选；空数组 = 无标签）。 */
  tags?: string[];
  /** OFK 文档指针（可选）：长内容拆分子段 + 指针。 */
  ofkRef?: string | null;
}

export interface MemorySearchInput {
  query: string;
  scope?: MemoryScope;
  /** scope 为 workspace/project 时按此匹配（缺省 null → 仅 user/agent 级命中）。 */
  workspace?: string | null;
}

/**
 * 记忆写入成功事件载荷（D3/D6）:entryId/title/kind/evidence + sessionId。
 * 形状 = RendererAutonomy 在 agent-events.ts 定稿的 MemoryRecordedEvent
 * （EventEnvelope 之外字段一致）。类型未落地前以本字面量承载,
 * 落地后替换为 agent-events 派生 payload 类型（本任务只 import 使用, 不定义事件）。
 */
export interface MemoryRecordedPayload {
  entryId: string;
  title: string;
  kind: MemoryKind;
  evidence: MemoryEvidence;
  sessionId: string;
}

export interface MemoryToolDeps {
  /**
   * 共享 MemoryStore 单例（调用时惰性解析）。
   * 允许返回 Promise: 注册处经动态 import 装载共享单例（node:sqlite 不进
   * vitest client 测试图, 与 shared-facts-store 同款纪律）。
   */
  getStore: () => MemoryToolStore | Promise<MemoryToolStore>;
  /**
   * 成功写入（propose/update）后的事件回调。entryId/title/kind/evidence 由本
   * 工具从落盘条目填写; sessionId 由注册处闭包注入（工具执行时会话已创建）。
   */
  emitRecorded?: (payload: MemoryRecordedPayload) => void;
  /** 当前 agent 标识（MemoryEntry.producer）。缺省 'pi-sdk'。 */
  getProducer?: () => string;
  /** 当前会话 id 解析（注册处闭包捕获）。缺省空串。 */
  sessionId?: () => string;
  /** 当前工作区路径（search scope 过滤用）。缺省 null。 */
  getWorkspace?: () => string | null;
}

const memoryToolSchema = Type.Object({
  op: Type.Union([
    Type.Literal('propose'),
    Type.Literal('update'),
    Type.Literal('retire'),
    Type.Literal('search'),
    Type.Literal('audit'),
  ]),
  // ---- propose ----
  kind: Type.Optional(
    Type.Union([
      Type.Literal('hard_policy'),
      Type.Literal('soft_preference'),
      Type.Literal('procedural_experience'),
      Type.Literal('run_bound_feedback'),
      Type.Literal('working_context'),
      Type.Literal('knowledge'),
      Type.Literal('user_profile'),
      Type.Literal('event'),
    ]),
  ),
  title: Type.Optional(Type.String({ minLength: 1 })),
  content: Type.Optional(Type.String({ minLength: 1 })),
  scope: Type.Optional(
    Type.Union([
      Type.Literal('user'),
      Type.Literal('workspace'),
      Type.Literal('project'),
      Type.Literal('agent'),
    ]),
  ),
  /** scope 为 workspace/project 时必填（execute 内组合校验）。 */
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  evidence: Type.Optional(
    Type.Union([
      Type.Literal('user-stated'),
      Type.Literal('extracted'),
      Type.Literal('inferred'),
      Type.Literal('unverified'),
    ]),
  ),
  basis: Type.Optional(Type.String({ minLength: 1 })),
  /** 标准化标签（运行规定类 + 项目类型类；≤5 个，单个 ≤24 字符）。 */
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 24 }), { maxItems: 5 })),
  // ---- update / retire ----
  entryId: Type.Optional(Type.String({ minLength: 1 })),
  // ---- propose / update ----
  /** OFK 文档指针：bundle 相对路径（/memory/<entryId>.md 形态）。 */
  ofkRef: Type.Optional(Type.String({ pattern: '^/[A-Za-z0-9._/-]{1,200}$' })),
  // ---- search ----
  query: Type.Optional(Type.String()),
  /** 返回条数上限（1..50, 缺省 MEMORY_RECALL_TOP_K）。 */
  k: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const SCOPE_VALUES: readonly MemoryScope[] = ['user', 'workspace', 'project', 'agent'];
const DEFAULT_PRODUCER = 'pi-sdk';
const SEARCH_K_MAX = 50;

/** execute 的规范化 propose 入参（producer/source 由 execute 补全）。 */
type ValidatedPropose = Omit<MemoryProposeInput, 'producer' | 'source'>;

/**
 * propose 结构参数校验（schema 之外的运行期硬校验, 双保险）:
 * - kind/evidence/scope 枚举外值 → invalid-args
 * - content utf8 字节 > 2048 → content-too-long（上限拒原文）
 * - scope 为 workspace/project 时必须带非空 workspace; user/agent 级
 * 携带的 workspace 归一为 null（user 级跨工作区, 不绑定工作区）
 */
function validateProposeArgs(raw: Record<string, unknown>): Result<ValidatedPropose> {
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) {
    return err({ code: 'invalid-args', message: `kind 非法: ${String(kind)}` });
  }
  const evidence = raw.evidence;
  if (
    typeof evidence !== 'string' ||
    !(MEMORY_EVIDENCE_ORDER as readonly string[]).includes(evidence)
  ) {
    return err({ code: 'invalid-args', message: `evidence 非法: ${String(evidence)}` });
  }
  const scope = raw.scope;
  if (typeof scope !== 'string' || !SCOPE_VALUES.includes(scope as MemoryScope)) {
    return err({ code: 'invalid-args', message: `scope 非法: ${String(scope)}` });
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    return err({ code: 'invalid-args', message: 'title 不能为空' });
  }
  if (typeof raw.content !== 'string' || raw.content.length === 0) {
    return err({ code: 'invalid-args', message: 'content 不能为空' });
  }
  const contentBytes = Buffer.byteLength(raw.content, 'utf8');
  if (contentBytes > MEMORY_CONTENT_MAX_BYTES) {
    return err({
      code: 'content-too-long',
      message: `content ${contentBytes} 字节超过 ${MEMORY_CONTENT_MAX_BYTES} 字节上限`,
    });
  }
  if (typeof raw.basis !== 'string' || raw.basis.trim() === '') {
    return err({ code: 'invalid-args', message: 'basis 不能为空' });
  }
  const workspace = typeof raw.workspace === 'string' ? raw.workspace.trim() : '';
  if ((scope === 'workspace' || scope === 'project') && workspace === '') {
    return err({ code: 'invalid-args', message: `scope=${scope} 时必须提供 workspace` });
  }
  if (raw.ofkRef !== undefined && !isValidOfkRef(raw.ofkRef)) {
    return err({
      code: 'invalid-args',
      message: 'ofkRef 须为 bundle 相对路径（/memory/<entryId>.md 形态）',
    });
  }
  // tags 运行期双保险:数组、字符串、≤5 个、单个 ≤24 字符。
  let tags: string[] | undefined;
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.length > 5) {
      return err({ code: 'invalid-args', message: 'tags 必须是不超过 5 个标签的数组' });
    }
    const cleaned: string[] = [];
    for (const t of raw.tags) {
      if (typeof t !== 'string' || t.trim().length === 0 || t.trim().length > 24) {
        return err({ code: 'invalid-args', message: 'tags 元素必须是 1-24 字符的字符串' });
      }
      cleaned.push(t.trim());
    }
    tags = cleaned;
  }
  return ok({
    kind: kind as MemoryKind,
    title: raw.title,
    content: raw.content,
    scope: scope as MemoryScope,
    workspace: scope === 'user' || scope === 'agent' ? null : workspace,
    evidence: evidence as MemoryEvidence,
    basis: raw.basis,
    tags,
    ...(raw.ofkRef !== undefined ? { ofkRef: raw.ofkRef } : {}),
  });
}

/** update 补丁字段校验:提供的字段必须非空;content 需 ≤ 2048 字节。 */
function validateUpdatePatch(raw: Record<string, unknown>): Result<UpdatePatch> {
  const patch: UpdatePatch = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || raw.title.trim() === '') {
      return err({ code: 'invalid-args', message: 'title 不能为空' });
    }
    patch.title = raw.title;
  }
  if (raw.content !== undefined) {
    if (typeof raw.content !== 'string' || raw.content.length === 0) {
      return err({ code: 'invalid-args', message: 'content 不能为空' });
    }
    const contentBytes = Buffer.byteLength(raw.content, 'utf8');
    if (contentBytes > MEMORY_CONTENT_MAX_BYTES) {
      return err({
        code: 'content-too-long',
        message: `content ${contentBytes} 字节超过 ${MEMORY_CONTENT_MAX_BYTES} 字节上限`,
      });
    }
    patch.content = raw.content;
  }
  if (raw.ofkRef !== undefined) {
    if (!isValidOfkRef(raw.ofkRef)) {
      return err({
        code: 'invalid-args',
        message: 'ofkRef 须为 bundle 相对路径（/memory/<entryId>.md 形态）',
      });
    }
    patch.ofkRef = raw.ofkRef;
  }
  if (raw.basis !== undefined) {
    if (typeof raw.basis !== 'string' || raw.basis.trim() === '') {
      return err({ code: 'invalid-args', message: 'basis 不能为空' });
    }
    patch.basis = raw.basis;
  }
  if (Object.keys(patch).length === 0) {
    return err({
      code: 'invalid-args',
      message: 'update 至少提供 title/content/basis/ofkRef 之一',
    });
  }
  return ok(patch);
}

/** 非空 entryId 提取（update/retire 共用）。 */
function extractEntryId(raw: Record<string, unknown>): Result<string> {
  if (typeof raw.entryId !== 'string' || raw.entryId.trim() === '') {
    return err({ code: 'invalid-args', message: '必须提供 entryId' });
  }
  return ok(raw.entryId.trim());
}

export function createMemoryTool(deps: MemoryToolDeps): MemoryTool {
  return {
    name: MEMORY_TOOL_NAME,
    label: '记忆维护',
    description:
      '记忆维护工具（memory）：propose 记一条新记忆（直落生效）/ update 就地更新已有记忆（supersedes 链）/ retire 撤销过时记忆 / search 检索已记住内容（含证据标注）/ audit 周期性自查（矛盾/陈旧/孤儿页，lint）。',
    promptSnippet:
      '记忆维护（memory）：propose 记住用户规则/偏好/经验/结论, update 就地更新已有记忆, retire 撤销过时记忆, search 检索已记住内容, audit 自查记忆健康度',
    promptGuidelines: [
      'propose: 用户明示规则/偏好/决定、会话中自然产生的经验教训与任务结论 → 直落生效; 一次性任务细节、原始对话全文不要记',
      'content 为 markdown 页面形态, 上限 2048 字节; 超限会被结构化拒绝',
      'scope: 用户说「以后都这样」→ user; 工作区/项目相关 → workspace/project（必须提供 workspace）; 仅当前 agent 会话相关 → agent',
      'evidence: 用户亲口说的 → user-stated; 从行为/材料观察提取 → extracted; 推断 → inferred; 未经核实 → unverified',
      'update: 记忆内容变化（用户纠正/事实更新）→ 就地更新原条目, 不要新增重复条目; retire: 过期/被否的记忆撤销',
      'search: 引用记忆前先检索, 检索结果自带 evidence 标注（你明说的/观察/agent 推断/未验证）',
      'audit: 周期性自查（如复盘时顺带）——同主题重复条目→update 收敛, 陈旧条目→update/retire, 孤儿页→评估合并或 retire; 发现「被反复提到但无记忆」的概念→propose 补记',
      '长内容（>1024 字节）建议用 knowledge 工具写 OFK 文档, memory 记摘要 + ofkRef 指针（propose/update 可带 ofkRef）',
    ],
    parameters: memoryToolSchema,
    executionMode: 'parallel',
    async execute(_toolCallId, params) {
      const raw = params as unknown as Record<string, unknown>;
      const op = raw.op;
      if (op === 'propose') return runPropose(deps, raw);
      if (op === 'update') return runUpdate(deps, raw);
      if (op === 'retire') return runRetire(deps, raw);
      if (op === 'search') return runSearch(deps, raw);
      if (op === 'audit') return runAudit(deps);
      return toolText(
        `记忆操作被拒绝（invalid-args）：op 必须是 propose/update/retire/search/audit 之一`,
      );
    },
  };
}

async function runPropose(deps: MemoryToolDeps, raw: Record<string, unknown>) {
  const validated = validateProposeArgs(raw);
  if (validated.isErr()) {
    return toolText(`记忆操作被拒绝（${validated.error.code}）：${validated.error.message}`);
  }
  const input: MemoryProposeInput = {
    ...validated.value,
    producer: deps.getProducer?.() ?? DEFAULT_PRODUCER,
    source: 'agent-proposal',
  };
  let result: Result<MemoryEntry>;
  try {
    const store = await deps.getStore();
    result = store.propose(input);
  } catch (cause) {
    // store 不可用/抛错: 工具侧文本返回, 不抛异常
    return toolText(`记忆操作失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (result.isErr()) {
    return toolText(`记忆操作失败（${result.error.code}）：${result.error.message}`);
  }
  const entry = result.value;
  deps.emitRecorded?.({
    entryId: entry.entryId,
    title: entry.title,
    kind: entry.kind,
    evidence: entry.evidence,
    sessionId: deps.sessionId?.() ?? '',
  });
  return toolText(`已记住：${entry.title}（证据：${MEMORY_EVIDENCE_LABELS[entry.evidence]}）`);
}

async function runUpdate(deps: MemoryToolDeps, raw: Record<string, unknown>) {
  const entryId = extractEntryId(raw);
  if (entryId.isErr()) {
    return toolText(`记忆操作被拒绝（${entryId.error.code}）：${entryId.error.message}`);
  }
  const patch = validateUpdatePatch(raw);
  if (patch.isErr()) {
    return toolText(`记忆操作被拒绝（${patch.error.code}）：${patch.error.message}`);
  }
  let result: Result<MemoryEntry>;
  try {
    const store = await deps.getStore();
    result = store.update(entryId.value, patch.value);
  } catch (cause) {
    return toolText(`记忆操作失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (result.isErr()) {
    return toolText(`记忆操作失败（${result.error.code}）：${result.error.message}`);
  }
  const entry = result.value;
  deps.emitRecorded?.({
    entryId: entry.entryId,
    title: entry.title,
    kind: entry.kind,
    evidence: entry.evidence,
    sessionId: deps.sessionId?.() ?? '',
  });
  return toolText(
    `已更新记忆：${entry.title}（新 entry_id=${entry.entryId}，证据：${MEMORY_EVIDENCE_LABELS[entry.evidence]}）`,
  );
}

async function runRetire(deps: MemoryToolDeps, raw: Record<string, unknown>) {
  const entryId = extractEntryId(raw);
  if (entryId.isErr()) {
    return toolText(`记忆操作被拒绝（${entryId.error.code}）：${entryId.error.message}`);
  }
  let result: Result<MemoryEntry>;
  try {
    const store = await deps.getStore();
    result = store.retire(entryId.value);
  } catch (cause) {
    return toolText(`记忆操作失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (result.isErr()) {
    return toolText(`记忆操作失败（${result.error.code}）：${result.error.message}`);
  }
  return toolText(`已撤销记忆：${result.value.title}`);
}

async function runSearch(deps: MemoryToolDeps, raw: Record<string, unknown>) {
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (query === '') {
    return toolText(`记忆操作被拒绝（invalid-args）：search 必须提供 query`);
  }
  let scope: MemoryScope | undefined;
  if (raw.scope !== undefined) {
    if (typeof raw.scope !== 'string' || !SCOPE_VALUES.includes(raw.scope as MemoryScope)) {
      return toolText(`记忆操作被拒绝（invalid-args）：scope 非法: ${String(raw.scope)}`);
    }
    scope = raw.scope as MemoryScope;
  }
  let k = MEMORY_RECALL_TOP_K;
  if (raw.k !== undefined) {
    if (
      typeof raw.k !== 'number' ||
      !Number.isInteger(raw.k) ||
      raw.k < 1 ||
      raw.k > SEARCH_K_MAX
    ) {
      return toolText(`记忆操作被拒绝（invalid-args）：k 必须是 1..${SEARCH_K_MAX} 的整数`);
    }
    k = raw.k;
  }
  let result: Result<MemoryEntry[]>;
  try {
    const store = await deps.getStore();
    result = store.search({
      query,
      scope,
      workspace: deps.getWorkspace?.() ?? null,
    });
  } catch (cause) {
    return toolText(`记忆操作失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (result.isErr()) {
    return toolText(`记忆操作失败（${result.error.code}）：${result.error.message}`);
  }
  const entries = result.value.slice(0, k);
  if (entries.length === 0) {
    return toolText('未找到匹配的记忆条目');
  }
  const lines = entries.map(
    (e, i) =>
      `[${i + 1}] ${e.title}（${MEMORY_KIND_LABELS[e.kind]}，证据：${MEMORY_EVIDENCE_LABELS[e.evidence]}，entry_id=${e.entryId}）\n${e.content}`,
  );
  return toolText(`命中 ${entries.length} 条：\n${lines.join('\n\n')}`);
}

function toolText(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: {},
  };
}

// ---------------------------------------------------------------------------
// lint:audit op —— 周期性自查(矛盾/陈旧/孤儿页),agent 依结果
// update/retire/propose。全部确定性规则,不依赖模型。
// ---------------------------------------------------------------------------

/** audit 陈旧阈值(天):生效条目最后更新早于此时限 → 陈旧候选。 */
export const AUDIT_STALE_DAYS = 90;

/** [[链接]] 目标提取(backlink 检测用;主进程侧不引 renderer lib)。 */
const WIKILINK_TARGET_RE = /\[\[([^[\]]+)\]\]/g;

async function runAudit(deps: MemoryToolDeps) {
  let store: MemoryToolStore;
  try {
    store = await deps.getStore();
  } catch (cause) {
    return toolText(`记忆操作失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const active = store.listActive();
  if (active.isErr()) {
    return toolText(`记忆自查失败（${active.error.code}）：${active.error.message}`);
  }
  const entries = active.value;
  if (entries.length === 0) return toolText('记忆自查：库为空，无需处理。');

  const normTitle = (s: string): string => s.trim().replace(/\s+/g, '');
  const findings: string[] = [];

  // 1. 矛盾候选:规范化标题重复的生效条目(同一主题多版本并存 → 收敛)。
  const byTitle = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const key = normTitle(e.title);
    if (key.length < 2) continue;
    const group = byTitle.get(key) ?? [];
    group.push(e);
    byTitle.set(key, group);
  }
  for (const group of byTitle.values()) {
    if (group.length > 1) {
      const ids = group.map((g) => g.entryId.slice(0, 8)).join('/');
      findings.push(
        `[重复主题] 「${group[0].title}」有 ${group.length} 条生效条目（${ids}）→ 用 update 收敛为一条`,
      );
    }
  }

  // 2. 陈旧:updatedAt 早于阈值。
  const staleCutoff = Date.now() - AUDIT_STALE_DAYS * 24 * 60 * 60 * 1000;
  for (const e of entries) {
    if (e.updatedAt >= staleCutoff) continue;
    const days = Math.floor((Date.now() - e.updatedAt) / 86_400_000);
    findings.push(`[陈旧] 「${e.title}」${days} 天未更新 → 核对内容, update 或 retire`);
  }

  // 3. 孤儿页(knowledge):无任何生效条目以 [[标题]] 引用(标题规范化包含匹配)。
  const referenced = new Set<string>();
  for (const e of entries) {
    const text = `${e.title}\n${e.content}`;
    for (const m of text.matchAll(WIKILINK_TARGET_RE)) {
      const t = m[1].trim();
      if (t) referenced.add(t);
    }
  }
  for (const e of entries) {
    if (e.kind !== 'knowledge') continue;
    const norm = normTitle(e.title);
    const linked = [...referenced].some(
      (r) => normTitle(r) === norm || (norm.length >= 2 && normTitle(r).includes(norm)),
    );
    if (!linked) {
      findings.push(`[孤儿页] 「${e.title}」无任何页面引用 → 评估合并到相关主题或 retire`);
    }
  }

  if (findings.length === 0) return toolText('记忆自查：未发现矛盾/陈旧/孤儿页，记忆健康。');
  return toolText(`记忆自查发现 ${findings.length} 项：\n${findings.join('\n')}`);
}
