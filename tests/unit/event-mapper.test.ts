import type { Message as AgentMessage } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  EventMapper,
  extractMessageText,
  extractThinkingSegments,
} from '../../src/main/pi-sdk-driver/event-mapper';
import { groupChatEvents } from '../../src/renderer/lib/chat-groups';
import type { AgentEvent } from '../../src/shared/agent-events';

function makeMapper(emit?: (event: AgentEvent) => void): EventMapper {
  let seq = 0;
  return new EventMapper({
    sessionId: 'sid',
    nextSeq: () => ++seq,
    toMessageContent: (msg) => {
      const rawRole = msg && typeof msg === 'object' ? (msg as { role?: unknown }).role : undefined;
      const role =
        rawRole === 'user' || rawRole === 'toolResult' || rawRole === 'assistant'
          ? rawRole
          : 'other';
      return {
        role,
        content: { text: extractMessageText(msg) },
      };
    },
    toMessageThinkingSegments: (msg) => {
      const content =
        msg && typeof msg === 'object' && 'content' in msg
          ? (msg as { content?: unknown }).content
          : msg;
      return extractThinkingSegments(content);
    },
    toToolTarget: (_toolName, input) => {
      if (input && typeof input === 'object' && 'path' in (input as object)) {
        return String((input as { path?: unknown }).path ?? '');
      }
      return 'tool';
    },
    emit,
  });
}

describe('EventMapper.replayFromMessages', () => {
  it('user message → message.final user with text content', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      { role: 'user', content: [{ type: 'text', text: '你好' }] } as unknown as AgentMessage,
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 'sid',
      type: 'message.final',
      role: 'user',
      content: { text: '你好' },
      seq: 1,
      eventId: expect.stringMatching(/./),
      ts: expect.any(Number),
    });
  });

  it('assistant with text block → message.final assistant', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [{ type: 'text', text: '好啊' }],
      } as unknown as AgentMessage,
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message.final',
      role: 'assistant',
      content: { text: '好啊' },
    });
  });

  it('assistant with toolUse block → tool.start + toolResult → tool.end pair', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolUse',
            id: 'call-1',
            name: 'read',
            input: { path: '/workspace/x.ts' },
          },
        ],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
      } as unknown as AgentMessage,
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'tool.start',
      toolName: 'read',
      callId: 'call-1',
      target: '/workspace/x.ts',
    });
    expect(events[1]).toMatchObject({
      type: 'tool.end',
      toolName: 'read',
      callId: 'call-1',
      result: 'file body',
      ok: true,
    });
  });

  it('multi-text assistant content joined with newlines', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      } as unknown as AgentMessage,
    ]);
    expect(events[0]).toMatchObject({
      type: 'message.final',
      content: { text: 'first\nsecond' },
    });
  });

  it('filters out internal message types (bashExecution / compaction / custom)', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'bashExecution',
        command: 'ls',
        output: '',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
      {
        role: 'compactionSummary',
        summary: 'old',
        tokensBefore: 100,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
      {
        role: 'user',
        content: [{ type: 'text', text: 'visible' }],
      } as unknown as AgentMessage,
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'message.final', content: { text: 'visible' } });
  });

  it('empty input → zero events (no spurious filler)', () => {
    const mapper = makeMapper();
    expect(mapper.replayFromMessages([])).toEqual([]);
  });

  it('seq monotonically increases within one batch', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      { role: 'user', content: 'a' } as unknown as AgentMessage,
      { role: 'assistant', content: 'b' } as unknown as AgentMessage,
      { role: 'user', content: 'c' } as unknown as AgentMessage,
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('消息自带 timestamp → 重放事件 ts 用消息时间戳(F2 回归)', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: '你好' }],
        timestamp: 1_700_000_000_000,
      } as unknown as AgentMessage,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'toolUse', id: 'call-1', name: 'read', input: { path: '/a.ts' } },
        ],
        timestamp: 1_700_000_005_000,
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'body' }],
        timestamp: 1_700_000_010_000,
      } as unknown as AgentMessage,
    ]);
    // user / tool.start(块序) / message.final / tool.end
    expect(events).toHaveLength(4);
    const [userMsg, toolStart, assistantMsg, toolEnd] = events as Array<
      AgentEvent & { ts: number }
    >;
    expect(userMsg).toMatchObject({ type: 'message.final', role: 'user' });
    expect(userMsg.ts).toBe(1_700_000_000_000);
    expect(toolStart.type).toBe('tool.start');
    expect(toolStart.ts).toBe(1_700_000_005_000);
    expect(assistantMsg).toMatchObject({ type: 'message.final', role: 'assistant' });
    expect(assistantMsg.ts).toBe(1_700_000_005_000);
    expect(toolEnd.type).toBe('tool.end');
    expect(toolEnd.ts).toBe(1_700_000_010_000);
  });

  it('无 timestamp 的消息 → 事件 ts 回退为正常数(非 NaN)', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }] } as unknown as AgentMessage,
    ]);
    expect(events).toHaveLength(1);
    expect(Number.isFinite((events[0] as { ts: number }).ts)).toBe(true);
  });

  it('重放事件带真实时间戳 → turn-marker 恢复显示(F2 集成)', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: '你好' }],
        timestamp: 1_700_000_000_000,
      } as unknown as AgentMessage,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'toolUse', id: 'call-1', name: 'read', input: { path: '/a.ts' } },
        ],
        timestamp: 1_700_000_005_000,
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'body' }],
        timestamp: 1_700_000_010_000,
      } as unknown as AgentMessage,
    ]);
    const rows = groupChatEvents(events);
    const marker = rows.find((r) => r.kind === 'turn-marker');
    expect(marker).toBeDefined();
    if (marker && marker.kind === 'turn-marker') {
      // user(1.7e12) 与 toolResult(1.70000001e12) 跨度
      expect(marker.durationMs).toBe(10_000);
    }
  });
  it('live assistant events extract SDK content and keep one stream identity', () => {
    const mapper = makeMapper();
    const message = (text: string) =>
      ({ role: 'assistant', content: [{ type: 'text', text }] }) as unknown as AgentMessage;

    const start = mapper.map({
      type: 'message_start',
      message: message('首'),
    } as unknown as AgentSessionEvent);
    const update = mapper.map({
      type: 'message_update',
      message: message('首段完整'),
    } as unknown as AgentSessionEvent);
    const end = mapper.map({
      type: 'message_end',
      message: message('最终答案'),
    } as unknown as AgentSessionEvent);

    expect(start).toMatchObject({ type: 'message.partial', content: { text: '首' } });
    expect(update).toMatchObject({ type: 'message.partial', content: { text: '首段完整' } });
    expect(end).toMatchObject({ type: 'message.final', content: { text: '最终答案' } });

    const ids = [start, update, end].map((event) => (event as { messageId?: string }).messageId);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(1);
  });

  it('每次 replay 的消息拥有独立 messageId', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      { role: 'user', content: 'a' } as unknown as AgentMessage,
      { role: 'assistant', content: 'b' } as unknown as AgentMessage,
    ]);

    const ids = events.map((event) => (event as { messageId?: string }).messageId);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('maps SDK user start/end events to one final message identity', () => {
    const mapper = makeMapper();
    const message = {
      role: 'user',
      content: [{ type: 'text', text: '我的问题' }],
    } as unknown as AgentMessage;
    const start = mapper.map({ type: 'message_start', message } as unknown as AgentSessionEvent);
    const end = mapper.map({ type: 'message_end', message } as unknown as AgentSessionEvent);

    expect(start).toMatchObject({
      type: 'message.final',
      role: 'user',
      content: { text: '我的问题' },
    });
    expect(end).toMatchObject({ type: 'message.final', role: 'user' });
    expect((start as { messageId: string }).messageId).toBe(
      (end as { messageId: string }).messageId,
    );
  });

  it('drops toolResult message events instead of rendering them as chat bubbles', () => {
    const mapper = makeMapper();
    const message = {
      role: 'toolResult',
      content: [{ type: 'text', text: '工具输出' }],
    } as unknown as AgentMessage;

    expect(
      mapper.map({ type: 'message_start', message } as unknown as AgentSessionEvent),
    ).toBeNull();
    expect(mapper.map({ type: 'message_end', message } as unknown as AgentSessionEvent)).toBeNull();
  });

  it('does not emit empty assistant bubbles', () => {
    const mapper = makeMapper();
    const message = { role: 'assistant', content: [] } as unknown as AgentMessage;

    expect(
      mapper.map({ type: 'message_start', message } as unknown as AgentSessionEvent),
    ).toBeNull();
    expect(mapper.map({ type: 'message_end', message } as unknown as AgentSessionEvent)).toBeNull();
  });

  it('live assistant thinking → thinking.partial + thinking.final correlated to messageId', () => {
    const emitted: AgentEvent[] = [];
    const mapper = makeMapper((e) => emitted.push(e));
    const msg = (thinking: string, text: string) =>
      ({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking },
          { type: 'text', text },
        ],
      }) as unknown as AgentMessage;

    mapper.map({ type: 'message_start', message: msg('思', '首') } as unknown as AgentSessionEvent);
    mapper.map({
      type: 'message_update',
      message: msg('思考完整', '首段'),
    } as unknown as AgentSessionEvent);
    // Text-only update with unchanged thinking → must NOT emit a duplicate partial.
    mapper.map({
      type: 'message_update',
      message: msg('思考完整', '首段完整'),
    } as unknown as AgentSessionEvent);
    const messageFinal = mapper.map({
      type: 'message_end',
      message: msg('最终思考', '最终答案'),
    } as unknown as AgentSessionEvent) as unknown as { messageId?: string; seq: number };

    const partials = emitted.filter((e) => e.type === 'thinking.partial');
    const final = emitted.find((e) => e.type === 'thinking.final');
    expect(partials).toHaveLength(2);
    expect(partials[0]).toMatchObject({
      type: 'thinking.partial',
      role: 'assistant',
      content: { thinking: '思' },
    });
    expect(partials[1]).toMatchObject({ content: { thinking: '思考完整' } });
    expect(final).toMatchObject({
      type: 'thinking.final',
      role: 'assistant',
      content: { thinking: '最终思考' },
    });

    // All thinking events share the assistant message's messageId.
    for (const t of emitted) {
      if (t.type === 'thinking.partial' || t.type === 'thinking.final') {
        expect(t.messageId).toBe(messageFinal.messageId);
      }
    }
    // seq stays monotonic in emission order (thinking events then message event).
    const seqs = [...emitted.map((e) => e.seq), messageFinal.seq as number];
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('multiple thinking blocks → per-segment partial/final with block boundaries preserved', () => {
    const emitted: AgentEvent[] = [];
    const mapper = makeMapper((e) => emitted.push(e));
    const msg = (segments: string[], text: string) =>
      ({
        role: 'assistant',
        content: [
          ...segments.map((s) => ({ type: 'thinking', thinking: s })),
          { type: 'text', text },
        ],
      }) as unknown as AgentMessage;

    // 两块思考:段 0 增长、段 1 出现——各段独立流式,不互相拼接。
    mapper.map({
      type: 'message_update',
      message: msg(['第一段想', ''], ''),
    } as unknown as AgentSessionEvent);
    mapper.map({
      type: 'message_update',
      message: msg(['第一段想', '第二段想'], ''),
    } as unknown as AgentSessionEvent);
    mapper.map({
      type: 'message_update',
      message: msg(['第一段想完整', '第二段想'], ''),
    } as unknown as AgentSessionEvent);
    mapper.map({
      type: 'message_end',
      message: msg(['第一段想完整', '第二段想完整'], '答案'),
    } as unknown as AgentSessionEvent);

    const partials = emitted.filter((e) => e.type === 'thinking.partial');
    const finals = emitted.filter((e) => e.type === 'thinking.final');
    // 段 0:2 次增长;段 1:1 次增长 → 3 条 partial。
    // 顺序 = SDK 累积文本的真实增长序(段 1 在段 0 补充前出现是合法流序)。
    expect(partials).toHaveLength(3);
    expect(partials.map((p) => [p.segmentIndex, p.content.thinking])).toEqual([
      [0, '第一段想'],
      [1, '第二段想'],
      [0, '第一段想完整'],
    ]);
    // 两段 final,块边界保真(每段独立文本,不拼接)
    expect(finals).toHaveLength(2);
    expect(finals.map((f) => [f.segmentIndex, f.segmentCount, f.content.thinking])).toEqual([
      [0, 2, '第一段想完整'],
      [1, 2, '第二段想完整'],
    ]);
  });

  it('replayFromMessages with multiple thinking blocks → per-segment thinking.final', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先想想' },
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/x.ts' } },
          { type: 'thinking', thinking: '再想想' },
          { type: 'text', text: '答案' },
        ],
      } as unknown as AgentMessage,
    ]);

    const finals = events.filter((e) => e.type === 'thinking.final');
    expect(finals.map((f) => [f.segmentIndex, f.segmentCount, f.content.thinking])).toEqual([
      [0, 2, '先想想'],
      [1, 2, '再想想'],
    ]);
  });

  it('tool_execution_start / tool_execution_update pass raw args through', () => {
    const mapper = makeMapper();
    const start = mapper.map({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: '/workspace/x.ts', startLine: 3 },
    } as unknown as AgentSessionEvent);
    const update = mapper.map({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' },
      partialResult: 'partial',
    } as unknown as AgentSessionEvent);

    expect(start).toMatchObject({
      type: 'tool.start',
      toolName: 'read',
      callId: 'call-1',
      target: '/workspace/x.ts',
      args: { path: '/workspace/x.ts', startLine: 3 },
    });
    expect(update).toMatchObject({
      type: 'tool.update',
      toolName: 'bash',
      args: { command: 'ls' },
    });
  });

  it('replayFromMessages emits thinking.final for historical thinking blocks', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先想想' },
          { type: 'text', text: '答案' },
        ],
      } as unknown as AgentMessage,
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'thinking.final',
      role: 'assistant',
      content: { thinking: '先想想' },
    });
    expect(events[1]).toMatchObject({
      type: 'message.final',
      role: 'assistant',
      content: { text: '答案' },
    });
    expect((events[0] as { messageId?: string }).messageId).toBe(
      (events[1] as { messageId?: string }).messageId,
    );
  });

  it('重放保序:thinking/toolCall 按块数组原始顺序交错发射,文本收尾(M1 回归)', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想1' },
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/x.ts' } },
          { type: 'thinking', thinking: '想2' },
          { type: 'text', text: '答案' },
        ],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'c1',
        toolName: 'read',
        content: [{ type: 'text', text: 'body' }],
        isError: false,
      } as unknown as AgentMessage,
    ]);
    expect(events.map((e) => e.type)).toEqual([
      'thinking.final',
      'tool.start',
      'thinking.final',
      'message.final',
      'tool.end',
    ]);
    // 段序号按 thinking 块出现序
    const finals = events.filter((e) => e.type === 'thinking.final');
    expect(finals.map((f) => [f.segmentIndex, f.content.thinking])).toEqual([
      [0, '想1'],
      [1, '想2'],
    ]);
    // 工具调用在消息中位置保真:tool.start 早于 message.final
    const toolStartIdx = events.findIndex((e) => e.type === 'tool.start');
    const msgFinalIdx = events.findIndex((e) => e.type === 'message.final');
    expect(toolStartIdx).toBeGreaterThanOrEqual(0);
    expect(msgFinalIdx).toBeGreaterThanOrEqual(0);
    expect(toolStartIdx).toBeLessThan(msgFinalIdx);
  });

  it('重放路径:isError + 拦截前缀 → tool.blocked 而非 tool.end(M2 回归)', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolUse',
            id: 'call-b',
            name: 'write',
            input: { path: '/etc/passwd' },
          },
        ],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'call-b',
        toolName: 'write',
        content: [{ type: 'text', text: 'approval-required: 写入位置在工作区外' }],
        isError: true,
      } as unknown as AgentMessage,
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'tool.start', callId: 'call-b' });
    expect(events[1]).toMatchObject({
      type: 'tool.blocked',
      callId: 'call-b',
      safetyNote: 'approval-required: 写入位置在工作区外',
    });
  });

  it('重放路径:普通 error → 仍为 tool.end ok:false(blocked 不误伤)', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolUse',
            id: 'call-x',
            name: 'bash',
            input: { command: 'ls' },
          },
        ],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'call-x',
        toolName: 'bash',
        content: [{ type: 'text', text: 'command not found' }],
        isError: true,
      } as unknown as AgentMessage,
    ]);
    expect(events[1]).toMatchObject({ type: 'tool.end', ok: false, result: 'command not found' });
  });

  it('重放路径:持久化消息 id → messageId 稳定(重复打开去重,M3 回归)', () => {
    const mapper = makeMapper();
    const userMsg = {
      id: 'msg-42',
      role: 'user',
      content: [{ type: 'text', text: '你好' }],
    } as unknown as AgentMessage;
    const assistantMsg = {
      id: 'msg-43',
      role: 'assistant',
      content: [{ type: 'text', text: '好的' }],
    } as unknown as AgentMessage;
    // 两次独立 replay(模拟重复打开会话)→ 同 id 消息 messageId 相同
    const first = mapper.replayFromMessages([userMsg, assistantMsg]);
    const second = mapper.replayFromMessages([userMsg, assistantMsg]);
    expect(first[0]).toMatchObject({ type: 'message.final', role: 'user', messageId: 'msg-42' });
    expect(first[1]).toMatchObject({
      type: 'message.final',
      role: 'assistant',
      messageId: 'msg-43',
    });
    expect(first.map((e) => (e as { messageId?: string }).messageId)).toEqual(
      second.map((e) => (e as { messageId?: string }).messageId),
    );
  });
});

// ---------------------------------------------------------------------------
// 实时工具结果提取(2026-08-07 修复):tool_execution_end.result 是
// AgentToolResult 对象而非字符串——edit diff 在 details.diff,其余在 content。
// ---------------------------------------------------------------------------

describe('EventMapper.map 实时工具结果', () => {
  it('edit 的 AgentToolResult 对象 → result 提取 details.diff 文本', () => {
    const mapper = makeMapper();
    const event = mapper.map({
      type: 'tool_execution_end',
      toolCallId: 'call-e1',
      toolName: 'edit',
      result: {
        content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.md.' }],
        details: {
          diff: '1 2 3\n- old line\n+ new line\n',
          patch: '--- a/a.md\n+++ b/a.md\n',
        },
      },
      isError: false,
    } as unknown as AgentSessionEvent);
    expect(event).toMatchObject({
      type: 'tool.end',
      toolName: 'edit',
      callId: 'call-e1',
      ok: true,
      result: '1 2 3\n- old line\n+ new line\n',
    });
  });

  it('read 的 AgentToolResult 对象 → result 提取 content 文本', () => {
    const mapper = makeMapper();
    const event = mapper.map({
      type: 'tool_execution_end',
      toolCallId: 'call-r1',
      toolName: 'read',
      result: {
        content: [{ type: 'text', text: 'file body line 1\nfile body line 2' }],
        details: undefined,
      },
      isError: false,
    } as unknown as AgentSessionEvent);
    expect(event).toMatchObject({
      type: 'tool.end',
      toolName: 'read',
      result: 'file body line 1\nfile body line 2',
    });
  });

  it('字符串 result 直通(兼容)', () => {
    const mapper = makeMapper();
    const event = mapper.map({
      type: 'tool_execution_end',
      toolCallId: 'call-s1',
      toolName: 'bash',
      result: 'plain text result',
      isError: false,
    } as unknown as AgentSessionEvent);
    expect(event).toMatchObject({ type: 'tool.end', result: 'plain text result' });
  });

  it('target 从 tool_execution_start 的 args 提取(而非 result 对象)', () => {
    const mapper = makeMapper();
    mapper.map({
      type: 'tool_execution_start',
      toolCallId: 'call-t1',
      toolName: 'edit',
      args: { path: '/workspace/a.md', edits: [] },
    } as unknown as AgentSessionEvent);
    const event = mapper.map({
      type: 'tool_execution_end',
      toolCallId: 'call-t1',
      toolName: 'edit',
      result: { content: [], details: { diff: 'diff' } },
      isError: false,
    } as unknown as AgentSessionEvent);
    expect(event).toMatchObject({ type: 'tool.end', target: '/workspace/a.md' });
  });

  it('被阻断结果(createErrorToolResult 对象)→ tool.blocked 检测恢复', () => {
    const mapper = makeMapper();
    const event = mapper.map({
      type: 'tool_execution_end',
      toolCallId: 'call-b1',
      toolName: 'write',
      result: {
        content: [{ type: 'text', text: 'approval-required: 写入位置在工作区外' }],
        details: {},
      },
      isError: true,
    } as unknown as AgentSessionEvent);
    expect(event).toMatchObject({
      type: 'tool.blocked',
      safetyNote: 'approval-required: 写入位置在工作区外',
    });
  });

  it('error 但非 blocked → tool.end ok:false', () => {
    const mapper = makeMapper();
    const event = mapper.map({
      type: 'tool_execution_end',
      toolCallId: 'call-x1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'command not found' }], details: {} },
      isError: true,
    } as unknown as AgentSessionEvent);
    expect(event).toMatchObject({ type: 'tool.end', ok: false, result: 'command not found' });
  });
});

// ---------------------------------------------------------------------------
// 重放路径修复(2026-08-07):toolResult 的 details.diff 要提取,target 从
// toolUse 调用参数取(而非从结果文本)。
// ---------------------------------------------------------------------------

describe('EventMapper.replayFromMessages 工具结果', () => {
  it('edit toolResult 带 details.diff → result 提取 diff 文本', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolUse',
            id: 'call-ed',
            name: 'edit',
            input: { path: '/workspace/a.md', edits: [] },
          },
        ],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'call-ed',
        toolName: 'edit',
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.md.' }],
        details: { diff: '- old line\n+ new line\n' },
        isError: false,
      } as unknown as AgentMessage,
    ]);
    const end = events.find((e) => e.type === 'tool.end');
    expect(end).toMatchObject({
      type: 'tool.end',
      toolName: 'edit',
      result: '- old line\n+ new line\n',
      target: '/workspace/a.md',
    });
  });

  it('read toolResult → result 取 content 文本,target 从 toolUse input', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [{ type: 'toolUse', id: 'call-rd', name: 'read', input: { path: '/w/b.ts' } }],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'call-rd',
        toolName: 'read',
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
      } as unknown as AgentMessage,
    ]);
    const end = events.find((e) => e.type === 'tool.end');
    expect(end).toMatchObject({ type: 'tool.end', result: 'file body', target: '/w/b.ts' });
  });
});

// ---------------------------------------------------------------------------
// 重放 toolCall 形状(2026-08-07):SDK 持久化块是 toolCall/arguments 而非
// toolUse/input——历史会话重放必须识别两种形状。
// ---------------------------------------------------------------------------

describe('EventMapper.replayFromMessages toolCall 形状', () => {
  it('toolCall/arguments 形状 → tool.start 行正常发出且 target 提取成功', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-tc',
            name: 'edit',
            arguments: { path: '/workspace/a.md', edits: [] },
          },
        ],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolUseId: 'call-tc',
        toolName: 'edit',
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s).' }],
        details: { diff: '- old\n+ new' },
        isError: false,
      } as unknown as AgentMessage,
    ]);
    const start = events.find((e) => e.type === 'tool.start');
    const end = events.find((e) => e.type === 'tool.end');
    expect(start).toMatchObject({
      type: 'tool.start',
      toolName: 'edit',
      target: '/workspace/a.md',
    });
    expect(end).toMatchObject({
      type: 'tool.end',
      result: '- old\n+ new',
      target: '/workspace/a.md',
    });
  });
});

// ---------------------------------------------------------------------------
// toolResult 字段名兼容(2026-08-07):JSONL 持久化用 toolCallId,历史实现用
// toolUseId——callId 必须对上才能与 tool.start 合并成一行。
// ---------------------------------------------------------------------------

describe('EventMapper.replayFromMessages toolCallId 字段', () => {
  it('toolCallId 形状 → tool.start/tool.end 同 callId 且 target 正确', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-abc',
            name: 'edit',
            arguments: { path: '/workspace/a.md', edits: [] },
          },
        ],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolCallId: 'call-abc',
        toolName: 'edit',
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s).' }],
        details: { diff: '- old\n+ new' },
        isError: false,
      } as unknown as AgentMessage,
    ]);
    const start = events.find((e) => e.type === 'tool.start');
    const end = events.find((e) => e.type === 'tool.end');
    expect(start).toMatchObject({ type: 'tool.start', callId: 'call-abc' });
    expect(end).toMatchObject({
      type: 'tool.end',
      callId: 'call-abc',
      target: '/workspace/a.md',
      result: '- old\n+ new',
    });
  });
});

// ---------------------------------------------------------------------------
// 重放路径显示卫生(2026-08-09 走查实证):replayFromMessages 的用户分支曾漏剥
// 召回注入块——历史会话重放时整块记忆+HTML 注释渲染进用户气泡(实时路径在
// toMessageContent 已剥,重放是独立分支,双路径都须剥)。
// ---------------------------------------------------------------------------

describe('EventMapper.replayFromMessages 显示卫生', () => {
  it('user 消息含召回注入块 → 重放剥离,只剩用户原文', () => {
    const mapper = makeMapper();
    const injected = `${'<!-- lorra-memory-recall:reference-only -->'}\n- [soft_preference] 宠物：橘猫糯米。(你明说的)\n${'<!-- lorra-memory-recall:reference-only -->'}\n\n我养了什么宠物？`;
    const events = mapper.replayFromMessages([
      { role: 'user', content: [{ type: 'text', text: injected }] } as unknown as AgentMessage,
    ]);
    expect(events[0]).toMatchObject({
      type: 'message.final',
      role: 'user',
      content: { text: '我养了什么宠物？' },
    });
  });

  it('user 消息无注入块 → 重放原样(零改动)', () => {
    const mapper = makeMapper();
    const events = mapper.replayFromMessages([
      { role: 'user', content: [{ type: 'text', text: '普通问题' }] } as unknown as AgentMessage,
    ]);
    expect(events[0]).toMatchObject({ content: { text: '普通问题' } });
  });
});
