import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ABORT_TIMEOUT_MS,
  LorraDriver,
  type SessionPersistence,
} from '../../src/main/pi-sdk-driver/driver';
import type { EventRouter } from '../../src/main/pi-sdk-driver/event-router';

// 与 driver-approval 同款:driver.ts 静态依赖 memory/recall → node:sqlite TLA,
// 整模块 mock,abort 路径不涉及召回注入。
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

interface HandleOpts {
  abortBash?: () => void;
}

// 可切换的 abort 行为:测试可注入「永不 settle」的 abort 验证有界返回。
let abortImpl: (() => Promise<void>) | undefined;

function makeHandle(sessionId: string, opts?: HandleOpts) {
  return {
    sessionId,
    abort: async () => {
      if (abortImpl) await abortImpl();
    },
    abortBash: opts?.abortBash ?? (() => {}),
    dispose: async () => {},
    waitForIdle: async () => {},
    sessionManager: { fileEntries: [] },
    subscribe: () => () => {},
    prompt: async () => {},
    compact: async () => {},
  } as never;
}

function createDriver(handle: ReturnType<typeof makeHandle>, ws: string): LorraDriver {
  const persistence = {
    list: async () => [],
    open: async () => handle,
    continueRecent: async () => handle,
    createInMemory: async () => handle,
  } as unknown as SessionPersistence;
  return new LorraDriver({ workspacePath: ws, persistence });
}

describe('LorraDriver 有界中止(2026-08-19,)', () => {
  let ws: string;
  let driver: LorraDriver;

  beforeEach(async () => {
    vi.useFakeTimers();
    ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-abort-'));
    vi.stubEnv('LORRA_E2E_USERDATA', ws);
    abortImpl = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function approvalsSize(): number {
    return (driver as unknown as { approvals: Map<string, unknown> }).approvals.size;
  }

  function collectEvents(): Array<{
    type: string;
    sessionId?: string;
    status?: string;
    approvalId?: string;
    decision?: string;
  }> {
    const emitted: Array<{
      type: string;
      sessionId?: string;
      status?: string;
      approvalId?: string;
      decision?: string;
    }> = [];
    const router = (driver as unknown as { router: EventRouter }).router;
    const wcStub = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        emitted.push(
          event as {
            type: string;
            sessionId?: string;
            status?: string;
            approvalId?: string;
            decision?: string;
          },
        );
      },
    } as never;
    router.subscribe('s', wcStub);
    return emitted;
  }

  it('abort 先 deny 该会话挂起审批(再调 SDK abort),并 emit session.status=aborted', async () => {
    const handle = makeHandle('s');
    driver = createDriver(handle, ws);
    await driver.continueRecent();
    // busy + 挂起审批
    const registry = (
      driver as unknown as {
        registry: { updateStatus(sessionId: string, status: string): void };
      }
    ).registry;
    registry.updateStatus('s', 'streaming');
    const emitted = collectEvents();
    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/a.txt',
      reason: 'approval-required: 写入位置在工作区外',
    });
    const approvalId = emitted[0]?.approvalId as string;

    // 探针:SDK abort 被调用时,该会话挂起审批已被 resolve deny 并移除
    // (证明「先解卡再收尾」的重排——这正是修复停止按钮死锁的关键)。
    const probe = { approvalsAtAbort: 1 };
    abortImpl = async () => {
      probe.approvalsAtAbort = approvalsSize();
    };

    await driver.abort('s');

    await expect(decision).resolves.toBe('deny');
    expect(probe.approvalsAtAbort).toBe(0);
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'session.status', sessionId: 's', status: 'aborted' }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'approval.resolved', approvalId, decision: 'deny' }),
    );
  });

  it('SDK abort 永不 resolve → 仍按 ABORT_TIMEOUT_MS 返回并尽力 abortBash', async () => {
    const abortBash = vi.fn();
    const handle = makeHandle('s', { abortBash });
    driver = createDriver(handle, ws);
    await driver.continueRecent();
    abortImpl = () => new Promise<void>(() => {}); // SDK abort 永不 settle

    let returned = false;
    const p = driver.abort('s').then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(ABORT_TIMEOUT_MS);
    await p;
    expect(returned).toBe(true); // abort 有界返回,绝不挂起
    expect(abortBash).toHaveBeenCalled();
  });

  it('abort 正常路径(SDK abort 立即返回)不调用 abortBash', async () => {
    const abortBash = vi.fn();
    const handle = makeHandle('s', { abortBash });
    driver = createDriver(handle, ws);
    await driver.continueRecent();
    await driver.abort('s');
    expect(abortBash).not.toHaveBeenCalled();
  });
});
