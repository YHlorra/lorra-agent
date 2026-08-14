import { describe, expect, it } from 'vitest';
import { cleanseSession, type RawSessionEntry } from '../../src/main/memory/cleanse';
import {
  FACTS_SCHEMA_VERSION,
  type FactPrivacy,
  type SessionFact,
} from '../../src/shared/facts-schema';
import { err, ok } from '../../src/shared/result';

// Requirement: pi-sdk jsonl collector（清洗核心语义）+ 未完成会话判定。
// cleanseSession 是纯函数清洗：分支树取最后活跃叶、title=首条 user 消息截断、
// unfinished=末条 role==='user'、contains_todo=内容含待办表述。

const HEADER = { id: 'sess-1', cwd: 'C:\\work\\demo' };
const T0 = 1_700_000_000_000;

interface MsgSpec {
  id: string;
  parentId: string | null;
  offsetMs: number;
  role: string;
  text: string;
}

function msg(spec: MsgSpec): RawSessionEntry {
  return {
    id: spec.id,
    parentId: spec.parentId,
    timestamp: T0 + spec.offsetMs,
    message: { role: spec.role, content: [{ type: 'text', text: spec.text }] },
  };
}

/**
 * 带 usage 的 assistant 消息（SDK 形状:message.usage.totalTokens）。
 * RawSessionEntry.message 当前类型无 usage 字段——本测试钉死提取契约
 * （usage.totalTokens 求和），实现侧需把 usage 并入解析与清洗链路。
 */
function msgWithUsage(spec: MsgSpec & { totalTokens?: number | null }): RawSessionEntry {
  return {
    id: spec.id,
    parentId: spec.parentId,
    timestamp: T0 + spec.offsetMs,
    message: {
      role: spec.role,
      content: [{ type: 'text', text: spec.text }],
      ...(spec.totalTokens != null ? { usage: { totalTokens: spec.totalTokens } } : {}),
    } as RawSessionEntry['message'],
  };
}

function nonMessageEntry(id: string, parentId: string | null, offsetMs: number): RawSessionEntry {
  return { id, parentId, timestamp: T0 + offsetMs };
}

function chain(specs: MsgSpec[]): RawSessionEntry[] {
  return specs.map((s) => msg(s));
}

function expectOkFact(result: ReturnType<typeof cleanseSession>): SessionFact {
  expect(result.isOk()).toBe(true);
  const fact = result.unwrapOr(null as never);
  expect(fact).not.toBeNull();
  return fact;
}

function expectErr(result: ReturnType<typeof cleanseSession>): { code: string; message: string } {
  expect(result.isErr()).toBe(true);
  return result.match({
    ok: () => {
      throw new Error('expected Err, got Ok');
    },
    err: (e) => e,
  });
}

describe('cleanseSession', () => {
  it('happy: 线性会话产出一条完整 schema 事实', () => {
    const entries = chain([
      { id: 'm1', parentId: null, offsetMs: 5_000, role: 'user', text: 'Fix the flaky login test' },
      { id: 'm2', parentId: 'm1', offsetMs: 40_000, role: 'assistant', text: 'Let me look.' },
      { id: 'm3', parentId: 'm2', offsetMs: 70_000, role: 'assistant', text: 'Found it.' },
    ]);
    const fact = expectOkFact(cleanseSession(HEADER, entries, 'C:\\work\\demo'));

    expect(fact.schemaVersion).toBe(FACTS_SCHEMA_VERSION);
    expect(fact.sessionRef).toBe('sess-1');
    expect(fact.workspace).toBe('C:\\work\\demo');
    expect(fact.collector.length).toBeGreaterThan(0);
    expect(fact.runtime.length).toBeGreaterThan(0);
    expect(typeof fact.agentId).toBe('string');
    expect(['user', 'workspace', 'project', 'agent']).toContain(fact.scope);
    const privacies: FactPrivacy[] = ['public_safe', 'local_private', 'private_pointer'];
    expect(privacies).toContain(fact.privacy);
    expect(Array.isArray(fact.tools)).toBe(true);
    expect(typeof fact.model).toBe('string');
    expect(fact.tokens).toBeGreaterThanOrEqual(0);
    expect(fact.summaryRef).toBeNull();
    // 无 model_change / tool_use / usage 的条目:model 空串、tools 空数组、
    // tokens=0（tokens 只来自 assistant 消息的 usage.totalTokens,本测试无 usage）。
    expect(fact.model).toBe('');
    expect(fact.tools).toEqual([]);
    expect(fact.tokens).toBe(0);

    // 时长口径: 全部间隔 ≤5 分钟 -> 首末差。
    expect(fact.start).toBe(T0 + 5_000);
    expect(fact.end).toBe(T0 + 70_000);
    expect(fact.activeMs).toBe(65_000);
    // title=首条 user 消息（未超长，不截断）。
    expect(fact.title).toBe('Fix the flaky login test');
    expect(fact.unfinished).toBe(false);
    expect(fact.containsTodo).toBe(false);
  });

  it('title 确定性: 首条 user 消息超长时截断, 且同一输入两次结果一致', () => {
    const longText = 'A very long first user message '.repeat(12).trim(); // 300+ chars
    const entries = chain([
      { id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: longText },
      { id: 'm2', parentId: 'm1', offsetMs: 10_000, role: 'assistant', text: 'ok' },
    ]);
    const factA = expectOkFact(cleanseSession(HEADER, entries, 'ws'));
    const factB = expectOkFact(cleanseSession(HEADER, entries, 'ws'));

    expect(factA.title).toBe(factB.title); // 确定性规则，不依赖 LLM
    expect(factA.title.length).toBeGreaterThan(0);
    expect(factA.title.length).toBeLessThan(longText.length); // 确实被截断
    expect(longText.startsWith(factA.title)).toBe(true); // 是首条 user 消息的前缀
  });

  it('分支会话取活跃叶: 事实反映最后活跃分支的消息序列（内容与时长）', () => {
    const entries = [
      msg({
        id: 'b1',
        parentId: null,
        offsetMs: 10_000,
        role: 'user',
        text: 'Initial approach: refactor the module',
      }),
      msg({
        id: 'b2',
        parentId: 'b1',
        offsetMs: 50_000,
        role: 'assistant',
        text: 'OK, exploring.',
      }),
      nonMessageEntry('bc1', 'b2', 60_000), // 非消息条目（如 model_change）不应破坏序列
      msg({
        id: 'b3',
        parentId: 'b1',
        offsetMs: 5 * 60_000 + 0,
        role: 'user',
        text: 'Actually, pivot to caching',
      }),
      msg({
        id: 'b4',
        parentId: 'b3',
        offsetMs: 5 * 60_000 + 30_000,
        role: 'assistant',
        text: 'Caching it is.',
      }),
    ];
    const fact = expectOkFact(cleanseSession(HEADER, entries, 'ws'));

    // 活跃叶 = b4（最新时间戳）。事实只反映该分支: [b3, b4]。
    expect(fact.start).toBe(T0 + 5 * 60_000);
    expect(fact.end).toBe(T0 + 5 * 60_000 + 30_000);
    expect(fact.activeMs).toBe(30_000);
    expect(fact.title.startsWith('Actually, pivot to caching')).toBe(true);
  });

  it('未完成会话判定: 末条为 user 消息 -> unfinished=true', () => {
    const entries = chain([
      { id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: 'Can you add a retry loop?' },
      { id: 'm2', parentId: 'm1', offsetMs: 20_000, role: 'assistant', text: 'On it.' },
      { id: 'm3', parentId: 'm2', offsetMs: 60_000, role: 'user', text: 'Also bump the timeout' },
    ]);
    const fact = expectOkFact(cleanseSession(HEADER, entries, 'ws'));
    expect(fact.unfinished).toBe(true);
  });

  it('未完成会话判定: 末条为 assistant -> unfinished=false', () => {
    const entries = chain([
      { id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: 'hi' },
      { id: 'm2', parentId: 'm1', offsetMs: 20_000, role: 'assistant', text: 'hello' },
    ]);
    const fact = expectOkFact(cleanseSession(HEADER, entries, 'ws'));
    expect(fact.unfinished).toBe(false);
  });

  it('contains_todo: 会话内容含待办表述 -> true', () => {
    const entries = chain([
      {
        id: 'm1',
        parentId: null,
        offsetMs: 0,
        role: 'user',
        text: 'Add retry loop. TODO: handle rate limits',
      },
      { id: 'm2', parentId: 'm1', offsetMs: 20_000, role: 'assistant', text: 'Done.' },
    ]);
    expect(expectOkFact(cleanseSession(HEADER, entries, 'ws')).containsTodo).toBe(true);
  });

  it('contains_todo: 无待办表述 -> false', () => {
    const entries = chain([
      { id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: 'Refactor the module' },
      { id: 'm2', parentId: 'm1', offsetMs: 20_000, role: 'assistant', text: 'Refactored.' },
    ]);
    expect(expectOkFact(cleanseSession(HEADER, entries, 'ws')).containsTodo).toBe(false);
  });

  // ---- tokens 提取契约（PM 拍板:usage 可提取,cleanse 硬编码 0 是 bug）----

  it('tokens: 活跃序列内全部 assistant 消息 usage.totalTokens 之和', () => {
    const entries = [
      msg({ id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: 'hi' }),
      msgWithUsage({
        id: 'm2',
        parentId: 'm1',
        offsetMs: 10_000,
        role: 'assistant',
        text: 'a',
        totalTokens: 11_076,
      }),
      msgWithUsage({
        id: 'm3',
        parentId: 'm2',
        offsetMs: 20_000,
        role: 'assistant',
        text: 'b',
        totalTokens: 12_866,
      }),
    ];
    expect(expectOkFact(cleanseSession(HEADER, entries, 'ws')).tokens).toBe(23_942);
  });

  it('tokens: usage 缺失的 assistant 消息贡献 0, 不报错', () => {
    const entries = [
      msg({ id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: 'hi' }),
      msg({
        id: 'm2',
        parentId: 'm1',
        offsetMs: 10_000,
        role: 'assistant',
        text: 'no usage field',
      }),
      msgWithUsage({
        id: 'm3',
        parentId: 'm2',
        offsetMs: 20_000,
        role: 'assistant',
        text: 'has usage',
        totalTokens: 500,
      }),
    ];
    const fact = expectOkFact(cleanseSession(HEADER, entries, 'ws'));
    expect(fact.tokens).toBe(500);
  });

  it('tokens: usage.totalTokens=0 的条目（超时报错）贡献 0', () => {
    const entries = [
      msg({ id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: 'hi' }),
      msgWithUsage({
        id: 'm2',
        parentId: 'm1',
        offsetMs: 10_000,
        role: 'assistant',
        text: 'timed out',
        totalTokens: 0,
      }),
    ];
    expect(expectOkFact(cleanseSession(HEADER, entries, 'ws')).tokens).toBe(0);
  });

  it('tokens: 无 assistant 消息的会话 -> 0', () => {
    const entries = chain([
      { id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: 'hi' },
      { id: 'm2', parentId: 'm1', offsetMs: 10_000, role: 'user', text: 'still waiting' },
    ]);
    expect(expectOkFact(cleanseSession(HEADER, entries, 'ws')).tokens).toBe(0);
  });

  it('tokens: 分支会话只对活跃分支序列求和（与 title/时长口径一致）', () => {
    const entries = [
      msg({ id: 'b1', parentId: null, offsetMs: 10_000, role: 'user', text: 'Initial approach' }),
      msgWithUsage({
        id: 'b2',
        parentId: 'b1',
        offsetMs: 50_000,
        role: 'assistant',
        text: 'trunk reply',
        totalTokens: 1_000,
      }),
      msg({
        id: 'b3',
        parentId: 'b1',
        offsetMs: 5 * 60_000,
        role: 'user',
        text: 'Pivot to caching',
      }),
      msgWithUsage({
        id: 'b4',
        parentId: 'b3',
        offsetMs: 5 * 60_000 + 30_000,
        role: 'assistant',
        text: 'branch reply',
        totalTokens: 250,
      }),
    ];
    const fact = expectOkFact(cleanseSession(HEADER, entries, 'ws'));
    // 活跃叶 = b4,序列 = [b3, b4]:只计 250,trunk 的 b2(1000)不计入。
    expect(fact.tokens).toBe(250);
  });

  it('退化: 空 entries -> Err', () => {
    const e = expectErr(cleanseSession(HEADER, [], 'ws'));
    expect(e.code.length).toBeGreaterThan(0);
    expect(e.message.length).toBeGreaterThan(0);
  });

  it('退化: 只有非消息条目（无会话内容）-> Err', () => {
    const entries = [nonMessageEntry('e1', null, 0), nonMessageEntry('e2', 'e1', 10_000)];
    expectErr(cleanseSession(HEADER, entries, 'ws'));
  });

  it('退化: header 缺 id -> Err', () => {
    const entries = chain([{ id: 'm1', parentId: null, offsetMs: 0, role: 'user', text: 'hi' }]);
    expectErr(cleanseSession({ id: '', cwd: 'C:\\work\\demo' }, entries, 'ws'));
  });

  it('退化: 条目 timestamp 非法 -> Err', () => {
    const bad = [
      { id: 'm1', parentId: null, timestamp: Number.NaN, message: { role: 'user', content: [] } },
    ];
    expectErr(cleanseSession(HEADER, bad as unknown as RawSessionEntry[], 'ws'));
  });

  it('退化: 消息条目缺 role -> Err', () => {
    const bad = [{ id: 'm1', parentId: null, timestamp: T0, message: { content: [] } }];
    expectErr(cleanseSession(HEADER, bad as unknown as RawSessionEntry[], 'ws'));
  });

  it('退化: 结果以 LorraError 形状返回（code + message）', () => {
    const e = expectErr(cleanseSession(HEADER, [], 'ws'));
    expect(typeof e.code).toBe('string');
    expect(typeof e.message).toBe('string');
  });

  it('OK 分支与 Err 分支类型独立（ok/err 辅助可组合）', () => {
    expect(ok(1).isOk()).toBe(true);
    expect(err({ code: 'x', message: 'y' }).isErr()).toBe(true);
  });
});
