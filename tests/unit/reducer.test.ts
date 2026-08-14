import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  initialReducerState,
  MAX_RECORDED_NOTICES,
  type ReducerState,
  reducer,
} from '../../src/renderer/reducer';
import type { AgentEvent } from '../../src/shared/agent-events';
import type { MemoryEvidence, MemoryKind } from '../../src/shared/memory-schema';

/** Build a minimal event envelope for tests. */
function makeEvent(
  overrides: Partial<AgentEvent> & Pick<AgentEvent, 'type' | 'sessionId'>,
): AgentEvent {
  const base = {
    eventId: crypto.randomUUID(),
    seq: 1,
    ts: Date.now(),
  } as const;
  return { ...base, ...overrides } as AgentEvent;
}

const STATUS_EVENT = (
  sessionId: string,
  seq: number,
  status: 'idle' | 'streaming' | 'tool-running' | 'aborted' | 'errored',
) => makeEvent({ type: 'session.status', sessionId, seq, status }) as AgentEvent;

const MESSAGE_FINAL = (sessionId: string, seq: number, text: string) =>
  makeEvent({
    type: 'message.final',
    sessionId,
    seq,
    role: 'assistant',
    content: { text },
  }) as AgentEvent;

const MESSAGE_PARTIAL = (sessionId: string, seq: number, messageId: string, text: string) =>
  ({
    ...makeEvent({
      type: 'message.partial',
      sessionId,
      seq,
      role: 'assistant',
      content: { text },
    }),
    messageId,
  }) as unknown as AgentEvent;

const MESSAGE_FINAL_WITH_ID = (sessionId: string, seq: number, messageId: string, text: string) =>
  ({
    ...makeEvent({
      type: 'message.final',
      sessionId,
      seq,
      role: 'assistant',
      content: { text },
    }),
    messageId,
  }) as unknown as AgentEvent;
const THINKING_PARTIAL = (sessionId: string, seq: number, messageId: string, thinking: string) =>
  ({
    ...makeEvent({
      type: 'thinking.partial',
      sessionId,
      seq,
      role: 'assistant',
      content: { thinking },
    }),
    messageId,
  }) as unknown as AgentEvent;

const THINKING_FINAL = (
  sessionId: string,
  seq: number,
  messageId: string,
  thinking: string,
  thinkingRedacted?: boolean,
) =>
  ({
    ...makeEvent({
      type: 'thinking.final',
      sessionId,
      seq,
      role: 'assistant',
      content: { thinking },
    }),
    messageId,
    ...(thinkingRedacted ? { thinkingRedacted: true } : {}),
  }) as unknown as AgentEvent;

const SESSION_ERROR = (sessionId: string, seq: number, code: string, message: string) =>
  makeEvent({ type: 'session.error', sessionId, seq, code, message }) as AgentEvent;
const TOOL_BLOCKED = (sessionId: string, seq: number, safetyNote: string) =>
  makeEvent({
    type: 'tool.blocked',
    sessionId,
    seq,
    toolName: 'write_file',
    target: 'C:/work/x.txt',
    safetyNote,
  }) as AgentEvent;

const RECORDED_EVENT = (
  sessionId: string,
  seq: number,
  entryId: string,
  title: string,
  kind: MemoryKind = 'knowledge',
  evidence: MemoryEvidence = 'user-stated',
) =>
  makeEvent({
    type: 'memory.recorded',
    sessionId,
    seq,
    entryId,
    title,
    kind,
    evidence,
  }) as AgentEvent;

describe('reducer', () => {
  describe('initialReducerState', () => {
    it('Given 无状态 When 调用工厂 Then 返回空 sessions 与 null activeSessionId', () => {
      const state = initialReducerState();
      expect(state).toEqual({ sessions: {}, activeSessionId: null });
    });

    it('Given 多次调用工厂 When 比较结果 Then 互不共享引用', () => {
      const a = initialReducerState();
      const b = initialReducerState();
      expect(a).not.toBe(b);
      expect(a.sessions).not.toBe(b.sessions);
    });
  });

  describe('event-batch', () => {
    it('Given 已知 session 的批量事件 When dispatch Then 按 seq 升序写入该 session', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const events = [
        MESSAGE_FINAL('s1', 3, 'c'),
        MESSAGE_FINAL('s1', 1, 'a'),
        MESSAGE_FINAL('s1', 2, 'b'),
      ];
      const next = reducer(state, { type: 'event-batch', events });
      const seqs = next.sessions.s1.events.map((e) => e.seq);
      expect(seqs).toEqual([1, 2, 3]);
      expect(
        next.sessions.s1.events.map((e) => (e as { content: { text: string } }).content.text),
      ).toEqual(['a', 'b', 'c']);
    });

    it('Given 含未知 sessionId 的批量事件 When dispatch Then 该 session 仅被 buffer 进 sessions map', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const events = [MESSAGE_FINAL('s1', 1, 'hi'), MESSAGE_FINAL('ghost', 1, 'g')];
      const next = reducer(state, { type: 'event-batch', events });
      // active session 仍只收到 s1 的事件
      expect(next.sessions.s1.events).toHaveLength(1);
      // ghost session 被 buffer 但 inactive
      expect(next.sessions.ghost).toBeDefined();
      expect(next.sessions.ghost.events).toHaveLength(1);
      expect(next.sessions.ghost.status).toBe('idle');
    });

    it('Given 批量事件 When dispatch Then activeSessionId 不被改变', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const next = reducer(state, {
        type: 'event-batch',
        events: [MESSAGE_FINAL('s1', 1, 'x')],
      });
      expect(next.activeSessionId).toBe('s1');
    });
  });

  describe('event-received', () => {
    it('Given 未知 sessionId 且无 active When dispatch Then 创建 idle session 并写入事件', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: null };
      const ev = MESSAGE_FINAL('s1', 1, 'hello');
      const next = reducer(state, { type: 'event-received', event: ev });
      expect(next.sessions.s1).toBeDefined();
      expect(next.sessions.s1.status).toBe('idle');
      expect(next.sessions.s1.events).toHaveLength(1);
      expect(next.sessions.s1.lastEventId).toBe(ev.eventId);
    });

    it('Given out-of-session 事件且 activeSessionId 不匹配 When dispatch Then buffer 进目标 session 且不污染 active', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 'active' };
      const ev = MESSAGE_FINAL('other', 1, 'o');
      const next = reducer(state, { type: 'event-received', event: ev });
      // other 被 buffer
      expect(next.sessions.other.events).toHaveLength(1);
      // active session 未被创建
      expect(next.sessions.active).toBeUndefined();
      // activeSessionId 不变
      expect(next.activeSessionId).toBe('active');
    });

    it('Given 重复 eventId 的事件 When dispatch Then 去重,状态不变', () => {
      const ev = MESSAGE_FINAL('s1', 1, 'dup');
      const first = reducer(
        { sessions: {}, activeSessionId: 's1' },
        { type: 'event-received', event: ev },
      );
      const second = reducer(first, { type: 'event-received', event: ev });
      expect(second.sessions.s1.events).toHaveLength(1);
      expect(second.sessions.s1.lastEventId).toBe(ev.eventId);
    });

    it('Given 同一 messageId 的流式事件 When dispatch Then 只保留最新的一条消息', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const first = reducer(state, {
        type: 'event-received',
        event: MESSAGE_PARTIAL('s1', 1, 'm1', '首字'),
      });
      const second = reducer(first, {
        type: 'event-received',
        event: MESSAGE_PARTIAL('s1', 2, 'm1', '完整答案'),
      });
      const next = reducer(second, {
        type: 'event-received',
        event: MESSAGE_FINAL_WITH_ID('s1', 3, 'm1', '最终答案'),
      });

      expect(next.sessions.s1.events).toHaveLength(1);
      expect(next.sessions.s1.events[0]).toMatchObject({
        type: 'message.final',
        messageId: 'm1',
        content: { text: '最终答案' },
      });
    });

    it('Given final 先到且旧 partial 后到 When dispatch Then final 不被回退', () => {
      const finalState = reducer(
        { sessions: {}, activeSessionId: 's1' },
        {
          type: 'event-received',
          event: MESSAGE_FINAL_WITH_ID('s1', 3, 'm1', '最终答案'),
        },
      );
      const next = reducer(finalState, {
        type: 'event-received',
        event: MESSAGE_PARTIAL('s1', 2, 'm1', '旧片段'),
      });

      expect(next.sessions.s1.events).toHaveLength(1);
      expect(next.sessions.s1.events[0]).toMatchObject({
        type: 'message.final',
        content: { text: '最终答案' },
      });
    });

    it('Given 同一 messageId 的 thinking.partial 流 When dispatch Then 只保留最新的 thinking', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const first = reducer(state, {
        type: 'event-received',
        event: THINKING_PARTIAL('s1', 1, 'm1', '首行思考'),
      });
      const next = reducer(first, {
        type: 'event-received',
        event: THINKING_PARTIAL('s1', 2, 'm1', '完整思考'),
      });

      expect(next.sessions.s1.events).toHaveLength(1);
      expect(next.sessions.s1.events[0]).toMatchObject({
        type: 'thinking.partial',
        messageId: 'm1',
        content: { thinking: '完整思考' },
      });
    });

    it('Given message 与 thinking 共享同一 messageId When dispatch Then 二者共存并按 seq 排序', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const withMessage = reducer(state, {
        type: 'event-received',
        event: MESSAGE_FINAL_WITH_ID('s1', 2, 'm1', '答案'),
      });
      const next = reducer(withMessage, {
        type: 'event-received',
        event: THINKING_PARTIAL('s1', 1, 'm1', '先想再答'),
      });

      expect(next.sessions.s1.events).toHaveLength(2);
      expect(next.sessions.s1.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(next.sessions.s1.events.some((e) => e.type === 'thinking.partial')).toBe(true);
      expect(next.sessions.s1.events.some((e) => e.type === 'message.final')).toBe(true);
    });

    it('Given thinking.final When 替换同 messageId 的 thinking.partial Then 保留 final', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const partial = reducer(state, {
        type: 'event-received',
        event: THINKING_PARTIAL('s1', 1, 'm1', '想'),
      });
      const next = reducer(partial, {
        type: 'event-received',
        event: THINKING_FINAL('s1', 2, 'm1', '最终思考'),
      });

      expect(next.sessions.s1.events).toHaveLength(1);
      expect(next.sessions.s1.events[0]).toMatchObject({
        type: 'thinking.final',
        messageId: 'm1',
        content: { thinking: '最终思考' },
      });
    });

    it('Given thinking.final 先到且旧 thinking.partial 后到 When dispatch Then final 不被回退', () => {
      const finalState = reducer(
        { sessions: {}, activeSessionId: 's1' },
        { type: 'event-received', event: THINKING_FINAL('s1', 2, 'm1', '最终思考') },
      );
      const next = reducer(finalState, {
        type: 'event-received',
        event: THINKING_PARTIAL('s1', 1, 'm1', '旧思考'),
      });

      expect(next.sessions.s1.events).toHaveLength(1);
      expect(next.sessions.s1.events[0].type).toBe('thinking.final');
    });

    it('Given thinking.partial When dispatch Then 记录该流首个 partial 的 ts 锚点', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const p1 = { ...THINKING_PARTIAL('s1', 1, 'm1', '先想'), ts: 1000 } as AgentEvent;
      const next = reducer(state, { type: 'event-received', event: p1 });
      expect(next.sessions.s1.thinkingFirstTs?.['m1:0']).toBe(1000);
    });

    it('Given 多条 partial + final When dispatch Then 锚点为最早 partial ts,折叠契约不变', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const p1 = { ...THINKING_PARTIAL('s1', 1, 'm1', 'a'), ts: 1000 } as AgentEvent;
      const p2 = { ...THINKING_PARTIAL('s1', 2, 'm1', 'ab'), ts: 2000 } as AgentEvent;
      const final = { ...THINKING_FINAL('s1', 3, 'm1', 'abc'), ts: 35000 } as AgentEvent;
      let s = reducer(state, { type: 'event-received', event: p1 });
      s = reducer(s, { type: 'event-received', event: p2 });
      s = reducer(s, { type: 'event-received', event: final });
      expect(s.sessions.s1.thinkingFirstTs?.['m1:0']).toBe(1000);
      // 既有折叠契约:同 messageId 只保留 final
      const thinking = s.sessions.s1.events.filter(
        (e) => e.type === 'thinking.partial' || e.type === 'thinking.final',
      );
      expect(thinking).toHaveLength(1);
      expect(thinking[0].type).toBe('thinking.final');
    });

    it('Given final 先到、旧 partial 后到 When dispatch Then 锚点记录更早 ts,final 不回退', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const final = { ...THINKING_FINAL('s1', 3, 'm1', 'abc'), ts: 35000 } as AgentEvent;
      const latePartial = { ...THINKING_PARTIAL('s1', 1, 'm1', 'a'), ts: 1000 } as AgentEvent;
      let s = reducer(state, { type: 'event-received', event: final });
      s = reducer(s, { type: 'event-received', event: latePartial });
      expect(s.sessions.s1.thinkingFirstTs?.['m1:0']).toBe(1000);
      expect(s.sessions.s1.events).toHaveLength(1);
      expect(s.sessions.s1.events[0].type).toBe('thinking.final');
    });

    it('Given session.error 事件 When dispatch Then inlineError 为 "code: message"', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const ev = SESSION_ERROR('s1', 1, 'UPSTREAM_TIMEOUT', '上游超时');
      const next = reducer(state, { type: 'event-received', event: ev });
      expect(next.sessions.s1.inlineError).toBe('UPSTREAM_TIMEOUT: 上游超时');
    });

    it('Given session.status 事件 When dispatch Then session.status 被更新', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const next = reducer(state, {
        type: 'event-received',
        event: STATUS_EVENT('s1', 1, 'streaming'),
      });
      expect(next.sessions.s1.status).toBe('streaming');
    });

    it('Given tool.blocked 事件 When dispatch Then hasBlockedTool 置 true', () => {
      const state: ReducerState = { sessions: {}, activeSessionId: 's1' };
      const next = reducer(state, {
        type: 'event-received',
        event: TOOL_BLOCKED('s1', 1, 'path-out-of-workspace'),
      });
      expect(next.sessions.s1.hasBlockedTool).toBe(true);
    });
  });

  describe('subscribe-session', () => {
    it('Given 新 sessionId When dispatch Then 创建 idle session 并设为 active', () => {
      const next = reducer(initialReducerState(), {
        type: 'subscribe-session',
        sessionId: 's-new',
      });
      expect(next.sessions['s-new']).toEqual({
        sessionId: 's-new',
        status: 'idle',
        events: [],
      });
      expect(next.activeSessionId).toBe('s-new');
    });

    it('Given 已存在该 sessionId When dispatch Then 保留旧 events,仅切换 active', () => {
      const ev = MESSAGE_FINAL('s1', 1, 'keep');
      const seeded = reducer(
        { sessions: {}, activeSessionId: null },
        { type: 'event-received', event: ev },
      );
      const next = reducer(seeded, { type: 'subscribe-session', sessionId: 's1' });
      expect(next.activeSessionId).toBe('s1');
      expect(next.sessions.s1.events).toHaveLength(1);
      expect(next.sessions.s1.events[0]).toBe(ev);
    });
  });

  describe('unsubscribe-session', () => {
    it('Given 非 active session When dispatch Then 该 session 被从 map 中移除', () => {
      const seeded: ReducerState = {
        sessions: {
          s1: { sessionId: 's1', status: 'idle', events: [] },
          s2: { sessionId: 's2', status: 'idle', events: [] },
        },
        activeSessionId: 's1',
      };
      const next = reducer(seeded, { type: 'unsubscribe-session', sessionId: 's2' });
      expect(next.sessions.s2).toBeUndefined();
      expect(next.sessions.s1).toBeDefined();
      expect(next.activeSessionId).toBe('s1');
    });

    it('Given 取消的正是 active session When dispatch Then activeSessionId 置 null', () => {
      const seeded: ReducerState = {
        sessions: {
          s1: { sessionId: 's1', status: 'idle', events: [] },
        },
        activeSessionId: 's1',
      };
      const next = reducer(seeded, { type: 'unsubscribe-session', sessionId: 's1' });
      expect(next.sessions.s1).toBeUndefined();
      expect(next.activeSessionId).toBeNull();
    });
  });

  describe('set-inline-error', () => {
    it('Given 已存在的 session When dispatch Then 该 session 的 inlineError 被更新', () => {
      const seeded: ReducerState = {
        sessions: { s1: { sessionId: 's1', status: 'idle', events: [] } },
        activeSessionId: 's1',
      };
      const next = reducer(seeded, {
        type: 'set-inline-error',
        sessionId: 's1',
        message: '磁盘已满',
      });
      expect(next.sessions.s1.inlineError).toBe('磁盘已满');
    });

    it('Given 不存在的 sessionId When dispatch Then 状态保持不变', () => {
      const seeded: ReducerState = {
        sessions: { s1: { sessionId: 's1', status: 'idle', events: [] } },
        activeSessionId: 's1',
      };
      const next = reducer(seeded, {
        type: 'set-inline-error',
        sessionId: 'ghost',
        message: 'no-op',
      });
      expect(next).toBe(seeded);
      expect(next.sessions.ghost).toBeUndefined();
    });

    it('Given message 为 undefined When dispatch Then inlineError 被清除', () => {
      const seeded: ReducerState = {
        sessions: {
          s1: { sessionId: 's1', status: 'idle', events: [], inlineError: '旧错误' },
        },
        activeSessionId: 's1',
      };
      const next = reducer(seeded, {
        type: 'set-inline-error',
        sessionId: 's1',
        message: undefined,
      });
      expect(next.sessions.s1.inlineError).toBeUndefined();
    });
  });

  describe('set-active', () => {
    it('Given 新 sessionId When dispatch Then activeSessionId 切换', () => {
      const seeded: ReducerState = {
        sessions: {
          s1: { sessionId: 's1', status: 'idle', events: [] },
          s2: { sessionId: 's2', status: 'idle', events: [] },
        },
        activeSessionId: 's1',
      };
      const next = reducer(seeded, { type: 'set-active', sessionId: 's2' });
      expect(next.activeSessionId).toBe('s2');
      expect(next.sessions.s1).toBeDefined();
      expect(next.sessions.s2).toBeDefined();
    });

    it('Given null When dispatch Then activeSessionId 置空', () => {
      const seeded: ReducerState = {
        sessions: { s1: { sessionId: 's1', status: 'idle', events: [] } },
        activeSessionId: 's1',
      };
      const next = reducer(seeded, { type: 'set-active', sessionId: null });
      expect(next.activeSessionId).toBeNull();
    });
  });
});

describe('reducer property · message/thinking 命名空间隔离', () => {
  /** 生成一个随机的 message / thinking 事件（final 或 partial）。 */
  function randomEvent(
    sessionId: string,
    kind: 'message' | 'thinking',
    isFinal: boolean,
    messageId: string,
    seq: number,
    eventId: string,
  ): AgentEvent {
    if (kind === 'message') {
      return makeEvent({
        type: isFinal ? 'message.final' : 'message.partial',
        sessionId,
        seq,
        eventId,
        role: 'assistant',
        content: { text: `text-${seq}` },
        messageId,
      }) as AgentEvent;
    }
    return {
      ...makeEvent({
        type: isFinal ? 'thinking.final' : 'thinking.partial',
        sessionId,
        seq,
        eventId,
        role: 'assistant',
        content: { thinking: `think-${seq}` },
      }),
      messageId,
    } as unknown as AgentEvent;
  }

  it('同一 messageId 的 message 与 thinking 事件永不互相覆盖（FM-2 不变量）', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom<'message' | 'thinking'>('message', 'thinking'),
            isFinal: fc.boolean(),
            messageId: fc.string({ minLength: 1, maxLength: 8 }),
          }),
          { maxLength: 40 },
        ),
        (entries) => {
          const sid = 'prop-session';
          const events = entries.map((e, i) =>
            randomEvent(sid, e.kind, e.isFinal, e.messageId, i, `evt-${i}`),
          );
          let state: ReducerState = { ...initialReducerState(), activeSessionId: sid };
          for (const ev of events) {
            state = reducer(state, { type: 'event-received', event: ev });
          }
          const sess = state.sessions[sid];
          if (!sess) return; // 零事件 → 无会话，平凡成立

          const byMessageId = new Map<string, AgentEvent[]>();
          for (const ev of sess.events) {
            if (
              ev.type === 'message.partial' ||
              ev.type === 'message.final' ||
              ev.type === 'thinking.partial' ||
              ev.type === 'thinking.final'
            ) {
              const id = ev.messageId;
              byMessageId.set(id, [...(byMessageId.get(id) ?? []), ev]);
            }
          }
          for (const [, evs] of byMessageId) {
            const msg = evs.filter((e) => e.type.startsWith('message.'));
            const think = evs.filter((e) => e.type.startsWith('thinking.'));
            expect(msg.length).toBeLessThanOrEqual(1);
            expect(think.length).toBeLessThanOrEqual(1);
            if (msg.length === 1 && think.length === 1) {
              const m = msg[0] as AgentEvent & { content: { text?: string } };
              const t = think[0] as AgentEvent & { content: { thinking?: string } };
              expect(m.content.text).toBeTypeOf('string');
              expect(t.content.thinking).toBeTypeOf('string');
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// 分级审批:approval-requested 设置审批模态,approval.resolved 清除
// ---------------------------------------------------------------------------

describe('reducer 审批事件', () => {
  const APPROVAL_EVENT = (
    sessionId: string,
    seq: number,
    approvalId: string,
    toolName = 'write',
    target = 'D:/out.txt',
  ) =>
    makeEvent({
      type: 'tool.approval-requested',
      sessionId,
      seq,
      approvalId,
      toolName,
      target,
      reason: 'approval-required: 写入位置在工作区外',
    }) as AgentEvent;

  const RESOLVED_EVENT = (sessionId: string, seq: number, approvalId: string) =>
    makeEvent({
      type: 'approval.resolved',
      sessionId,
      seq,
      approvalId,
      decision: 'allowAlways',
    }) as AgentEvent;

  it('approval-requested 设置 pendingApproval(覆盖式)', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, { type: 'event-received', event: APPROVAL_EVENT('s1', 1, 'a1') });
    expect(state.sessions.s1?.pendingApproval).toEqual({
      approvalId: 'a1',
      toolName: 'write',
      target: 'D:/out.txt',
      reason: 'approval-required: 写入位置在工作区外',
    });

    // 新请求覆盖旧请求
    state = reducer(state, {
      type: 'event-received',
      event: APPROVAL_EVENT('s1', 2, 'a2', 'edit', 'D:/out2.txt'),
    });
    expect(state.sessions.s1?.pendingApproval?.approvalId).toBe('a2');
  });

  it('approval.resolved 按 approvalId 清除审批模态', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, { type: 'event-received', event: APPROVAL_EVENT('s1', 1, 'a1') });
    state = reducer(state, {
      type: 'event-received',
      event: RESOLVED_EVENT('s1', 2, 'a1'),
    });
    expect(state.sessions.s1?.pendingApproval).toBeUndefined();
  });

  it('resolved 的 approvalId 不匹配时保留审批模态', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, { type: 'event-received', event: APPROVAL_EVENT('s1', 1, 'a1') });
    state = reducer(state, {
      type: 'event-received',
      event: RESOLVED_EVENT('s1', 2, 'other-id'),
    });
    expect(state.sessions.s1?.pendingApproval?.approvalId).toBe('a1');
  });

  it('approval-resolved action 乐观清除', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, { type: 'event-received', event: APPROVAL_EVENT('s1', 1, 'a1') });
    state = reducer(state, { type: 'approval-resolved', sessionId: 's1', approvalId: 'a1' });
    expect(state.sessions.s1?.pendingApproval).toBeUndefined();

    // 幂等:已清除后再来一次不报错
    state = reducer(state, { type: 'approval-resolved', sessionId: 's1', approvalId: 'a1' });
    expect(state.sessions.s1?.pendingApproval).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 会话内记忆只读通知(1.6):memory.recorded 事件追加 recordedNotices(去重,
// 上限保留最近 N 条),memory-notice-dismissed 移除(自动消退/下一事件覆盖)
// ---------------------------------------------------------------------------

describe('reducer 记忆记录通知事件', () => {
  it('memory.recorded 事件 → recordedNotices 追加 { entryId,title,kind,evidence }', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 1, 'e1', '禁删根目录', 'hard_policy', 'user-stated'),
    });
    expect(state.sessions.s1?.recordedNotices).toEqual([
      { entryId: 'e1', title: '禁删根目录', kind: 'hard_policy', evidence: 'user-stated' },
    ]);
  });

  it('无 memory.recorded 事件 → recordedNotices 空态(未定义,消费端按空数组)', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, { type: 'event-received', event: MESSAGE_FINAL('s1', 1, 'hi') });
    expect(state.sessions.s1?.recordedNotices).toBeUndefined();
  });

  it('多个事件 → 按到达顺序追加', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 1, 'e1', '标题一'),
    });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 2, 'e2', '标题二'),
    });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 3, 'e3', '标题三'),
    });
    expect(state.sessions.s1?.recordedNotices?.map((n) => n.entryId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('同一 entryId 重复事件 → 去重(幂等,不出现两条通知)', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 1, 'e1', '标题一'),
    });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 2, 'e1', '标题一'),
    });
    expect(state.sessions.s1?.recordedNotices).toEqual([
      { entryId: 'e1', title: '标题一', kind: 'knowledge', evidence: 'user-stated' },
    ]);
  });

  it('超过上限 → 仅保留最近 N 条(MAX_RECORDED_NOTICES)', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    for (let i = 1; i <= MAX_RECORDED_NOTICES + 2; i += 1) {
      state = reducer(state, {
        type: 'event-received',
        event: RECORDED_EVENT('s1', i, `e${i}`, `标题${i}`),
      });
    }
    const notices = state.sessions.s1?.recordedNotices ?? [];
    expect(notices).toHaveLength(MAX_RECORDED_NOTICES);
    // 保留最新:最旧两条被挤出。
    expect(notices[0].entryId).toBe('e3');
    expect(notices[notices.length - 1].entryId).toBe(`e${MAX_RECORDED_NOTICES + 2}`);
  });

  it('memory-notice-dismissed → 移除 entryId,其余保留', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 1, 'e1', '标题一'),
    });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 2, 'e2', '标题二'),
    });
    state = reducer(state, {
      type: 'memory-notice-dismissed',
      sessionId: 's1',
      entryId: 'e1',
    });
    expect(state.sessions.s1?.recordedNotices?.map((n) => n.entryId)).toEqual(['e2']);
  });

  it('dismiss 不存在的 entryId → 状态不变(幂等)', () => {
    let state = reducer(initialReducerState(), { type: 'subscribe-session', sessionId: 's1' });
    state = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('s1', 1, 'e1', '标题一'),
    });
    const before = state;
    const next = reducer(state, {
      type: 'memory-notice-dismissed',
      sessionId: 's1',
      entryId: 'ghost',
    });
    expect(next).toBe(before);
    expect(next.sessions.s1?.recordedNotices).toEqual([
      { entryId: 'e1', title: '标题一', kind: 'knowledge', evidence: 'user-stated' },
    ]);
  });

  it('非 active session 的事件 → buffer 且不污染 active session 的通知', () => {
    const state: ReducerState = { sessions: {}, activeSessionId: 'active' };
    const next = reducer(state, {
      type: 'event-received',
      event: RECORDED_EVENT('other', 1, 'e1', '标题一'),
    });
    expect(next.sessions.other?.recordedNotices).toBeUndefined();
    expect(next.sessions.active).toBeUndefined();
  });
});
