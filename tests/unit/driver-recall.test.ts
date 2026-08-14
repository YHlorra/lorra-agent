import { describe, expect, it, vi } from 'vitest';
import { buildRecallContext, RECALL_CONTEXT_MARKER } from '../../src/main/memory/recall';
import { LorraDriver, type SessionPersistence } from '../../src/main/pi-sdk-driver/driver';

// 会话启动召回注入挂点(design 6.6):
// send 仅在该会话尚无任何用户消息(新会话/首次发送)时注入记忆块;
// 历史会话已有消息不注入(避免重复污染);召回为空/失败 → 原样发送。
//
// recall 模块整体 mock:注入挂点的职责是「何时拼、拼什么、失败不阻断」,
// 召回内容的组装在 tests/main/recall.test.ts 单独钉死。

vi.mock('../../src/main/memory/recall', () => ({
  RECALL_CONTEXT_MARKER: '<!-- lorra-memory-recall:reference-only -->',
  buildRecallContext: vi.fn(() => ''),
  stripRecallContext: (text: string) => text,
}));

function makeHandle(fileEntries: unknown[] = [], messages: unknown[] = []) {
  return {
    sessionId: 'sid',
    sessionManager: { fileEntries },
    messages,
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => {}),
  };
}

function makePersistence(handle: ReturnType<typeof makeHandle>): SessionPersistence {
  return {
    createInMemory: vi.fn().mockResolvedValue(handle),
  } as unknown as SessionPersistence;
}

describe('LorraDriver.send 记忆召回注入(design 6.6)', () => {
  beforeEach(() => {
    vi.mocked(buildRecallContext).mockReset();
    vi.mocked(buildRecallContext).mockReturnValue('');
  });

  it('新会话首次 send → prompt 文本含记忆块 marker(召回块 + \\n\\n + 用户文本)', async () => {
    vi.mocked(buildRecallContext).mockReturnValue('- [working_context] 标题：内容(观察)');
    const handle = makeHandle();
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(buildRecallContext).toHaveBeenCalledWith({ workspace: 'C:/workspace' });
    expect(handle.prompt).toHaveBeenCalledWith(
      `${RECALL_CONTEXT_MARKER}\n- [working_context] 标题：内容(观察)\n${RECALL_CONTEXT_MARKER}\n\n你好`,
      { streamingBehavior: 'followUp' },
    );
  });

  it('已有消息的历史会话(attach 已 replay 的 fileEntries 含 user 消息)send → 无注入', async () => {
    const handle = makeHandle([
      { type: 'session', id: 'h' },
      {
        type: 'message',
        id: 'm1',
        message: { role: 'user', content: [{ type: 'text', text: '历史' }] },
      },
    ]);
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(buildRecallContext).not.toHaveBeenCalled();
    expect(handle.prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
  });

  it('会话内已产生用户消息(handle.messages 含 user)的再次 send → 无注入', async () => {
    const handle = makeHandle([], [{ role: 'user', content: [{ type: 'text', text: '上一轮' }] }]);
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(buildRecallContext).not.toHaveBeenCalled();
    expect(handle.prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
  });

  it('召回为空 → 无注入, 原样发送', async () => {
    const handle = makeHandle();
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(buildRecallContext).toHaveBeenCalledTimes(1);
    expect(handle.prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
  });

  it('注入失败(召回抛错) → 原样发送, 不影响会话', async () => {
    vi.mocked(buildRecallContext).mockImplementation(() => {
      throw new Error('recall boom');
    });
    const handle = makeHandle();
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });
    expect(handle.prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
  });
});
