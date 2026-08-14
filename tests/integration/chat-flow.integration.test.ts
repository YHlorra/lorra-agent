// chat-flow 完整多轮 补锁
//
// chat-pane.test.tsx 已经测了「完整事件流 → 渲染」,reducer.test.ts 测了
// 各 action 的局部行为。本测试覆盖它们的交集:完整会话在 reducer 层走通。
//
// 不挂 React、不发 IPC、不起 Electron —— 直接调 reducer 处理一连串事件,
// 断言最终 state.sessions[sid] 的 shape 是 ChatPane 能直接消费的形态。
import { describe, expect, it } from 'vitest';
import { groupChatEvents } from '../../src/renderer/lib/chat-groups';
import { initialReducerState, type ReducerState, reducer } from '../../src/renderer/reducer';
import type { AgentEvent, SessionStatus } from '../../src/shared/agent-events';

function evt<T extends AgentEvent['type']>(
  type: T,
  sessionId: string,
  seq: number,
  extra: Partial<Extract<AgentEvent, { type: T }>> = {},
): AgentEvent {
  return {
    type,
    sessionId,
    eventId: `${type}-${seq}`,
    seq,
    ts: 1000 + seq,
    ...extra,
  } as unknown as AgentEvent;
}

describe('chat-flow · 完整多轮 reducer 行为', () => {
  it('Given 完整两轮 + tool.blocked + session.error 事件序列 When dispatch Then 最终状态可被 ChatPane 直接消费', () => {
    const sid = 'chat-1';
    let state: ReducerState = reducer(initialReducerState(), {
      type: 'subscribe-session',
      sessionId: sid,
    });

    // --- 第 1 轮:用户问 + AI 思考 + 调工具 + 流式回答 ---
    state = reducer(state, {
      type: 'event-received',
      event: evt('message.final', sid, 1, { role: 'user', content: { text: '看看 foo.ts' } }),
    });
    state = reducer(state, {
      type: 'event-received',
      event: evt('thinking.partial', sid, 2, {
        messageId: 'm1',
        role: 'assistant',
        content: { thinking: '先看一下' },
      }),
    });
    state = reducer(state, {
      type: 'event-received',
      event: evt('thinking.final', sid, 3, {
        messageId: 'm1',
        role: 'assistant',
        content: { thinking: '先看一下再决定改不改' },
      }),
    });
    state = reducer(state, {
      type: 'event-received',
      event: evt('tool.start', sid, 4, { toolName: 'read', target: 'foo.ts', callId: 'c1' }),
    });
    state = reducer(state, {
      type: 'event-received',
      event: evt('tool.end', sid, 5, {
        toolName: 'read',
        target: 'foo.ts',
        callId: 'c1',
        result: '文件内容',
        ok: true,
      }),
    });
    state = reducer(state, {
      type: 'event-received',
      event: evt('message.partial', sid, 6, {
        messageId: 'm1',
        role: 'assistant',
        content: { text: '## 答案\n\n在' },
      }),
    });
    state = reducer(state, {
      type: 'event-received',
      event: evt('message.final', sid, 7, {
        messageId: 'm1',
        role: 'assistant',
        content: { text: '## 答案\n\n在第 40 行' },
      }),
    });
    state = reducer(state, {
      type: 'event-received',
      event: evt('session.status', sid, 8, { status: 'idle' as SessionStatus }),
    });

    // --- 第 2 轮:AI 想写文件但被安全拦截 + session.error ---
    state = reducer(state, {
      type: 'event-received',
      event: evt('tool.blocked', sid, 9, {
        toolName: 'write_file',
        target: '/etc/passwd',
        callId: 'c2',
        safetyNote: 'path-out-of-workspace',
      }),
    });
    state = reducer(state, {
      type: 'event-received',
      event: evt('session.error', sid, 10, { code: 'UPSTREAM_TIMEOUT', message: '上游超时' }),
    });

    const sess = state.sessions[sid];
    expect(sess).toBeDefined();

    // 1) 事件按 seq 升序写入;reducer 把 message/thinking 同 messageId 的
    // partial 替换为 final,所以 seq 2/6(partial)被替换,最终剩 8 个事件。
    const seqs = sess.events.map((e) => e.seq);
    expect(seqs).toEqual([1, 3, 4, 5, 7, 8, 9, 10]);

    // 2) messageId=m1 的 message 流:partial 被 final 覆盖,只 1 条
    const m1Messages = sess.events.filter(
      (e) => (e.type === 'message.partial' || e.type === 'message.final') && e.messageId === 'm1',
    );
    expect(m1Messages).toHaveLength(1);
    expect(m1Messages[0]).toMatchObject({
      type: 'message.final',
      content: { text: '## 答案\n\n在第 40 行' },
    });

    // 3) messageId=m1 的 thinking 流:partial 被 final 覆盖,只 1 条
    const m1Thinking = sess.events.filter(
      (e) => (e.type === 'thinking.partial' || e.type === 'thinking.final') && e.messageId === 'm1',
    );
    expect(m1Thinking).toHaveLength(1);
    expect(m1Thinking[0]).toMatchObject({ type: 'thinking.final' });

    // 4) tool 事件两条都保留(start/end 是不同的 type,不被 dedup)
    const toolEvents = sess.events.filter((e) => e.type.startsWith('tool.'));
    expect(toolEvents.map((e) => e.type)).toEqual(['tool.start', 'tool.end', 'tool.blocked']);

    // 5) 安全拦截器命中 → hasBlockedTool 置 true
    expect(sess.hasBlockedTool).toBe(true);

    // 6) session.error → inlineError 写入 "code: message" 格式
    expect(sess.inlineError).toBe('UPSTREAM_TIMEOUT: 上游超时');

    // 7) 最终 session.status 由 session.status 事件决定
    expect(sess.status).toBe('idle');

    // 8) ChatPane 渲染所需的 events/status/inlineError 全部就位
    const eventsForChatPane = sess.events;
    const statusForChatPane: SessionStatus = sess.status;
    const inlineErrorForChatPane: string = sess.inlineError ?? '';
    expect(eventsForChatPane.length).toBe(8);
    expect(statusForChatPane).toBe('idle');
    expect(inlineErrorForChatPane).toBe('UPSTREAM_TIMEOUT: 上游超时');
  });

  it('Given out-of-order 事件(含迟到 partial) When dispatch Then final 不被回退,partial 升级为 final', () => {
    // 真实场景:网络抖动导致 partial 比 final 后到。
    // reducer 契约:final 先到,partial 后到时 final 不被覆盖(见 reducer.ts:73)。
    const sid = 'chat-2';
    let state: ReducerState = reducer(initialReducerState(), {
      type: 'subscribe-session',
      sessionId: sid,
    });

    // final 先
    state = reducer(state, {
      type: 'event-received',
      event: evt('message.final', sid, 5, {
        messageId: 'm1',
        role: 'assistant',
        content: { text: 'final 答案' },
      }),
    });
    // 旧 partial 后
    state = reducer(state, {
      type: 'event-received',
      event: evt('message.partial', sid, 3, {
        messageId: 'm1',
        role: 'assistant',
        content: { text: '旧片段' },
      }),
    });

    const m1Messages = state.sessions[sid].events.filter(
      (e) => (e.type === 'message.partial' || e.type === 'message.final') && e.messageId === 'm1',
    );
    expect(m1Messages).toHaveLength(1);
    expect(m1Messages[0]).toMatchObject({
      type: 'message.final',
      content: { text: 'final 答案' },
    });
  });
});

describe('chat-flow · 重复打开会话收敛(M3 回归)', () => {
  it('Given 同一批重放事件 dispatch 两遍(模拟重复打开) When reducer + groupChatEvents Then message/thinking 折叠收敛、渲染行数不翻倍', () => {
    const sid = 'dup-1';
    let state: ReducerState = reducer(initialReducerState(), {
      type: 'subscribe-session',
      sessionId: sid,
    });
    // 同一批历史事件,messageId/callId 稳定(重放路径用持久化消息 id)。
    const replayBatch = (baseSeq: number): AgentEvent[] => [
      evt('message.final', sid, baseSeq + 1, {
        role: 'user',
        messageId: 'u1',
        content: { text: '你好' },
      }),
      evt('thinking.final', sid, baseSeq + 2, {
        role: 'assistant',
        messageId: 'a1',
        content: { thinking: '想' },
      }),
      evt('message.final', sid, baseSeq + 3, {
        role: 'assistant',
        messageId: 'a1',
        content: { text: '答案' },
      }),
      evt('tool.start', sid, baseSeq + 4, {
        toolName: 'read',
        target: 'x.ts',
        callId: 'c1',
      }),
      evt('tool.end', sid, baseSeq + 5, {
        toolName: 'read',
        target: 'x.ts',
        callId: 'c1',
        result: 'body',
        ok: true,
      }),
    ];
    for (const e of replayBatch(0)) {
      state = reducer(state, { type: 'event-received', event: e });
    }
    const onceRows = groupChatEvents(state.sessions[sid].events);
    // 第二次「重放」(重复打开会话,同 id 同内容、seq 更大)
    for (const e of replayBatch(10)) {
      state = reducer(state, { type: 'event-received', event: e });
    }
    const twice = state.sessions[sid].events;
    // message/thinking 折叠:同 messageId 同类型只保留一份(seq 更新)
    expect(twice.filter((e) => e.type === 'message.final')).toHaveLength(2);
    expect(twice.filter((e) => e.type === 'thinking.final')).toHaveLength(1);
    // tool 行 reducer 层追加,分组层按 callId 合并 → 渲染行数不翻倍
    expect(groupChatEvents(twice)).toHaveLength(onceRows.length);
  });
});
