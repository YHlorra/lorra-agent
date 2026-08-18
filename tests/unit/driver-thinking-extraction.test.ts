// P1 走查防回归:driver 的 toMessageThinkingSegments 必须解包 SDK 消息的
// content 再提取思考段(pi-ai createEventConverter 实证:thinking 块位于
// message.content[] 内)。之前直传消息对象恒得空数组,实时对话丢全部思考段;
// 单测 makeMapper 自带了正确解包,导致 mapper 测试全绿而 driver 接线必坏。
// 本测试走真实生产路径:handle.subscribe 回调 → mapper.map → router 收集。
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LorraDriver, type SessionPersistence } from '../../src/main/pi-sdk-driver/driver';
import type { EventRouter } from '../../src/main/pi-sdk-driver/event-router';
import type { AgentEvent } from '../../src/shared/agent-events';

// driver.ts 静态依赖 memory/recall → shared-memory-store(node:sqlite TLA),
// jsdom client 测试图无法打包 node:sqlite,整模块 mock。
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

/** SDK 消息形状(与 pi-ai dist/api/pi-messages.js createEventConverter 一致)。 */
function sdkMessage(blocks: unknown[]): unknown {
  return { role: 'assistant', content: blocks };
}

describe('LorraDriver 实时思考段提取(生产接线)', () => {
  let ws: string;
  let driver: LorraDriver;
  let notifySdk: ((event: unknown) => void) | undefined;
  let emitted: AgentEvent[];

  beforeEach(async () => {
    ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-thinking-'));
    vi.stubEnv('LORRA_E2E_USERDATA', ws);
    vi.clearAllMocks();

    // subscribe 捕获 SDK 事件回调:驱动真实 mapper.map 链路。
    const handle = {
      sessionId: 's',
      sendCustomMessage: async () => {},
      abort: async () => {},
      dispose: async () => {},
      waitForIdle: async () => {},
      sessionManager: { fileEntries: [] },
      subscribe: (cb: (event: unknown) => void) => {
        notifySdk = cb;
        return () => {};
      },
      prompt: async () => {},
      compact: async () => {},
    } as never;
    const persistence: SessionPersistence = {
      list: async () => [],
      open: async () => handle,
      continueRecent: async () => handle,
      createInMemory: async () => handle,
    };

    driver = new LorraDriver({ workspacePath: ws, persistence });
    await driver.continueRecent(); // 注册会话 's' + attachSessionSubscription

    // router 收集发往渲染端的全部事件。
    emitted = [];
    const router = (driver as unknown as { router: EventRouter }).router;
    const wcStub = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        emitted.push(event as AgentEvent);
      },
    } as never;
    router.subscribe('s', wcStub);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  it('Given SDK 消息(thinking 块在 content 内) When 实时 message_update/message_end When 渲染 Then 按段发出 partial/final', () => {
    expect(notifySdk).toBeDefined();

    // 流式中途:段 0 文本增长(SDK 累积语义)。
    notifySdk?.({
      type: 'message_update',
      message: sdkMessage([
        { type: 'thinking', thinking: '先想' },
        { type: 'text', text: '' },
      ]),
    });
    // 段 1 出现。
    notifySdk?.({
      type: 'message_update',
      message: sdkMessage([
        { type: 'thinking', thinking: '先想' },
        { type: 'thinking', thinking: '再想' },
        { type: 'text', text: '' },
      ]),
    });
    // 流尾:两段完整 + 正文。
    notifySdk?.({
      type: 'message_end',
      message: sdkMessage([
        { type: 'thinking', thinking: '先想完整' },
        { type: 'thinking', thinking: '再想完整' },
        { type: 'text', text: '答案' },
      ]),
    });

    const partials = emitted.filter((e) => e.type === 'thinking.partial');
    const finals = emitted.filter((e) => e.type === 'thinking.final');
    // P1 断言:生产接线必须提出思考段——此前恒为 0,实时对话思考卡全丢。
    expect(partials.length + finals.length).toBeGreaterThan(0);
    // 段边界保真:段 0 增长 → partial[0];段 1 出现 → partial[1]。
    expect(partials.map((p) => [p.segmentIndex, p.content.thinking])).toEqual([
      [0, '先想'],
      [1, '再想'],
    ]);
    // final 两段、总数正确、块不拼接。
    expect(finals.map((f) => [f.segmentIndex, f.segmentCount, f.content.thinking])).toEqual([
      [0, 2, '先想完整'],
      [1, 2, '再想完整'],
    ]);
    // 正文消息仍正常发出。
    const messages = emitted.filter((e) => e.type === 'message.final');
    expect(messages.some((m) => m.role === 'assistant' && m.content.text === '答案')).toBe(true);
  });

  it('Given 无思考块的普通消息 When 实时流 When 渲染 Then 不发出 thinking 事件(正文不受影响)', () => {
    notifySdk?.({
      type: 'message_update',
      message: sdkMessage([{ type: 'text', text: '直答' }]),
    });
    notifySdk?.({
      type: 'message_end',
      message: sdkMessage([{ type: 'text', text: '直答' }]),
    });

    expect(
      emitted.filter((e) => e.type === 'thinking.partial' || e.type === 'thinking.final'),
    ).toEqual([]);
    expect(emitted.some((e) => e.type === 'message.final' && e.content.text === '直答')).toBe(true);
  });
});
