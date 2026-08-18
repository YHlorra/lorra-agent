import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LorraDriver, type SessionPersistence } from '../../src/main/pi-sdk-driver/driver';

// driver.ts 静态依赖 memory/recall → shared-memory-store(node:sqlite TLA),
// jsdom client 测试图无法打包 node:sqlite,整模块 mock(注入行为在
// driver-recall.test.ts 单独钉死;此处保持 send 原样转发)。
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

describe('LorraDriver 重放稳定 messageId(回归:切回会话不重复追加)', () => {
  // jsonl 真实形状:id 在 entry 层,message 对象内无 id(实测 10 个会话 589 条全如此)。
  function makeReplayDriver() {
    const events: Array<{ type: string; messageId?: string; role?: string }> = [];
    const handle = {
      sessionId: 'sid',
      sessionManager: {
        fileEntries: [
          { type: 'session', id: 'entry-session' },
          {
            type: 'message',
            id: 'entry-user-1',
            message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
          },
          {
            type: 'message',
            id: 'entry-asst-1',
            message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
          },
        ],
      },
      subscribe: vi.fn(() => () => undefined),
      prompt: vi.fn(async () => {}),
    };
    const persistence = {
      list: vi.fn().mockResolvedValue([{ id: 'sid', path: 'p' }]),
      open: vi.fn().mockResolvedValue(handle),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath: 'C:/workspace', persistence });
    driver.attachWebContents({
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) =>
        events.push(event as { type: string; messageId?: string; role?: string }),
    } as never);
    return { driver, events };
  }

  it('Given jsonl entry 层带 id When 重放 Then messageId 取 entry id(跨次打开稳定)', async () => {
    const { driver, events } = makeReplayDriver();
    await driver.openSession('sid');
    const userEvents = events.filter((e) => e.type === 'message.final' && e.role === 'user');
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].messageId).toBe('entry-user-1');
  });

  it('Given 同一会话二次打开 When 重放 Then 事件 messageId 与首次完全一致(reducer 可折叠)', async () => {
    const { driver, events } = makeReplayDriver();
    await driver.openSession('sid');
    const first = events.map((e) => ({ type: e.type, messageId: e.messageId }));
    expect(first.length).toBeGreaterThan(0);
    events.length = 0;
    await driver.openSession('sid');
    const second = events.map((e) => ({ type: e.type, messageId: e.messageId }));
    expect(second).toEqual(first);
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

describe('LorraDriver.send 粘贴图片 → 视觉块', () => {
  /** 1x1 像素合法 PNG(最小可解码文件字节)。 */
  const PNG_1PX_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  function makeWorkspace(): { dir: string; pngPath: string; relPath: string } {
    const dir = path.join(os.tmpdir(), `driver-img-${Math.random().toString(36).slice(2)}`);
    const relPath = `.lorra/attachments/paste-test.png`;
    const pngPath = path.join(dir, ...relPath.split('/'));
    return { dir, pngPath, relPath };
  }

  async function makeVisionDriver(workspacePath: string, modelInput: string[]) {
    const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
    const handle = {
      sessionId: 'sid',
      sessionManager: { fileEntries: [] },
      subscribe: vi.fn(() => () => undefined),
      prompt,
      model: { input: modelInput },
    };
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(handle),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({ workspacePath, persistence });
    await driver.newSession();
    return { driver, prompt };
  }

  it('Given 视觉模型 + 图片存在 When send 带 images Then prompt 以 options.images 传入图片视觉块', async () => {
    const ws = makeWorkspace();
    await mkdir(path.dirname(ws.pngPath), { recursive: true });
    await writeFile(ws.pngPath, Buffer.from(PNG_1PX_BASE64, 'base64'));
    try {
      const { driver, prompt } = await makeVisionDriver(ws.dir, ['text', 'image']);
      await driver.send('sid', '看图', [{ fileId: ws.relPath }]);

      expect(prompt).toHaveBeenCalledTimes(1);
      const firstCall = prompt.mock.calls[0] as
        | [string, { images: Array<{ type: string; data: string; mimeType: string }> | undefined }]
        | undefined;
      const [textArg, options] = firstCall ?? ['', { images: undefined }];
      const imageBlocks = options.images ?? [];
      expect(textArg).toContain('看图');
      expect(imageBlocks).toHaveLength(1);
      expect(imageBlocks[0]).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
      });
      expect(typeof imageBlocks[0].data).toBe('string');
      // base64 解码回 PNG 魔数,证明是真实图片字节而非空串。
      expect(Buffer.from(imageBlocks[0].data, 'base64')).not.toHaveLength(0);
    } finally {
      await rm(ws.dir, { recursive: true, force: true });
    }
  });

  it('Given 非视觉模型 When send 带 images Then prompt 不传 images(退化纯文本)', async () => {
    const ws = makeWorkspace();
    await mkdir(path.dirname(ws.pngPath), { recursive: true });
    await writeFile(ws.pngPath, Buffer.from(PNG_1PX_BASE64, 'base64'));
    try {
      const { driver, prompt } = await makeVisionDriver(ws.dir, ['text']);
      await driver.send('sid', '看图', [{ fileId: ws.relPath }]);

      expect(prompt).toHaveBeenCalledTimes(1);
      const options = prompt.mock.calls[0]?.[1] as { images: unknown[] | undefined } | undefined;
      expect(options?.images).toBeUndefined();
    } finally {
      await rm(ws.dir, { recursive: true, force: true });
    }
  });

  it('Given 模型能力未知(测试桩无 model) When send 带 images Then 不传 images(行为与旧版一致)', async () => {
    const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
    const handle = {
      sessionId: 'sid',
      sessionManager: { fileEntries: [] },
      subscribe: vi.fn(() => () => undefined),
      prompt,
    };
    const persistence = {
      createInMemory: vi.fn().mockResolvedValue(handle),
    } as unknown as SessionPersistence;
    const driver = new LorraDriver({
      workspacePath: os.tmpdir(),
      persistence,
    });
    await driver.newSession();

    await driver.send('sid', '你好', [{ fileId: '.lorra/attachments/none.png' }]);
    const options = prompt.mock.calls[0]?.[1] as { images: unknown[] | undefined } | undefined;
    expect(options?.images).toBeUndefined();
  });

  it('Given 视觉模型但图片文件缺失 When send 带 images Then fail-open:不阻塞发送、只发文本', async () => {
    const ws = makeWorkspace();
    const { driver, prompt } = await makeVisionDriver(ws.dir, ['text', 'image']);
    await expect(driver.send('sid', '看图', [{ fileId: ws.relPath }])).resolves.toEqual({
      accepted: true,
    });

    const options = prompt.mock.calls[0]?.[1] as { images: unknown[] | undefined } | undefined;
    expect(options?.images).toBeUndefined();
  });
});
