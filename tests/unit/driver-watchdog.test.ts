import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LorraDriver,
  type SessionPersistence,
  STUCK_TIMEOUT_MS,
  WATCHDOG_SCAN_MS,
} from '../../src/main/pi-sdk-driver/driver';
import type { EventRouter } from '../../src/main/pi-sdk-driver/event-router';
import type { SessionRecord } from '../../src/main/pi-sdk-driver/session-registry';

// 与 driver-approval 同款:driver.ts 静态依赖 memory/recall → node:sqlite TLA,
// 整模块 mock,看门狗路径不涉及召回注入。
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

const abortMock = vi.fn(async () => {});

// 捕获 handle.subscribe 的回调,测试里可注入活动事件刷新 lastActivityAt。
let subscribeCb: ((event: unknown) => void) | undefined;

function makeHandle(sessionId: string) {
  return {
    sessionId,
    abort: abortMock,
    dispose: async () => {},
    waitForIdle: async () => {},
    sessionManager: { fileEntries: [] },
    subscribe: (cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return () => undefined;
    },
    prompt: async () => {},
    compact: async () => {},
  } as never;
}

const noopPersistence: SessionPersistence = {
  list: async () => [],
  open: async () => makeHandle('s'),
  continueRecent: async () => makeHandle('s'),
  createInMemory: async () => makeHandle('s'),
};

describe('LorraDriver 空闲看门狗(2026-08-19,)', () => {
  let ws: string;
  let driver: LorraDriver;

  beforeEach(async () => {
    vi.useFakeTimers();
    ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-watchdog-'));
    vi.stubEnv('LORRA_E2E_USERDATA', ws);
    vi.clearAllMocks();
    subscribeCb = undefined;
    driver = new LorraDriver({ workspacePath: ws, persistence: noopPersistence });
    await driver.continueRecent();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function record(): SessionRecord {
    const registry = (driver as unknown as { registry: { get(s: string): SessionRecord } })
      .registry;
    const rec = registry.get('s');
    if (!rec) throw new Error('session s not registered');
    return rec;
  }

  function markBusy(): void {
    record().status = 'streaming';
  }

  function watchdogTimer(): ReturnType<typeof setInterval> | null {
    return (driver as unknown as { watchdogTimer: ReturnType<typeof setInterval> | null })
      .watchdogTimer;
  }

  function collectEvents(): Array<{ type: string; sessionId?: string; status?: string }> {
    const emitted: Array<{ type: string; sessionId?: string; status?: string }> = [];
    const router = (driver as unknown as { router: EventRouter }).router;
    const wcStub = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        emitted.push(event as { type: string; sessionId?: string; status?: string });
      },
    } as never;
    router.subscribe('s', wcStub);
    return emitted;
  }

  it('busy 会话零事件超 STUCK_TIMEOUT_MS → 强制 errored + 状态事件 + 有界中止', async () => {
    markBusy();
    const emitted = collectEvents();
    // 模拟已零事件超过阈值:把 lastActivityAt 拨回旧时点。
    record().lastActivityAt = Date.now() - STUCK_TIMEOUT_MS - 1;

    await vi.advanceTimersByTimeAsync(WATCHDOG_SCAN_MS);

    expect(record().status).toBe('errored');
    expect(abortMock).toHaveBeenCalled(); // 有界中止已触发
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'session.status', sessionId: 's', status: 'errored' }),
    );
  });

  it('刚有活动事件 → 未超阈值,不误杀', async () => {
    markBusy();
    record().lastActivityAt = Date.now(); // 刚有活动
    await vi.advanceTimersByTimeAsync(WATCHDOG_SCAN_MS * 2);
    expect(record().status).toBe('streaming');
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('订阅回调每次映射事件刷新 lastActivityAt', async () => {
    markBusy();
    const before = record().lastActivityAt;
    await vi.advanceTimersByTimeAsync(1_000);
    subscribeCb?.({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
    expect(record().lastActivityAt).toBeGreaterThan(before);
  });

  it('首次注册会话启动定时器,shutdownAll 清空后停表', async () => {
    expect(watchdogTimer()).not.toBeNull(); // continueRecent 已注册会话 → 启动
    await driver.shutdownAll();
    expect(watchdogTimer()).toBeNull(); // 清空会话后停表,不空转
  });
});
