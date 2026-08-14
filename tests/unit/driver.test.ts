import { describe, expect, it, vi } from 'vitest';
import { LorraDriver, type SessionPersistence } from '../../src/main/pi-sdk-driver/driver';

// driver.ts 静态依赖 memory/recall → shared-memory-store(node:sqlite TLA),
// jsdom client 测试图无法打包 node:sqlite,整模块 mock(注入行为在
// driver-recall.test.ts 单独钉死;此处保持 send 原样转发)。
vi.mock('../../src/main/memory/recall', () => ({
  RECALL_CONTEXT_MARKER: '<!-- lorra-memory-recall:reference-only -->',
  buildRecallContext: vi.fn(() => ''),
  stripRecallContext: (text: string) => text,
}));

describe('LorraDriver.send', () => {
  it('maps SDK user events and assistant content without synthetic duplicates', async () => {
    const events: unknown[] = [];
    let listener: ((event: unknown) => void) | undefined;
    const prompt = vi.fn().mockImplementation(async () => {
      listener?.({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
      });
      listener?.({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
      });
      listener?.({
        type: 'message_start',
        message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
      });
    });
    const handle = {
      sessionId: 'sid',
      sessionManager: { fileEntries: [] },
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        listener = callback;
        return () => undefined;
      }),
      prompt,
    };
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(handle),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/workspace', persistence });

    driver.attachWebContents({
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => events.push(event),
    } as never);
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
    const userEvents = events.filter(
      (
        event,
      ): event is { type: string; role: string; messageId: string; content: { text: string } } =>
        Boolean(event) &&
        typeof event === 'object' &&
        (event as { type?: unknown }).type === 'message.final' &&
        (event as { role?: unknown }).role === 'user',
    );
    expect(userEvents).toHaveLength(2);
    expect(new Set(userEvents.map((event) => event.messageId)).size).toBe(1);
    expect(userEvents[0].content.text).toBe('你好');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message.partial',
        role: 'assistant',
        content: { text: '回答' },
      }),
    );
  });

  // 输入框即时清空契约(PM 2026-08-13):send = 投递受理,不得等待整轮回答结束。
  // 旧实现 await prompt 直到 agent 答完才 resolve,渲染端输入框被挂住整轮。
  it('Given prompt 长耗时 When send Then 立即返回 accepted 不等回合结束', async () => {
    let resolvePrompt: (() => void) | undefined;
    const promptPending = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    const prompt = vi.fn().mockReturnValue(promptPending);
    const handle = {
      sessionId: 'sid',
      sessionManager: { fileEntries: [] },
      subscribe: vi.fn(() => () => undefined),
      prompt,
    };
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(handle),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/workspace', persistence });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    // 回合仍在进行:send 已 resolve,prompt 尚未 settle。
    let promptSettled = false;
    void promptPending.then(() => {
      promptSettled = true;
    });
    await Promise.resolve();
    expect(promptSettled).toBe(false);
    resolvePrompt?.();
    await promptPending;
  });

  it('Given prompt 异步失败 When send Then 仍返回 accepted 并发 session.status errored 事件', async () => {
    const events: unknown[] = [];
    const prompt = vi.fn().mockRejectedValue(new Error('provider down'));
    const handle = {
      sessionId: 'sid',
      sessionManager: { fileEntries: [] },
      subscribe: vi.fn(() => () => undefined),
      prompt,
    };
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(handle),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/workspace', persistence });
    driver.attachWebContents({
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => events.push(event),
    } as never);
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });
    // catch 在 microtask 里跑:flush 一轮再断言。
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'session.status', status: 'errored' }),
      );
    });
  });
});

describe('LorraDriver.compact', () => {
  function makeDriver(compactImpl?: () => Promise<void>) {
    const compact = vi.fn(compactImpl ?? (async () => {}));
    const handle = {
      sessionId: 'sid',
      sessionManager: { fileEntries: [] },
      subscribe: vi.fn(() => () => undefined),
      prompt: vi.fn(async () => {}),
      compact,
    };
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(handle),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/workspace', persistence });
    return { driver, compact, handle };
  }

  it('Given 会话空闲 When compact Then 调用 AgentSession.compact 并返回 accepted', async () => {
    const { driver, compact } = makeDriver();
    await driver.newSession();

    await expect(driver.compact('sid')).resolves.toEqual({ accepted: true });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('Given 会话正在工作中 When compact Then 拒绝且不调用 AgentSession.compact', async () => {
    const { driver, compact } = makeDriver();
    await driver.newSession();
    await driver.send('sid', 'hello'); // 置为 streaming(registry 状态)

    await expect(driver.compact('sid')).resolves.toEqual({ accepted: false });
    expect(compact).not.toHaveBeenCalled();
  });

  it('Given 未知会话 When compact Then 抛错', async () => {
    const { driver, compact } = makeDriver();

    await expect(driver.compact('missing')).rejects.toThrow('session not found');
    expect(compact).not.toHaveBeenCalled();
  });

  it('Given AgentSession.compact 抛错 When compact Then 错误上抛给调用方', async () => {
    const { driver } = makeDriver(async () => {
      throw new Error('Nothing to compact');
    });
    await driver.newSession();

    await expect(driver.compact('sid')).rejects.toThrow('Nothing to compact');
  });
});
