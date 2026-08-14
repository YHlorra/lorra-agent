import { describe, expect, it } from 'vitest';
import { groupChatEvents } from '../../src/renderer/lib/chat-groups';
import type { AgentEvent } from '../../src/shared/agent-events';

// 事件构造:只填关心的字段,其余用 unknown cast 省略。
function messageEvent(
  type: 'message.partial' | 'message.final',
  role: 'user' | 'assistant',
  text: string,
  eventId = `evt-${text.length}-${role}`,
  ts = 1000,
): AgentEvent {
  return {
    type,
    sessionId: 's1',
    eventId,
    seq: 1,
    ts,
    messageId: `m-${text.length}`,
    role,
    content: { text },
  } as unknown as AgentEvent;
}

function toolStart(
  toolName: string,
  callId: string | undefined,
  eventId: string,
  args?: unknown,
  ts = 1000,
): AgentEvent {
  return {
    type: 'tool.start',
    sessionId: 's1',
    eventId,
    seq: 1,
    ts,
    toolName,
    target: toolName,
    callId,
    args,
  } as unknown as AgentEvent;
}

function toolUpdate(callId: string, delta: string, eventId: string, ts = 1000): AgentEvent {
  return {
    type: 'tool.update',
    sessionId: 's1',
    eventId,
    seq: 1,
    ts,
    toolName: 'read',
    target: 'read',
    callId,
    delta,
  } as unknown as AgentEvent;
}

function toolEnd(
  callId: string,
  ok: boolean,
  eventId: string,
  args?: unknown,
  toolName = 'read',
  ts = 1000,
): AgentEvent {
  return {
    type: 'tool.end',
    sessionId: 's1',
    eventId,
    seq: 1,
    ts,
    toolName,
    target: toolName,
    callId,
    result: 'r',
    ok,
    args,
  } as unknown as AgentEvent;
}

function toolBlocked(toolName: string, callId: string, eventId: string, ts = 1000): AgentEvent {
  return {
    type: 'tool.blocked',
    sessionId: 's1',
    eventId,
    seq: 1,
    ts,
    toolName,
    target: toolName,
    callId,
    safetyNote: 'path-out-of-workspace',
  } as unknown as AgentEvent;
}

function thinkingPartial(messageId: string, text: string, eventId: string, ts = 1000): AgentEvent {
  return {
    type: 'thinking.partial',
    sessionId: 's1',
    eventId,
    seq: 1,
    ts,
    messageId,
    role: 'assistant',
    content: { thinking: text },
  } as unknown as AgentEvent;
}

function thinkingFinal(
  messageId: string,
  text: string,
  eventId: string,
  thinkingRedacted?: boolean,
  ts = 1000,
): AgentEvent {
  return {
    type: 'thinking.final',
    sessionId: 's1',
    eventId,
    seq: 1,
    ts,
    messageId,
    role: 'assistant',
    content: { thinking: text },
    thinkingRedacted,
  } as unknown as AgentEvent;
}

/** 便捷:提取扁平流中的行类型序列。 */
function kinds(rows: ReturnType<typeof groupChatEvents>): string[] {
  return rows.map((r) => r.kind);
}

describe('groupChatEvents 连续流顺序', () => {
  it('思考段/工具/文本按事件到达顺序交替成行(不分组、不重排)', () => {
    const rows = groupChatEvents([
      messageEvent('message.final', 'user', '读文件'),
      thinkingPartial('m1', '先想', 't1'),
      thinkingFinal('m1', '想完了', 't2'),
      toolStart('read', 'call-A', 'ts1'),
      toolUpdate('call-A', '流式', 'tu1'),
      toolEnd('call-A', true, 'te1'),
      thinkingPartial('m2', '再想', 't3'),
      thinkingFinal('m2', '再想完', 't4'),
      toolStart('write', 'call-B', 'ts2'),
      toolEnd('call-B', true, 'te2'),
      messageEvent('message.final', 'assistant', '读完了'),
    ]);

    // 行序 = 事件序:user → 思考段 → 工具 → 思考段 → 工具 → assistant
    expect(kinds(rows)).toEqual(['message', 'thinking', 'tool', 'thinking', 'tool', 'message']);
    const thinkingRows = rows.filter((r) => r.kind === 'thinking');
    const toolRows = rows.filter((r) => r.kind === 'tool');
    if (thinkingRows[0].kind !== 'thinking' || thinkingRows[1].kind !== 'thinking') return;
    if (toolRows[0].kind !== 'tool' || toolRows[1].kind !== 'tool') return;
    expect(thinkingRows.map((t) => t.row.messageId)).toEqual(['m1', 'm2']);
    expect(toolRows.map((t) => t.row.key)).toEqual(['call-A', 'call-B']);
    // 工具收口状态完整
    expect(toolRows[0].row).toMatchObject({ status: 'ok', result: 'r', delta: undefined });
  });

  it('session.status / session.error 被跳过', () => {
    const rows = groupChatEvents([
      {
        type: 'session.status',
        sessionId: 's1',
        eventId: 'ss1',
        seq: 1,
        ts: 1,
        status: 'streaming',
      } as unknown as AgentEvent,
      {
        type: 'session.error',
        sessionId: 's1',
        eventId: 'se1',
        seq: 2,
        ts: 2,
        code: 'x',
        message: 'boom',
      } as unknown as AgentEvent,
    ]);
    expect(rows).toEqual([]);
  });
});

describe('groupChatEvents thinking 段合并', () => {
  it('同段 partial/final upsert:final 覆盖 partial 且带 redacted,位置不变', () => {
    const rows = groupChatEvents([
      thinkingPartial('m1', '一半', 't1'),
      toolStart('read', 'call-A', 'ts1'),
      thinkingFinal('m1', '全部', 't2', true),
    ]);
    expect(kinds(rows)).toEqual(['thinking', 'tool']);
    const thinking = rows[0];
    if (thinking.kind !== 'thinking') return;
    expect(thinking.row).toEqual({
      messageId: 'm1',
      segmentIndex: 0,
      thinking: '全部',
      running: false,
      redacted: true,
      durationMs: 0,
    });
  });

  it('不同 messageId 的思考各自成行', () => {
    const rows = groupChatEvents([
      thinkingPartial('m1', 'a', 't1'),
      thinkingPartial('m2', 'b', 't2'),
    ]);
    const t1 = rows[0];
    const t2 = rows[1];
    if (t1.kind !== 'thinking' || t2.kind !== 'thinking') return;
    expect([t1.row.messageId, t2.row.messageId]).toEqual(['m1', 'm2']);
  });
});

describe('groupChatEvents tool 合并', () => {
  it('同 callId 的 start/update/end 合并为一行:running → delta → ok+result', () => {
    const rows = groupChatEvents([
      toolStart('read', 'call-A', 'ts1'),
      toolUpdate('call-A', '流式', 'tu1'),
      toolEnd('call-A', true, 'te1'),
    ]);
    expect(rows).toHaveLength(1);
    const tool = rows[0];
    if (tool.kind !== 'tool') return;
    expect(tool.row).toMatchObject({
      key: 'call-A',
      status: 'ok',
      result: 'r',
      delta: undefined,
      toolName: 'read',
    });
  });

  it('无 callId 时按 eventId 独立成行', () => {
    const rows = groupChatEvents([
      toolStart('read', undefined, 'ts1') as AgentEvent,
      toolStart('read', undefined, 'ts2') as AgentEvent,
    ]);
    const t1 = rows[0];
    const t2 = rows[1];
    if (t1.kind !== 'tool' || t2.kind !== 'tool') return;
    expect([t1.row.key, t2.row.key]).toEqual(['ts1', 'ts2']);
  });

  it('tool.blocked:同 callId 已存在行 → 改状态为 blocked + safetyNote', () => {
    const rows = groupChatEvents([
      toolStart('read', 'call-B', 'ts1'),
      toolBlocked('read', 'call-B', 'tb1'),
    ]);
    expect(rows).toHaveLength(1);
    const tool = rows[0];
    if (tool.kind !== 'tool') return;
    expect(tool.row).toMatchObject({
      key: 'call-B',
      status: 'blocked',
      safetyNote: 'path-out-of-workspace',
    });
  });

  it('tool.blocked:新 callId → 新建 blocked 行', () => {
    const rows = groupChatEvents([toolBlocked('write_file', 'call-C', 'tb1')]);
    expect(rows).toHaveLength(1);
    const tool = rows[0];
    if (tool.kind !== 'tool') return;
    expect(tool.row).toMatchObject({
      key: 'call-C',
      status: 'blocked',
      safetyNote: 'path-out-of-workspace',
    });
  });

  it('tool.end ok=false → error 状态', () => {
    const rows = groupChatEvents([toolEnd('call-D', false, 'te1')]);
    expect(rows).toHaveLength(1);
    const tool = rows[0];
    if (tool.kind !== 'tool') return;
    expect(tool.row).toMatchObject({ key: 'call-D', status: 'error' });
  });
});

describe('groupChatEvents update_plan', () => {
  const planArgs = {
    explanation: '先规划',
    plan: [
      { step: '搜索', status: 'in_progress' },
      { step: '写作', status: 'pending' },
    ],
  };

  it('tool.start 命中 update_plan → 行带 plan(running=true)', () => {
    const rows = groupChatEvents([toolStart('update_plan', 'call-P', 'ts1', planArgs)]);
    const tool = rows[0];
    if (tool.kind !== 'tool') return;
    expect(tool.row.plan).toMatchObject({
      plan: [
        { step: '搜索', status: 'in_progress' },
        { step: '写作', status: 'pending' },
      ],
      explanation: '先规划',
      running: true,
    });
  });

  it('tool.end 命中 update_plan → running=false;非计划工具 → plan=undefined 普通工具行', () => {
    const rows = groupChatEvents([
      toolStart('update_plan', 'call-P', 'ts1', planArgs),
      toolEnd('call-P', true, 'te1', planArgs, 'update_plan'),
      toolStart('read', 'call-R', 'ts2'),
    ]);
    const t1 = rows[0];
    const t2 = rows[1];
    if (t1.kind !== 'tool' || t2.kind !== 'tool') return;
    expect(t1.row.plan).toMatchObject({
      plan: [
        { step: '搜索', status: 'in_progress' },
        { step: '写作', status: 'pending' },
      ],
      running: false,
    });
    expect(t2.row.plan).toBeUndefined();
  });

  it('tool.end args 非法 → 保留已有 plan 仅收口', () => {
    // end 事件不携带计划数据源(SDK 生产形状不带 args),args 非法不销毁
    // start 已解析并展示的计划,只把 running 收口为 false。
    const rows = groupChatEvents([
      toolStart('update_plan', 'call-P', 'ts1', planArgs),
      toolEnd('call-P', true, 'te1', { plan: [{ step: '缺 status' }] }, 'update_plan'),
    ]);
    const tool = rows[0];
    if (tool.kind !== 'tool') return;
    expect(tool.row.plan).toMatchObject({
      plan: [
        { step: '搜索', status: 'in_progress' },
        { step: '写作', status: 'pending' },
      ],
      running: false,
    });
  });

  it('tool.start 带合法 args → tool.end 无 args(生产形状)→ plan 保留且 running:false', () => {
    // 回归:F1——SDK 生产路径 tool.end 不发射 args,start 已落定的计划卡
    // 不得在收口时被销毁成 null(修复前该用例变红)。
    const rows = groupChatEvents([
      toolStart('update_plan', 'call-P', 'ts1', planArgs),
      toolEnd('call-P', true, 'te1', undefined, 'update_plan'),
    ]);
    const tool = rows[0];
    if (tool.kind !== 'tool') return;
    expect(tool.row.plan).toMatchObject({
      plan: [
        { step: '搜索', status: 'in_progress' },
        { step: '写作', status: 'pending' },
      ],
      running: false,
    });
  });
});

describe('groupChatEvents thinking durationMs', () => {
  it('final 与首个 partial 的时间差', () => {
    const rows = groupChatEvents([
      thinkingPartial('m1', '先想', 'e1', 1000),
      thinkingFinal('m1', '想完', 'e2', undefined, 3000),
    ]);
    const thinking = rows[0];
    if (thinking.kind !== 'thinking') return;
    expect(thinking.row.durationMs).toBe(2000);
  });

  it('只有 final 无 partial → durationMs 为 0(final 与自身 ts 之差)', () => {
    const rows = groupChatEvents([thinkingFinal('m1', '想完', 'e1', undefined, 5000)]);
    const thinking = rows[0];
    if (thinking.kind !== 'thinking') return;
    expect(thinking.row.durationMs).toBe(0);
  });

  it('reducer 折叠路径:仅 final 在场 + 外部锚点 → durationMs 用锚点', () => {
    // 真实 App 路径:events 只含 thinking.final(partial 被 reducer 折叠),
    // 首个 partial 的 ts 经 thinkingFirstTs 参数传入(键 = messageId:segmentIndex)。
    const rows = groupChatEvents(
      [
        thinkingFinal('m1', '想完', 'e1', undefined, 35000),
        toolStart('read', 'c1', 'e2', undefined, 50000),
        toolEnd('c1', true, 'e3', undefined, 'read', 206000),
      ],
      { 'm1:0': 1000 },
    );
    const thinking = rows[0];
    if (thinking.kind !== 'thinking') return;
    expect(thinking.row.durationMs).toBe(34000);
  });

  it('同 messageId 多段思考 → 各自成行,不拼接', () => {
    const rows = groupChatEvents([
      { ...thinkingPartial('m1', '段一', 'e1', 1000), segmentIndex: 0 } as AgentEvent,
      { ...thinkingFinal('m1', '段一完整', 'e2', undefined, 2000), segmentIndex: 0 } as AgentEvent,
      { ...thinkingPartial('m1', '段二', 'e3', 3000), segmentIndex: 1 } as AgentEvent,
      { ...thinkingFinal('m1', '段二完整', 'e4', undefined, 4000), segmentIndex: 1 } as AgentEvent,
    ]);
    expect(kinds(rows)).toEqual(['thinking', 'thinking']);
    const t1 = rows[0];
    const t2 = rows[1];
    if (t1.kind !== 'thinking' || t2.kind !== 'thinking') return;
    expect([
      [t1.row.segmentIndex, t1.row.thinking, t1.row.durationMs],
      [t2.row.segmentIndex, t2.row.thinking, t2.row.durationMs],
    ]).toEqual([
      [0, '段一完整', 1000],
      [1, '段二完整', 1000],
    ]);
  });

  it('分段事件(带 segmentIndex)与旧式单段事件并存时互不覆盖', () => {
    const rows = groupChatEvents([
      { ...thinkingPartial('m1', '段0', 'e1', 1000), segmentIndex: 0 } as AgentEvent,
      { ...thinkingFinal('m1', '段0完', 'e2', undefined, 2000), segmentIndex: 0 } as AgentEvent,
      { ...thinkingPartial('m1', '段1', 'e3', 3000), segmentIndex: 1 } as AgentEvent,
      { ...thinkingFinal('m1', '段1完', 'e4', undefined, 4000), segmentIndex: 1 } as AgentEvent,
      thinkingFinal('m2', '旧式单段', 'e5', undefined, 5000),
    ]);
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => {
      if (r.kind === 'thinking') return `${r.row.messageId}:${r.row.segmentIndex}`;
      return '';
    });
    expect(ids).toEqual(['m1:0', 'm1:1', 'm2:0']);
  });
});

describe('groupChatEvents 空输入', () => {
  it('空事件流 → 空行模型', () => {
    expect(groupChatEvents([])).toEqual([]);
  });
});

describe('groupChatEvents turn-marker', () => {
  it('user → thinking.final:marker 紧跟 user 行,耗时为回合内最大 ts 差', () => {
    const rows = groupChatEvents([
      messageEvent('message.final', 'user', '问题', 'evt-user', 1000),
      thinkingFinal('m1', '想', 't1', undefined, 3000),
    ]);
    expect(kinds(rows)).toEqual(['message', 'turn-marker', 'thinking']);
    // user 行在前、marker 紧随其后、thinking 在后
    expect(rows[0]).toMatchObject({ kind: 'message' });
    expect(rows[1]).toEqual({
      kind: 'turn-marker',
      key: 'turn-marker:evt-user',
      durationMs: 2000,
    });
    expect(rows[2]).toMatchObject({ kind: 'thinking' });
  });

  it('耗时不足 1 秒 → 不插 marker', () => {
    const rows = groupChatEvents([
      messageEvent('message.final', 'user', '问题', 'evt-user', 1000),
      thinkingFinal('m1', '想', 't1', undefined, 1500),
    ]);
    expect(kinds(rows)).toEqual(['message', 'thinking']);
  });

  it('仅 user 消息、无后续事件 → 无 marker', () => {
    const rows = groupChatEvents([messageEvent('message.final', 'user', '问题', 'evt-user', 1000)]);
    expect(kinds(rows)).toEqual(['message']);
  });

  it('两轮:每轮 user 后各插一个 marker,耗时为该轮到下一 user 的最大 ts 差', () => {
    const rows = groupChatEvents([
      messageEvent('message.final', 'user', '第一轮', 'evt-u1', 1000),
      toolStart('read', 'call-A', 'ts1', undefined, 4000),
      toolEnd('call-A', true, 'te1', undefined, 'read', 4000),
      messageEvent('message.final', 'user', '第二轮', 'evt-u2', 5000),
      toolEnd('call-A', true, 'te2', undefined, 'read', 6000),
    ]);
    expect(kinds(rows)).toEqual([
      'message',
      'turn-marker',
      'tool',
      'message',
      'turn-marker',
      'tool',
    ]);
    expect(rows[1]).toEqual({
      kind: 'turn-marker',
      key: 'turn-marker:evt-u1',
      durationMs: 3000,
    });
    expect(rows[4]).toEqual({
      kind: 'turn-marker',
      key: 'turn-marker:evt-u2',
      durationMs: 1000,
    });
  });

  it('流尾 turn:user 后无下一 user,流结束时 marker 仍落行', () => {
    const rows = groupChatEvents([
      messageEvent('message.final', 'user', '问题', 'evt-user', 1000),
      thinkingFinal('m1', '想', 't1', undefined, 3000),
    ]);
    const markers = rows.filter((r) => r.kind === 'turn-marker');
    expect(markers).toHaveLength(1);
    if (markers[0].kind !== 'turn-marker') return;
    expect(markers[0].durationMs).toBe(2000);
  });
});
