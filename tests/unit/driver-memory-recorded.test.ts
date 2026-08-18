import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LorraDriver, type SessionPersistence } from '../../src/main/pi-sdk-driver/driver';
import type { EventRouter } from '../../src/main/pi-sdk-driver/event-router';

// driver.ts 静态依赖 memory/recall → shared-memory-store(node:sqlite TLA),
// jsdom client 测试图无法打包 node:sqlite,整模块 mock(emit 路径不涉及召回注入)。
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

// 记忆写入成功事件(/D6):memory 工具 propose/update 成功 →
// session-persistence 的 emitMemoryRecorded 回调 → driver.emitMemoryRecorded →
// router 发 'memory.recorded'(MemoryRecordedEvent 信封 + entryId/title/kind/
// evidence),渲染端 reducer 追加只读通知条。
const noopPersistence: SessionPersistence = {
  list: async () => [],
  open: async () => makeHandle('s'),
  continueRecent: async () => makeHandle('s'),
  createInMemory: async () => makeHandle('s'),
};

function makeHandle(sessionId: string) {
  return {
    sessionId,
    sendCustomMessage: async () => {},
    abort: async () => {},
    dispose: async () => {},
    waitForIdle: async () => {},
    sessionManager: { fileEntries: [] },
    subscribe: () => () => {},
    prompt: async () => {},
    compact: async () => {},
  } as never;
}

const RECORDED_PAYLOAD = {
  entryId: 'abc123'.repeat(9),
  title: '登录测试偶尔闪断',
  kind: 'procedural_experience' as const,
  evidence: 'extracted' as const,
  sessionId: 's',
};

describe('LorraDriver.emitMemoryRecorded（memory.recorded 事件）', () => {
  let ws: string;
  let driver: LorraDriver;

  beforeEach(async () => {
    ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-memrec-'));
    vi.stubEnv('LORRA_E2E_USERDATA', ws);
    vi.clearAllMocks();
    driver = new LorraDriver({ workspacePath: ws, persistence: noopPersistence });
    await driver.continueRecent(); // 注册会话 's'
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function subscribeCollector() {
    const emitted: Array<Record<string, unknown>> = [];
    const router = (driver as unknown as { router: EventRouter }).router;
    const wcStub = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        emitted.push(event as Record<string, unknown>);
      },
    } as never;
    router.subscribe('s', wcStub);
    return emitted;
  }

  it('emitMemoryRecorded → 发 memory.recorded 事件（信封 + entryId/title/kind/evidence）', () => {
    const emitted = subscribeCollector();

    driver.emitMemoryRecorded(RECORDED_PAYLOAD);

    expect(emitted).toHaveLength(1);
    const ev = emitted[0];
    expect(ev.type).toBe('memory.recorded');
    expect(ev.entryId).toBe(RECORDED_PAYLOAD.entryId);
    expect(ev.title).toBe(RECORDED_PAYLOAD.title);
    expect(ev.kind).toBe('procedural_experience');
    expect(ev.evidence).toBe('extracted');
    expect(ev.sessionId).toBe('s');
    expect(typeof ev.eventId).toBe('string');
    expect(typeof ev.seq).toBe('number');
    expect(typeof ev.ts).toBe('number');
  });

  it('未注册会话 → 静默跳过（不抛错）', () => {
    expect(() =>
      driver.emitMemoryRecorded({ ...RECORDED_PAYLOAD, sessionId: 'ghost-session' }),
    ).not.toThrow();
  });
});
