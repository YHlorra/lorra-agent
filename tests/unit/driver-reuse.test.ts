import { describe, expect, it, vi } from 'vitest';
import { LorraDriver, type SessionPersistence } from '../../src/main/pi-sdk-driver/driver';

// driver.ts 静态依赖 memory/recall → shared-memory-store(node:sqlite TLA),
// jsdom client 测试图无法打包 node:sqlite,整模块 mock(同 driver.test.ts)。
vi.mock('../../src/main/memory/recall', () => ({
  RECALL_CONTEXT_MARKER: '<!-- lorra-memory-recall:reference-only -->',
  buildCoreProjection: vi.fn(() => ({
    text: '',
    workspaceIdentity: 'workspace',
    entryIds: [],
  })),
  buildCoreContext: vi.fn(() => ''),
  buildRecallContext: vi.fn(() => ''),
  stripRecallContext: (text: string) => text,
}));

vi.mock('../../src/main/memory/archival-resolver', () => ({
  resolveArchivalRecall: vi.fn(async () => null),
}));

/** 构造可注册的 SDK handle 桩:subscribe 记 listener,fileEntries 供重放。 */
function makeHandle(
  sessionId: string,
  fileEntries: Array<{ type: string; id?: string; message?: unknown }> = [],
) {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    sessionId,
    sessionManager: { fileEntries, sessionFile: '' },
    subscribe: vi.fn((callback: (event: unknown) => void) => {
      listeners.push(callback);
      return () => {
        const i = listeners.indexOf(callback);
        if (i !== -1) listeners.splice(i, 1);
      };
    }),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
  };
}

describe('LorraDriver 会话复用 (D5, session-reliability-multi-session)', () => {
  it('openSession 命中已注册会话 → 复用现有 handle,不二次 persistence.open', async () => {
    const h1 = makeHandle('s1');
    const open = vi.fn();
    const list = vi.fn();
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(h1),
      open,
      list,
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/ws', persistence });
    await driver.newSession();

    const result = await driver.openSession('s1');

    expect(result).toEqual({ sessionId: 's1' });
    expect(open).not.toHaveBeenCalled(); // 未二次建 handle
    expect(list).not.toHaveBeenCalled();
  });

  it('openSession 未注册会话 → 走现流程 persistence.open + register', async () => {
    const h1 = makeHandle('s1');
    const h2 = makeHandle('s2');
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(h1),
      list: vi.fn().mockResolvedValue([{ id: 's2', path: 'D:/jsonl2' }]),
      open: vi.fn().mockResolvedValue(h2),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/ws', persistence });
    await driver.newSession();

    const result = await driver.openSession('s2');

    expect(result).toEqual({ sessionId: 's2' });
    expect(persistence.open).toHaveBeenCalledWith('D:/jsonl2');
  });

  it('continueRecent 已有已注册会话 → 复用最近活跃者,不二次 build handle', async () => {
    const h1 = makeHandle('s1');
    const continueRecent = vi.fn();
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(h1),
      continueRecent,
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/ws', persistence });
    await driver.newSession();

    const result = await driver.continueRecent();

    expect(result).toEqual({ sessionId: 's1' });
    expect(continueRecent).not.toHaveBeenCalled();
  });

  it('continueRecent 无已注册会话 → 走现流程 persistence.continueRecent', async () => {
    const h3 = makeHandle('s3');
    const persistence = {
      continueRecent: vi.fn().mockResolvedValue(h3),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/ws', persistence });

    const result = await driver.continueRecent();

    expect(result).toEqual({ sessionId: 's3' });
    expect(persistence.continueRecent).toHaveBeenCalledWith('C:/ws');
  });

  it('复用后重放历史 + 实时事件正常(订阅替换不重复、不打断)', async () => {
    const events: unknown[] = [];
    const h1 = makeHandle('s1', [
      {
        type: 'message',
        id: 'm1',
        message: { role: 'user', content: [{ type: 'text', text: '历史消息' }] },
      },
    ]);
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(h1),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/ws', persistence });
    await driver.newSession();

    // 复用前挂 wc:replay 事件应到达渲染端(复用 = 切回工作区见后台进度)。
    driver.attachWebContents({
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => events.push(event),
    } as never);
    await driver.openSession('s1');

    // 历史消息经 replayFromMessages 重放为 message.final 事件。
    expect(
      events.some(
        (e) =>
          (e as { type?: string }).type === 'message.final' &&
          (e as { content?: { text?: string } }).content?.text === '历史消息',
      ),
    ).toBe(true);

    // 复用后实时发送仍正常:订阅已重接,事件继续流到 wc。
    await driver.send('s1', '新消息');
    expect(h1.prompt).toHaveBeenCalledTimes(1);
  });
});

describe('LorraDriver 并发归属 (D6, session-reliability-multi-session)', () => {
  it('requestApproval 显式 sessionId → 审批事件精确归属该会话,不挂到活跃会话', async () => {
    const events: unknown[] = [];
    const hA = makeHandle('A');
    const hB = makeHandle('B');
    const persistence = {
      createInMemory: vi.fn().mockResolvedValueOnce(hA).mockResolvedValueOnce(hB),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/ws', persistence });
    await driver.newSession(); // A
    await driver.newSession(); // B
    driver.attachWebContents({
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => events.push(event),
    } as never);

    // A 正忙(active),但拦截器显式注入 sessionId=B → 审批必须挂到 B。
    await driver.send('A', '任务');
    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'f.txt',
      reason: 'r',
      sessionId: 'B',
    });

    const reqEvent = events.find(
      (e) => (e as { type?: string }).type === 'tool.approval-requested',
    ) as { sessionId?: string; approvalId?: string };
    expect(reqEvent?.sessionId).toBe('B');

    await driver.respondApproval('B', reqEvent?.approvalId ?? '', 'deny');
    await expect(decision).resolves.toBe('deny');
  });

  it('requestApproval 缺 sessionId → 回退活跃会话归属(兼容旧调用方)', async () => {
    const events: unknown[] = [];
    const hA = makeHandle('A');
    const hB = makeHandle('B');
    const persistence = {
      createInMemory: vi.fn().mockResolvedValueOnce(hA).mockResolvedValueOnce(hB),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/ws', persistence });
    await driver.newSession(); // A
    await driver.newSession(); // B
    driver.attachWebContents({
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => events.push(event),
    } as never);

    await driver.send('A', '任务');
    const decision = driver.requestApproval({ toolName: 'write', target: 'f.txt', reason: 'r' });

    const reqEvent = events.find(
      (e) => (e as { type?: string }).type === 'tool.approval-requested',
    ) as { sessionId?: string; approvalId?: string };
    expect(reqEvent?.sessionId).toBe('A'); // 活跃会话 = A

    await driver.respondApproval('A', reqEvent?.approvalId ?? '', 'deny');
    await expect(decision).resolves.toBe('deny');
  });
});
