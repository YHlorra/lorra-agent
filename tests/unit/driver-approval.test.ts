import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_TIMEOUT_MS,
  LorraDriver,
  type SessionPersistence,
} from '../../src/main/pi-sdk-driver/driver';
import type { EventRouter } from '../../src/main/pi-sdk-driver/event-router';

// driver.ts 静态依赖 memory/recall → shared-memory-store(node:sqlite TLA),
// jsdom client 测试图无法打包 node:sqlite,整模块 mock(审批路径不涉及召回注入)。
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

// driver 构造不依赖 SDK 运行时,仅 approval 路径需要 mock AgentSession handle。
const abort = vi.fn(async () => {});

function makeHandle(sessionId: string) {
  return {
    sessionId,
    sendCustomMessage: async () => {},
    abort,
    dispose: async () => {},
    waitForIdle: async () => {},
    sessionManager: { fileEntries: [] },
    subscribe: () => () => {},
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

describe('LorraDriver 分级审批', () => {
  let ws: string;
  let driver: LorraDriver;

  beforeEach(async () => {
    ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-approval-'));
    vi.stubEnv('LORRA_E2E_USERDATA', ws); // 编辑记录落到临时目录
    vi.clearAllMocks();
    driver = new LorraDriver({ workspacePath: ws, persistence: noopPersistence });
    await driver.continueRecent(); // 注册会话 's'
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  function approvalsMap(): Map<string, Record<string, unknown>> {
    return (driver as unknown as { approvals: Map<string, Record<string, unknown>> }).approvals;
  }

  /** 模拟 tool_call 时刻:会话处于非 idle(streaming/tool-running)。 */
  function markSessionBusy(): void {
    const registry = (
      driver as unknown as {
        registry: { updateStatus(sessionId: string, status: string): void };
      }
    ).registry;
    registry.updateStatus('s', 'streaming');
  }

  /** 订阅 router,收集发往渲染端的 AgentEvent。 */
  function collectEvents(): Array<{ type: string; approvalId?: string; decision?: string }> {
    const emitted: Array<{ type: string; approvalId?: string; decision?: string }> = [];
    const router = (driver as unknown as { router: EventRouter }).router;
    const wcStub = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        emitted.push(event as { type: string; approvalId?: string; decision?: string });
      },
    } as never;
    router.subscribe('s', wcStub);
    return emitted;
  }

  it('requestApproval 发 tool.approval-requested 事件并返回挂起的 Promise', async () => {
    markSessionBusy();
    const emitted = collectEvents();

    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/out.txt',
      reason: 'approval-required: 写入位置在工作区外',
    });

    // 裁决前:Promise 挂起(拦截器 await 在此处等待用户)。
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(emitted).toHaveLength(1);
    const ev = emitted[0];
    expect(ev.type).toBe('tool.approval-requested');
    expect(typeof ev.approvalId).toBe('string');
    expect(ev.approvalId).toBeTruthy();
    expect(approvalsMap().size).toBe(1);
  });

  it('respondApproval allowAlways → promise resolve allowAlways + 写放行注册表 + 发 approval.resolved', async () => {
    markSessionBusy();
    const emitted = collectEvents();

    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/out.txt',
      reason: 'approval-required: 写入位置在工作区外',
    });
    const approvalId = emitted[0]?.approvalId as string;

    await driver.respondApproval('s', approvalId, 'allowAlways');

    await expect(decision).resolves.toBe('allowAlways');
    expect(driver.checkApproved('write', 'D:/out.txt')).toBe(true);
    expect(driver.checkApproved('write', 'D:/other.txt')).toBe(false);
    expect(driver.checkApproved('edit', 'D:/out.txt')).toBe(false);
    expect(emitted[1]).toMatchObject({
      type: 'approval.resolved',
      approvalId,
      decision: 'allowAlways',
    });
    expect(approvalsMap().get(approvalId)?.state).toBe('resolved');
  });

  // 2026-08-10:三选项拆分——allowOnce 放行本次但不写会话注册表。
  it('respondApproval allowOnce → promise resolve allowOnce + 不写注册表 + 发 approval.resolved', async () => {
    markSessionBusy();
    const emitted = collectEvents();

    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/out-once.txt',
      reason: 'approval-required: 写入位置在工作区外',
    });
    const approvalId = emitted[0]?.approvalId as string;

    await driver.respondApproval('s', approvalId, 'allowOnce');

    await expect(decision).resolves.toBe('allowOnce');
    expect(driver.checkApproved('write', 'D:/out-once.txt')).toBe(false);
    expect(emitted[1]).toMatchObject({
      type: 'approval.resolved',
      approvalId,
      decision: 'allowOnce',
    });
    expect(approvalsMap().get(approvalId)?.state).toBe('resolved');
  });

  it('respondApproval deny → promise resolve deny + 不写注册表 + 发 approval.resolved', async () => {
    markSessionBusy();
    const emitted = collectEvents();

    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/out2.txt',
      reason: 'approval-required: 写入位置在工作区外',
    });
    const approvalId = emitted[0]?.approvalId as string;

    await driver.respondApproval('s', approvalId, 'deny');

    await expect(decision).resolves.toBe('deny');
    expect(driver.checkApproved('write', 'D:/out2.txt')).toBe(false);
    expect(emitted[1]).toMatchObject({ type: 'approval.resolved', approvalId, decision: 'deny' });
    expect(approvalsMap().get(approvalId)?.state).toBe('resolved');
  });

  it('未知 approvalId 抛错', async () => {
    await expect(driver.respondApproval('s', 'nope', 'allowAlways')).rejects.toThrow(
      'approval not found',
    );
  });

  it('无活跃会话 → requestApproval 直接 resolve deny,不发事件', async () => {
    const emitted = collectEvents();
    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/out.txt',
      reason: 'approval-required: 写入位置在工作区外',
    });
    await expect(decision).resolves.toBe('deny');
    expect(emitted).toHaveLength(0);
    expect(approvalsMap().size).toBe(0);
  });

  it('abort → 该会话 pending 审批 resolve deny 并移除条目', async () => {
    markSessionBusy();
    const emitted = collectEvents();
    const a = driver.requestApproval({
      toolName: 'write',
      target: 'D:/a.txt',
      reason: 'approval-required: 写入位置在工作区外',
    });
    const idA = emitted[0]?.approvalId as string;

    await driver.abort('s');

    await expect(a).resolves.toBe('deny');
    expect(approvalsMap().has(idA)).toBe(false);
  });
});

describe('审批 deadline 超时自动 deny(2026-08-19,)', () => {
  let ws: string;
  let driver: LorraDriver;

  beforeEach(async () => {
    vi.useFakeTimers();
    ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-approval-deadline-'));
    vi.stubEnv('LORRA_E2E_USERDATA', ws);
    driver = new LorraDriver({ workspacePath: ws, persistence: noopPersistence });
    await driver.continueRecent();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function markBusy(): void {
    const registry = (
      driver as unknown as {
        registry: { updateStatus(sessionId: string, status: string): void };
      }
    ).registry;
    registry.updateStatus('s', 'streaming');
  }

  function approvalCount(): number {
    const approvals = (driver as unknown as { approvals: Map<string, Record<string, unknown>> })
      .approvals;
    return approvals.size;
  }

  function collectEvents(): Array<{ type: string; approvalId?: string; decision?: string }> {
    const emitted: Array<{ type: string; approvalId?: string; decision?: string }> = [];
    const router = (driver as unknown as { router: EventRouter }).router;
    const wcStub = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        emitted.push(event as { type: string; approvalId?: string; decision?: string });
      },
    } as never;
    router.subscribe('s', wcStub);
    return emitted;
  }

  it('到期自动 deny + 发 approval.resolved(deny) + 移除条目', async () => {
    markBusy();
    const emitted = collectEvents();
    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/deadline.txt',
      reason: 'approval-required: 测试审批超时',
    });
    const approvalId = emitted[0]?.approvalId as string;
    expect(approvalCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);

    await expect(decision).resolves.toBe('deny');
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'approval.resolved', approvalId, decision: 'deny' }),
    );
    expect(approvalCount()).toBe(0); // 超时后条目移除,哨兵不泄漏
  });

  it('超时后再 respondApproval → approval not found(条目已移除)', async () => {
    markBusy();
    const emitted = collectEvents();
    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/deadline2.txt',
      reason: 'approval-required: 测试审批超时',
    });
    const approvalId = emitted[0]?.approvalId as string;

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await expect(decision).resolves.toBe('deny');
    await expect(driver.respondApproval('s', approvalId, 'allowAlways')).rejects.toThrow(
      'approval not found',
    );
  });

  it('用户先裁决后哨兵清除:推进远超超时不重复 resolve', async () => {
    markBusy();
    const emitted = collectEvents();
    const decision = driver.requestApproval({
      toolName: 'write',
      target: 'D:/deadline3.txt',
      reason: 'approval-required: 测试审批超时',
    });
    const approvalId = emitted[0]?.approvalId as string;

    await driver.respondApproval('s', approvalId, 'allowAlways');
    await expect(decision).resolves.toBe('allowAlways');

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS * 2);
    const resolvedEvents = emitted.filter((e) => e.type === 'approval.resolved');
    expect(resolvedEvents).toHaveLength(1); // 只有用户那次,超时哨兵已清除不补刀
    expect(approvalCount()).toBe(1); // 用户裁决不移除条目(幂等校验用)
  });
});
