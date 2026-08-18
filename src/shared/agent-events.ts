import type { MemoryEvidence, MemoryKind } from './memory-schema';

/**
 * Product event contract shared between the main-process driver and the renderer.
 *
 * BREAKING change vs the legacy 11-line shape (see / spec agent-events).
 * Every event MUST carry sessionId / eventId / seq / ts so the renderer reducer
 * can isolate by sessionId and replay deterministically.
 */

export type SessionStatus = 'idle' | 'streaming' | 'tool-running' | 'aborted' | 'errored';

export interface EventEnvelope {
  sessionId: string;
  /** Unique per-event id (uuid v4 from the driver). */
  eventId: string;
  /** Monotonically increasing per sessionId, starting at 1. */
  seq: number;
  /** Epoch milliseconds when the driver emitted the event. */
  ts: number;
}

interface MessageContent {
  text: string;
}

interface ThinkingContent {
  thinking: string;
}

export type AgentEvent =
  | (EventEnvelope & {
      type: 'message.partial';
      role: 'assistant';
      /** Stable across the partial/final events for one assistant message. */
      messageId: string;
      content: MessageContent;
    })
  | (EventEnvelope & {
      type: 'message.final';
      role: 'user' | 'assistant';
      /** Stable across the partial/final events for one assistant message. */
      messageId: string;
      content: MessageContent;
    })
  | (EventEnvelope & {
      type: 'message.error';
      role: 'assistant';
      content: MessageContent;
      errorCode: string;
    })
  | (EventEnvelope & {
      type: 'thinking.partial';
      role: 'assistant';
      /** Correlates the thinking stream to the assistant message it precedes. */
      messageId: string;
      /**
       * 该思考段在消息内容块数组中的序号(0-based)。一次回复可能有多个
       * thinking 块(与工具调用交替);缺省 = 单段(历史回放/旧事件兼容)。
       */
      segmentIndex?: number;
      /** 该消息的 thinking 段总数;缺省 = 1。 */
      segmentCount?: number;
      content: ThinkingContent;
    })
  | (EventEnvelope & {
      type: 'thinking.final';
      role: 'assistant';
      /** Correlates the thinking stream to the assistant message it precedes. */
      messageId: string;
      /** 思考段序号,语义同 thinking.partial;缺省 = 单段。 */
      segmentIndex?: number;
      /** 思考段总数,语义同 thinking.partial;缺省 = 1。 */
      segmentCount?: number;
      content: ThinkingContent;
      /** True when the driver withheld raw thinking (e.g. redacted by policy). */
      thinkingRedacted?: boolean;
    })
  | (EventEnvelope & {
      type: 'tool.start';
      toolName: string;
      target: string;
      /** Optional id correlating tool events for the same call. */
      callId?: string;
      /** Raw tool-call arguments as emitted by the SDK. */
      args?: unknown;
    })
  | (EventEnvelope & {
      type: 'tool.update';
      toolName: string;
      target: string;
      callId?: string;
      delta: string;
      args?: unknown;
    })
  | (EventEnvelope & {
      type: 'tool.end';
      toolName: string;
      target: string;
      callId?: string;
      /** Public result text. Internal stacks are stripped by the driver. */
      result: string;
      /** Whether the call succeeded (`true`), was blocked (`false` via tool.blocked), or errored. */
      ok: boolean;
      args?: unknown;
    })
  | (EventEnvelope & {
      type: 'tool.blocked';
      toolName: string;
      target: string;
      callId?: string;
      /** Human-readable reason (e.g. "path-out-of-workspace", "size-exceeds-threshold"). */
      safetyNote: string;
    })
  | (EventEnvelope & {
      type: 'session.status';
      status: SessionStatus;
    })
  | (EventEnvelope & {
      /** AI 编辑被一键复原(主进程直接写盘,不走 tool.end 事件流)。 */
      type: 'edits.reverted';
      /** 被复原的编辑记录 id(= 工具调用 toolCallId)。 */
      editId: string;
      /** 被复原的文件(相对工作区路径,/ 分隔)。 */
      fileId: string;
    })
  | (EventEnvelope & {
      /** write/edit 需用户审批时由 driver 发出,携带审批 id 供审批模态消费。 */
      type: 'tool.approval-requested';
      toolName: string;
      target: string;
      reason: string;
      approvalId: string;
    })
  | (EventEnvelope & {
      /** 审批已裁决(允许/拒绝),按 approvalId 清除审批模态。 */
      type: 'approval.resolved';
      approvalId: string;
      decision: 'allowOnce' | 'allowAlways' | 'deny';
    })
  | (EventEnvelope & {
      type: 'session.error';
      code: string;
      message: string;
    })
  | MemoryRecordedEvent;

/** memory 工具成功写入(propose/update)后 emit:渲染端据 payload 渲染会话内只读通知条。 */
export interface MemoryRecordedEvent extends EventEnvelope {
  type: 'memory.recorded';
  /** 新落盘条目 id(entryIdOf 哈希)。 */
  entryId: string;
  /** 条目标题(通知条主文案)。 */
  title: string;
  /** 条目类别(六类之一,徽标展示)。 */
  kind: MemoryKind;
  /** 证据等级(四态,徽标展示)。 */
  evidence: MemoryEvidence;
  /** 会话 id(envelope 必带,payload 显式携带便于消费方单取)。 */
  sessionId: string;
}

/**
 * Type guards — useful when consuming `lorra.events` from untyped JSON. The
 * driver always emits events with the envelope populated, so reducers may also
 * narrow by `event.type` and rely on `in` checks for envelope fields.
 */
export const isAgentEvent = (value: unknown): value is AgentEvent => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    typeof v.eventId === 'string' &&
    typeof v.seq === 'number' &&
    typeof v.ts === 'number' &&
    typeof v.type === 'string'
  );
};
