import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MEDIUM-3 回归测试:复盘生成前必须冷同步会话 jsonl → OFK 概念。
// 场景:用户从未打开今日页(today-ipc 冷路径未触发),直接 generate 复盘——
// 复盘仍必须包含该会话(概念已同步)。修复前此测试红(概念缺失)。

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userData: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, fn);
    },
  },
  app: {
    getPath: (name: string) => (name === 'userData' ? electronMock.userData : ''),
  },
}));

import { registerReviewHandlers } from '../../src/main/ipc/review-ipc';
import { listDayConceptFiles, readConcept } from '../../src/main/ofk/ofk-bundle';

/** 与 today-ipc.test.ts 同款 v3 会话 jsonl(本地 2026-08-08 09:05 基准)。 */
function linearSessionJsonl(
  sessionId: string,
  cwd: string,
  base: Date = new Date(2026, 7, 8, 9, 5),
): string {
  const baseMs = base.getTime();
  const ts = (offsetSec: number) => new Date(baseMs + offsetSec * 1000).toISOString();
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: ts(0), cwd },
    {
      type: 'message',
      id: `${sessionId}-m1`,
      parentId: null,
      timestamp: ts(5),
      message: { role: 'user', content: [{ type: 'text', text: '修复复盘漏会话问题' }] },
    },
    {
      type: 'message',
      id: `${sessionId}-m2`,
      parentId: `${sessionId}-m1`,
      timestamp: ts(40),
      message: { role: 'assistant', content: [{ type: 'text', text: '正在修复' }] },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

describe('review-ipc 冷同步(MEDIUM-3)', () => {
  let userdata: string;
  let ws: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-review-sync-'));
    ws = mkdtempSync(path.join(tmpdir(), 'lorra-review-ws-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    electronMock.userData = userdata;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  it('未开今日页 → generate 复盘仍同步会话 jsonl 并写入 OFK 概念', async () => {
    // 只播种会话 jsonl,绝不触发 today-ipc 冷路径
    const sessionsDir = path.join(userdata, '.lorra', 'sessions', 'ws1');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(path.join(sessionsDir, 'sess-a.jsonl'), linearSessionJsonl('sess-a', ws), 'utf8');

    registerReviewHandlers(() => ws);

    const handler = electronMock.handlers.get('lorra.review.generate');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('generate handler missing');

    // 触发 generate:模型不可用(测试环境)→ Err 返回,但冷同步必须先于模型执行
    const result = (await handler(null, { kind: 'daily', dateISO: '2026-08-08' })) as {
      status: string;
      error?: { code: string };
    };
    // 断言走到模型层(冷同步已执行);模型不可用是预期降级
    if (result.status === 'error') {
      expect(['model-unavailable', 'model-invoke-failed']).toContain(result.error?.code);
    }

    // MEDIUM-3 核心断言:会话概念已同步落盘(不再依赖今日页打开)
    const listed = await listDayConceptFiles('2026-08-08');
    expect(listed.isOk()).toBe(true);
    const rels = listed.unwrapOr([]);
    expect(rels.length).toBeGreaterThan(0);
    const content = await readConcept(rels[0]);
    expect(content.unwrapOr('') ?? '').toContain('修复复盘漏会话问题');
  });

  it('冷同步幂等:重复 generate 不产生重复概念(diff-skip)', async () => {
    const sessionsDir = path.join(userdata, '.lorra', 'sessions', 'ws1');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(path.join(sessionsDir, 'sess-a.jsonl'), linearSessionJsonl('sess-b', ws), 'utf8');

    registerReviewHandlers(() => ws);
    const handler = electronMock.handlers.get('lorra.review.generate');
    if (!handler) throw new Error('generate handler missing');

    await handler(null, { kind: 'daily', dateISO: '2026-08-08' });
    await handler(null, { kind: 'daily', dateISO: '2026-08-08' });

    const listed = await listDayConceptFiles('2026-08-08');
    expect(listed.isOk()).toBe(true);
    expect(listed.unwrapOr([])).toHaveLength(1); // 同会话只落一个概念
  });
});
