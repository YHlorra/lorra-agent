import type { AgentEvent } from '../../shared/agent-events';
import type { PlanStep } from '../plan-card';

/**
 * 事件流 → 行模型(平铺转录流 + 回合标记)。纯函数,无 React 依赖,可单测。
 *
 * 设计(pi-gui 范式):一次 assistant 回复 = 思考段/工具调用/文本按事件到达
 * 顺序交替的连续流,每类事件独立成行,不分组、不重排:
 * - message/error → 独立行(按事件序)
 * - thinking.* → 按 messageId+segmentIndex 合并的思考段行(位置 = 段首现处)
 * - tool.* → 按 callId 合并的工具行(位置 = start 首现处)
 * - turn-marker → 每轮 user 消息之后插「工作 N分N秒」双线分隔标记
 * session.* 跳过。
 *
 * 回合边界:一轮 = 从 user 消息开始到下一个 user 消息(或流尾)。回合耗时 =
 * 该轮内所有事件 ts 的最大值 - user 消息 ts;满足 MIN_WORKED_DURATION_MS
 * 才插 marker(时长从不虚构,pi-gui timeline-turns.ts 同规则)。user 消息行
 * 与其 marker 在回合结束时(下一个 user 消息或流尾)统一落行,保证 marker
 * 紧跟 user 行、位于该轮工作行之前(Codex 式:marker 坐在 prompt 之后)。
 */

export interface ThinkingRow {
  messageId: string;
  /** 思考段序号(消息内容块数组中的位置);缺省 = 单段。 */
  segmentIndex?: number;
  thinking: string;
  running: boolean;
  redacted?: boolean;
  /** 该条思考 final 与首个 partial 的时间差;无有效时间信息时为 undefined。 */
  durationMs?: number;
}

export interface ToolRow {
  /** 关联 key:callId 优先,无 callId 时用事件自身的 eventId。 */
  key: string;
  toolName: string;
  target: string;
  status: 'running' | 'ok' | 'error' | 'blocked';
  args?: unknown;
  result?: string;
  delta?: string;
  safetyNote?: string;
  /** update_plan 载荷;null = 命中但无计划,undefined = 非计划工具。 */
  plan?: { plan: PlanStep[]; explanation?: string; running: boolean } | null;
}

export type ChatRowModel =
  | {
      kind: 'message';
      key: string;
      event: Extract<AgentEvent, { type: 'message.partial' | 'message.final' }>;
    }
  | { kind: 'error'; key: string; event: Extract<AgentEvent, { type: 'message.error' }> }
  | { kind: 'thinking'; key: string; row: ThinkingRow }
  | { kind: 'tool'; key: string; row: ToolRow }
  | { kind: 'turn-marker'; key: string; durationMs: number };

/** 最短「实际工作」时长:不足 1 秒的回合不插标记(pi-gui 同值)。 */
const MIN_WORKED_DURATION_MS = 1_000;

/**
 * Extracts an `update_plan` payload from a tool event's raw args. Returns
 * null when the tool is not update_plan or the args are malformed — callers
 * then fall back to the generic ToolCard (defensive against SDK arg shape
 * changes).
 */
export function parsePlanArgs(
  event: Extract<AgentEvent, { type: 'tool.start' | 'tool.end' }>,
): { plan: Array<{ step: string; status: string }>; explanation?: string } | null {
  if (event.toolName !== 'update_plan') return null;
  const args = event.args;
  if (typeof args !== 'object' || args === null) return null;
  const record = args as Record<string, unknown>;
  if (!Array.isArray(record.plan)) return null;
  const plan: Array<{ step: string; status: string }> = [];
  for (const item of record.plan) {
    if (typeof item !== 'object' || item === null) return null;
    const step = (item as Record<string, unknown>).step;
    const status = (item as Record<string, unknown>).status;
    if (typeof step !== 'string' || typeof status !== 'string') return null;
    plan.push({ step, status });
  }
  if (plan.length === 0) return null;
  const explanation = typeof record.explanation === 'string' ? record.explanation : undefined;
  return { plan, explanation };
}

function isMessageEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'message.partial' | 'message.final' }> {
  return event.type === 'message.partial' || event.type === 'message.final';
}

function isThinkingEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'thinking.partial' | 'thinking.final' }> {
  return event.type === 'thinking.partial' || event.type === 'thinking.final';
}

function isToolEvent(
  event: AgentEvent,
): event is Extract<
  AgentEvent,
  { type: 'tool.start' | 'tool.update' | 'tool.end' | 'tool.blocked' }
> {
  return (
    event.type === 'tool.start' ||
    event.type === 'tool.update' ||
    event.type === 'tool.end' ||
    event.type === 'tool.blocked'
  );
}

/**
 * 事件流 → 行模型(平铺转录流 + 回合标记)。纯函数,无 React 依赖,可单测。
 *
 * 回合缓冲:user 消息行 + 该轮工作行先入 turnRows 缓冲,回合结束时
 * (下一个 user 消息或流尾)按 [user 行, marker?, 工作行...] 顺序落行。
 * marker 的耗时只有回合结束才能算出,缓冲保证它紧跟 user 行——直接平推
 * 无法把 marker 插到已落行的工作行之前。无 user 消息的事件流(测试直传、
 * 会话续接)退化为普通平铺流,仅缓冲不插 marker。
 */
export function groupChatEvents(
  events: AgentEvent[],
  thinkingFirstTs?: Readonly<Record<string, number>>,
): ChatRowModel[] {
  const rows: ChatRowModel[] = [];
  // 当前回合的缓冲行(user 行在 pending 里,marker 在 flush 时合成)。
  let turnRows: ChatRowModel[] = [];
  // 进行中的回合:user 消息 + 该轮耗时窗口。startTs/endTs 无有效时间时记 NaN。
  let pending: {
    event: Extract<AgentEvent, { type: 'message.partial' | 'message.final' }>;
    startTs: number;
    endTs: number;
  } | null = null;
  // 回合内进行中的行:key → 行对象(数组持有同一引用,upsert 改字段保位置)。
  const thinkingByKey = new Map<string, ThinkingRow>();
  const toolByKey = new Map<string, ToolRow>();
  // 每条思考段的首个 partial ts(纯函数局部状态,每次调用新建)。
  // 直传事件流(测试/调试)下 partial 在场,内部记录兜底;真实路径
  // events 已被 reducer 折叠(partial 被 final 替换),靠外部锚点参数。
  const localThinkingFirstTs = new Map<string, number>();

  const flushTurn = (): void => {
    if (pending) {
      rows.push({
        kind: 'message',
        key: pending.event.messageId ?? pending.event.eventId,
        event: pending.event,
      });
      if (
        Number.isFinite(pending.startTs) &&
        Number.isFinite(pending.endTs) &&
        pending.endTs - pending.startTs >= MIN_WORKED_DURATION_MS
      ) {
        rows.push({
          kind: 'turn-marker',
          key: `turn-marker:${pending.event.eventId}`,
          durationMs: pending.endTs - pending.startTs,
        });
      }
      pending = null;
    }
    for (const row of turnRows) rows.push(row);
    turnRows = [];
    thinkingByKey.clear();
    toolByKey.clear();
  };

  /** 回合内任意活动事件:推进该轮耗时窗口上界。 */
  const noteActivity = (ts: number): void => {
    if (pending && Number.isFinite(ts)) {
      pending.endTs = Math.max(pending.endTs, ts);
    }
  };

  const upsertThinking = (
    event: Extract<AgentEvent, { type: 'thinking.partial' | 'thinking.final' }>,
  ): void => {
    noteActivity(event.ts);
    const isFinal = event.type === 'thinking.final';
    const segmentIndex = event.segmentIndex ?? 0;
    const key = `${event.messageId}:${segmentIndex}`;
    let durationMs: number | undefined;
    if (isFinal) {
      // 首个 partial ts:外部锚点(reducer 折叠路径)优先,内部记录(直传路径)兜底。
      const firstTs = thinkingFirstTs?.[key] ?? localThinkingFirstTs.get(key);
      localThinkingFirstTs.delete(key);
      durationMs = Number.isFinite(event.ts) ? event.ts - (firstTs ?? event.ts) : undefined;
    } else if (Number.isFinite(event.ts)) {
      // 直传路径内部锚点:取首个(最早) partial 的 ts,与 reducer 锚点
      // (min 语义)保持一致——覆盖式 set 会让耗时退化为 final 与最后
      // partial 之差,低估真实思考时长。
      const prev = localThinkingFirstTs.get(key);
      if (prev === undefined || event.ts < prev) {
        localThinkingFirstTs.set(key, event.ts);
      }
    }
    const existing = thinkingByKey.get(key);
    if (existing) {
      existing.thinking = event.content.thinking;
      existing.running = event.type === 'thinking.partial';
      if (isFinal) {
        existing.redacted = event.thinkingRedacted;
        existing.durationMs = durationMs;
      }
      return;
    }
    const row: ThinkingRow = {
      messageId: event.messageId,
      segmentIndex,
      thinking: event.content.thinking,
      running: event.type === 'thinking.partial',
      redacted: isFinal ? event.thinkingRedacted : undefined,
      durationMs: isFinal ? durationMs : undefined,
    };
    thinkingByKey.set(key, row);
    turnRows.push({ kind: 'thinking', key, row });
  };

  const upsertTool = (
    event: Extract<
      AgentEvent,
      { type: 'tool.start' | 'tool.update' | 'tool.end' | 'tool.blocked' }
    >,
  ): void => {
    noteActivity(event.ts);
    const key = event.callId ?? event.eventId;
    const existing = toolByKey.get(key);
    // update_plan 载荷解析:tool.start/end 都可能是计划工具,命中与否都要落状态。
    // plan 字段语义:undefined = 非计划工具,null = update_plan 但 args 未命中。
    const isPlanTool = event.toolName === 'update_plan';
    const planArgs =
      event.type === 'tool.start' || event.type === 'tool.end' ? parsePlanArgs(event) : null;
    if (existing) {
      // 同 callId 流式更新:tool.update 只追加 delta,tool.end 收口状态。
      existing.toolName = event.toolName;
      existing.target = event.target;
      if ('args' in event) existing.args = event.args;
      if (event.type === 'tool.update') {
        existing.status = 'running';
        existing.delta = event.delta;
      } else if (event.type === 'tool.end') {
        existing.status = event.ok ? 'ok' : 'error';
        existing.result = event.result;
        existing.delta = undefined;
        existing.plan = planArgs
          ? { ...planArgs, running: false }
          : isPlanTool && existing.plan
            ? { ...existing.plan, running: false }
            : existing.plan;
      } else if (event.type === 'tool.start') {
        existing.plan = planArgs
          ? { ...planArgs, running: true }
          : isPlanTool
            ? null
            : existing.plan;
      } else if (event.type === 'tool.blocked') {
        existing.status = 'blocked';
        existing.safetyNote = event.safetyNote;
      }
      return;
    }
    const row: ToolRow = {
      key,
      toolName: event.toolName,
      target: event.target,
      status: 'running',
    };
    if ('args' in event) row.args = event.args;
    if (event.type === 'tool.update') {
      row.status = 'running';
      row.delta = event.delta;
    } else if (event.type === 'tool.end') {
      row.status = event.ok ? 'ok' : 'error';
      row.result = event.result;
      row.plan = planArgs ? { ...planArgs, running: false } : isPlanTool ? null : undefined;
    } else if (event.type === 'tool.start') {
      row.plan = planArgs ? { ...planArgs, running: true } : isPlanTool ? null : undefined;
    } else if (event.type === 'tool.blocked') {
      row.status = 'blocked';
      row.safetyNote = event.safetyNote;
    }
    toolByKey.set(key, row);
    turnRows.push({ kind: 'tool', key: row.key, row });
  };

  for (const event of events) {
    if (event.type === 'session.status' || event.type === 'session.error') continue;
    if (isMessageEvent(event)) {
      if (event.role === 'user' && event.type === 'message.final') {
        // 回合边界:收口上一轮(user 行 + marker 落行),开启新一轮。
        flushTurn();
        pending = {
          event,
          startTs: Number.isFinite(event.ts) ? event.ts : Number.NaN,
          endTs: Number.isFinite(event.ts) ? event.ts : Number.NaN,
        };
      } else {
        // assistant 文本(防御性兜底 user partial):直接入当前回合缓冲。
        turnRows.push({ kind: 'message', key: event.messageId ?? event.eventId, event });
        noteActivity(event.ts);
      }
      continue;
    }
    if (event.type === 'message.error') {
      turnRows.push({ kind: 'error', key: event.eventId, event });
      noteActivity(event.ts);
      continue;
    }
    if (isThinkingEvent(event)) {
      upsertThinking(event);
      continue;
    }
    if (isToolEvent(event)) {
      upsertTool(event);
    }
  }
  flushTurn();
  return rows;
}
