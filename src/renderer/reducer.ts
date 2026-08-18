import type { AgentEvent, SessionStatus } from '../shared/agent-events';
import type { MemoryEvidence, MemoryKind } from '../shared/memory-schema';

/** 会话内记忆只读通知条上限:超出仅保留最近 N 条。 */
export const MAX_RECORDED_NOTICES = 5;

/** 会话内记忆只读通知条:memory.recorded 事件 → 去重追加。 */
export interface RecordedNotice {
  entryId: string;
  title: string;
  kind: MemoryKind;
  evidence: MemoryEvidence;
}

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  events: AgentEvent[];
  /** Last consumed event id (for dedup). */
  lastEventId?: string;
  /** True when a tool.blocked safety event arrived. */
  hasBlockedTool?: boolean;
  /** Latest inline error message (if any). */
  inlineError?: string;
  /** 挂起的工具审批:approval-requested 设置,resolved 清除。 */
  pendingApproval?: { approvalId: string; toolName: string; target: string; reason: string };
  /** 会话内记忆只读通知(1.6):memory.recorded 事件去重追加,自动消退时移除。 */
  recordedNotices?: RecordedNotice[];
  /**
   * thinking 流时间锚点:messageId → 该流首个 thinking.partial 的 ts。
   * events 数组对同 messageId 只保留 final(流式折叠),首个 partial 的 ts 在折叠中
   * 丢失——组时间聚合与思考耗时依赖它,故在折叠点抢救保留。
   */
  thinkingFirstTs?: Record<string, number>;
}

export interface ReducerState {
  /** By sessionId. */
  sessions: Record<string, SessionState>;
  /** Currently visible session id (renderer chooses; reducer doesn't switch). */
  activeSessionId: string | null;
}

export type ReducerAction =
  | { type: 'event-received'; event: AgentEvent }
  | { type: 'subscribe-session'; sessionId: string }
  | {
      type: 'set-inline-error';
      sessionId: string;
      message: string | undefined;
    }
  /** 乐观清除审批模态(点击允许/拒绝后立即收起,事件到达时幂等)。 */
  | { type: 'approval-resolved'; sessionId: string; approvalId: string }
  /** 移除会话内记忆只读通知(自动消退/下一事件覆盖后收起)。 */
  | { type: 'memory-notice-dismissed'; sessionId: string; entryId: string };

export function initialReducerState(): ReducerState {
  return { sessions: {}, activeSessionId: null };
}

function bySeq(a: AgentEvent, b: AgentEvent): number {
  return a.seq - b.seq;
}

/**
 * Dedup slot for message/thinking streams. A message event and its correlated
 * thinking event share the same messageId but must COEXIST, so the key scopes
 * by stream kind before messageId.
 */
function correlationKey(event: AgentEvent): string | undefined {
  if (event.type === 'message.partial' || event.type === 'message.final') {
    // Guard undefined messageId: no dedup slot, plain append (legacy batch shape).
    return event.messageId ? `message:${event.messageId}` : undefined;
  }
  if (event.type === 'thinking.partial' || event.type === 'thinking.final') {
    // 分段思考:同 messageId 不同 segmentIndex 的块必须共存(块边界保真),
    // 折叠槽按 messageId + 段序号隔离;旧事件无 segmentIndex → 统一归段 0。
    return event.messageId ? `thinking:${event.messageId}:${event.segmentIndex ?? 0}` : undefined;
  }
  if (event.type === 'tool.start' || event.type === 'tool.end' || event.type === 'tool.blocked') {
    // 工具事件按 callId + 类型折叠:重复打开会话时同批历史以全新 eventId
    // 重放,不折叠会残留旧 tool 事件(seq 更小排在前,跨回合产生孤立工具行)。
    // start/end/blocked 不同 type 共存(callId 生命周期内各一),update 不入
    // 折叠(delta 语义为覆盖快照,但保留流式中间态更稳)。
    return event.callId ? `tool:${event.callId}:${event.type}` : undefined;
  }
  return undefined;
}

function isFinal(event: AgentEvent): boolean {
  return event.type === 'message.final' || event.type === 'thinking.final';
}

function isPartial(event: AgentEvent): boolean {
  return event.type === 'message.partial' || event.type === 'thinking.partial';
}

function upsertEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  const key = correlationKey(event);
  if (key) {
    const index = events.findIndex((existing) => correlationKey(existing) === key);
    if (index !== -1) {
      const existing = events[index];
      // A final must never be regressed by a later-arriving partial.
      if (isFinal(existing) && isPartial(event)) return events;
      // Same-type dedup: keep the newest seq.
      if (
        (isFinal(existing) && isFinal(event) && event.seq < existing.seq) ||
        (isPartial(existing) && isPartial(event) && event.seq < existing.seq)
      ) {
        return events;
      }
      const next = [...events];
      next[index] = event;
      return next.sort(bySeq);
    }
  }
  return [...events, event].sort(bySeq);
}

export function reducer(state: ReducerState, action: ReducerAction): ReducerState {
  switch (action.type) {
    case 'event-received': {
      const ev = action.event;
      const sid = ev.sessionId;
      const existing: SessionState = state.sessions[sid] ?? {
        sessionId: sid,
        status: 'idle',
        events: [],
      };
      // Out-of-session events: buffer but don't mutate visible state.
      if (state.activeSessionId !== null && state.activeSessionId !== sid) {
        const sorted = upsertEvent(existing.events, ev);
        return {
          ...state,
          sessions: { ...state.sessions, [sid]: { ...existing, events: sorted } },
        };
      }
      // Dedup by eventId.
      if (existing.events.some((e) => e.eventId === ev.eventId)) {
        return state;
      }
      const events = upsertEvent(existing.events, ev);
      const next: SessionState = {
        ...existing,
        events,
        lastEventId: ev.eventId,
      };
      if (ev.type === 'session.status') next.status = ev.status;
      if (ev.type === 'tool.blocked') next.hasBlockedTool = true;
      if (ev.type === 'thinking.partial' && ev.messageId && Number.isFinite(ev.ts)) {
        // 时间锚点:记录该段首个 partial 的 ts(后续 partial/final 不覆盖,
        // 乱序更早的 partial 取 min——ts 单调是常态,min 仅为防御)。
        // 键按 messageId + 段序号隔离,分段思考各段独立计时。
        const anchor = next.thinkingFirstTs ?? {};
        const key = `${ev.messageId}:${ev.segmentIndex ?? 0}`;
        const existingTs = anchor[key];
        next.thinkingFirstTs =
          existingTs === undefined || ev.ts < existingTs ? { ...anchor, [key]: ev.ts } : anchor;
      }
      if (ev.type === 'session.error') {
        next.inlineError = `${ev.code}: ${ev.message}`;
      }
      if (ev.type === 'tool.approval-requested') {
        // 覆盖设置:同一时间只展示一个审批模态(新请求取代旧请求)。
        next.pendingApproval = {
          approvalId: ev.approvalId,
          toolName: ev.toolName,
          target: ev.target,
          reason: ev.reason,
        };
      }
      if (ev.type === 'approval.resolved' && next.pendingApproval?.approvalId === ev.approvalId) {
        next.pendingApproval = undefined;
      }
      if (ev.type === 'memory.recorded') {
        // 去重追加:同一 entryId 只保留一条通知(重复 emit 幂等);
        // 超上限仅保留最近 N 条。
        const notice: RecordedNotice = {
          entryId: ev.entryId,
          title: ev.title,
          kind: ev.kind,
          evidence: ev.evidence,
        };
        const pending = next.recordedNotices ?? [];
        if (!pending.some((n) => n.entryId === notice.entryId)) {
          next.recordedNotices = [...pending, notice].slice(-MAX_RECORDED_NOTICES);
        }
      }
      return { ...state, sessions: { ...state.sessions, [sid]: next } };
    }
    case 'subscribe-session': {
      const existing = state.sessions[action.sessionId];
      const nextSessions = existing
        ? state.sessions
        : {
            ...state.sessions,
            [action.sessionId]: {
              sessionId: action.sessionId,
              status: 'idle' as SessionStatus,
              events: [],
            },
          };
      return { ...state, activeSessionId: action.sessionId, sessions: nextSessions };
    }
    case 'set-inline-error': {
      const s = state.sessions[action.sessionId];
      if (!s) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.sessionId]: { ...s, inlineError: action.message },
        },
      };
    }
    case 'approval-resolved': {
      const s = state.sessions[action.sessionId];
      if (!s?.pendingApproval || s.pendingApproval.approvalId !== action.approvalId) {
        return state;
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.sessionId]: { ...s, pendingApproval: undefined },
        },
      };
    }
    case 'memory-notice-dismissed': {
      const s = state.sessions[action.sessionId];
      const notices = s?.recordedNotices;
      if (!notices?.some((n) => n.entryId === action.entryId)) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.sessionId]: {
            ...s,
            recordedNotices: notices.filter((n) => n.entryId !== action.entryId),
          },
        },
      };
    }
    default:
      return state;
  }
}
