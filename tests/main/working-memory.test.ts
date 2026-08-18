import { describe, expect, it } from 'vitest';
import { WorkingMemoryStore } from '../../src/main/memory/working-memory';

describe('WorkingMemoryStore', () => {
  it('从用户/助手/工具事件提炼 working memory 上下文', () => {
    const store = new WorkingMemoryStore();
    store.applyEvent({
      type: 'message.final',
      sessionId: 'sid',
      eventId: 'evt-1',
      seq: 1,
      ts: 1,
      role: 'user',
      messageId: 'u1',
      content: {
        text: '这轮目标是把记忆系统做成分层。必须复用现有 MemoryStore。不要引入 Python。',
      },
    });
    store.applyEvent({
      type: 'message.final',
      sessionId: 'sid',
      eventId: 'evt-2',
      seq: 2,
      ts: 2,
      role: 'assistant',
      messageId: 'a1',
      content: {
        text: '决定先做 working memory，再接 retrieval planner。',
      },
    });
    store.applyEvent({
      type: 'tool.start',
      sessionId: 'sid',
      eventId: 'evt-3',
      seq: 3,
      ts: 3,
      toolName: 'edit',
      target: 'src/main/memory/working-memory.ts',
    });
    store.applyEvent({
      type: 'memory.recorded',
      sessionId: 'sid',
      eventId: 'evt-4',
      seq: 4,
      ts: 4,
      entryId: 'm1',
      title: '分层记忆决策',
      kind: 'knowledge',
      evidence: 'extracted',
    });

    const context = store.buildContext('sid');

    expect(context).toContain('[goal] 这轮目标是把记忆系统做成分层。');
    expect(context).toContain('[constraints]');
    expect(context).toContain('必须复用现有 MemoryStore。');
    expect(context).toContain('不要引入 Python。');
    expect(context).toContain('[open_loops] edit: src/main/memory/working-memory.ts');
    expect(context).toContain(
      '[recent_decisions] 决定先做 working memory，再接 retrieval planner。',
    );
    expect(context).toContain('[pending_facts] knowledge: 分层记忆决策');
  });

  it('工具结束后移除 open loop，并把更正语句收进 recent corrections', () => {
    const store = new WorkingMemoryStore();
    store.applyEvent({
      type: 'tool.start',
      sessionId: 'sid',
      eventId: 'evt-5',
      seq: 1,
      ts: 1,
      toolName: 'write',
      target: 'notes.md',
    });
    store.applyEvent({
      type: 'message.final',
      sessionId: 'sid',
      eventId: 'evt-6',
      seq: 2,
      ts: 2,
      role: 'user',
      messageId: 'u2',
      content: {
        text: '更正一下，不是做云同步，改成只做本地 working memory。',
      },
    });
    store.applyEvent({
      type: 'tool.end',
      sessionId: 'sid',
      eventId: 'evt-7',
      seq: 3,
      ts: 3,
      toolName: 'write',
      target: 'notes.md',
      result: 'ok',
      ok: true,
    });

    const context = store.buildContext('sid');

    expect(context).toContain(
      '[recent_corrections] 更正一下，不是做云同步，改成只做本地 working memory。',
    );
    expect(context).not.toContain('[open_loops]');
  });

  it('compact 只做轻量收束，不丢 goal', () => {
    const store = new WorkingMemoryStore();
    store.applyEvent({
      type: 'message.final',
      sessionId: 'sid',
      eventId: 'evt-8',
      seq: 1,
      ts: 1,
      role: 'user',
      messageId: 'u3',
      content: { text: '目标：把当前会话状态保留下来。' },
    });

    store.markCompacted('sid');

    expect(store.getSnapshot('sid')?.lastCompactedAt).toBeTypeOf('number');
    expect(store.buildContext('sid')).toContain('把当前会话状态保留下来');
  });
});
