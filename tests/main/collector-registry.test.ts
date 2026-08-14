import { describe, expect, it } from 'vitest';
import { type Collector, CollectorRegistry } from '../../src/main/memory/collectors/types';
import { FACTS_SCHEMA_VERSION, factIdOf, type SessionFact } from '../../src/shared/facts-schema';
import { err, ok } from '../../src/shared/result';

// Requirement: Collector 插件接口 — 多 collector 独立注册运行；
// 任一 collector 失败 MUST NOT 阻塞其他（fail-open）；新来源接入只注册新 collector，零穿透。
// collect 单一契约: ok 携带 { facts, errors: LorraError[] } —— errors 记本次清洗中
// 逐文件/逐来源的非致命错误（如损坏文件跳过）；err 仅用于 collector 整体性失败。

function makeFact(overrides: Partial<SessionFact> = {}): SessionFact {
  const content: Omit<SessionFact, 'factId'> = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: 'stub',
    runtime: 'test',
    agentId: 'agent-1',
    sessionRef: 'sess-x',
    workspace: 'ws',
    scope: 'workspace',
    start: 1_000,
    end: 2_000,
    activeMs: 1_000,
    title: 'stub fact',
    summaryRef: null,
    tokens: 0,
    model: 'm',
    tools: [],
    unfinished: false,
    containsTodo: false,
    privacy: 'public_safe',
  };
  const merged = { ...content, ...overrides };
  return { factId: factIdOf(merged), ...merged };
}

function collector(
  name: string,
  behavior: { ok?: SessionFact[]; err?: { code: string; message: string } },
): Collector {
  return {
    name,
    collect: async () =>
      behavior.err !== undefined ? err(behavior.err) : ok({ facts: behavior.ok ?? [], errors: [] }),
  };
}

describe('CollectorRegistry', () => {
  it('空注册表 runAll -> 空 facts、空 errors', async () => {
    const { facts, errors } = await new CollectorRegistry().runAll();
    expect(facts).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('多 collector 的事实合并产出', async () => {
    const registry = new CollectorRegistry();
    registry.register(collector('a', { ok: [makeFact({ sessionRef: 'a' })] }));
    registry.register(collector('b', { ok: [makeFact({ sessionRef: 'b' })] }));
    const { facts, errors } = await registry.runAll();

    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.sessionRef)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(errors).toEqual([]);
  });

  it('fail-open: 某 collector 返回 Err -> 错误被记录, 其他 collector 事实不受影响', async () => {
    const registry = new CollectorRegistry();
    registry.register(collector('ok-a', { ok: [makeFact({ sessionRef: 'a' })] }));
    registry.register(collector('bad-b', { err: { code: 'corrupt-file', message: 'bad jsonl' } }));
    registry.register(collector('ok-c', { ok: [makeFact({ sessionRef: 'c' })] }));

    const { facts, errors } = await registry.runAll();

    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.sessionRef)).toEqual(expect.arrayContaining(['a', 'c']));
    expect(errors).toHaveLength(1);
    expect(errors[0].collector).toBe('bad-b');
    expect(errors[0].error).toEqual({ code: 'corrupt-file', message: 'bad jsonl' });
  });

  it('fail-open: 某 collector 同步抛异常 -> 不冒泡, 记录 LorraError, 其余照常', async () => {
    const registry = new CollectorRegistry();
    registry.register({
      name: 'throws',
      collect: async () => {
        throw new Error('boom');
      },
    });
    registry.register(collector('ok', { ok: [makeFact({ sessionRef: 'ok' })] }));

    const { facts, errors } = await registry.runAll();

    expect(facts).toHaveLength(1);
    expect(facts[0].sessionRef).toBe('ok');
    expect(errors).toHaveLength(1);
    expect(errors[0].collector).toBe('throws');
    expect(typeof errors[0].error.code).toBe('string');
    expect(errors[0].error.message).toContain('boom');
  });

  it('fail-open: 某 collector 返回被拒绝的 Promise -> 同样被捕获', async () => {
    const registry = new CollectorRegistry();
    registry.register({
      name: 'rejects',
      collect: async () => Promise.reject(new Error('async boom')),
    });
    registry.register(collector('ok', { ok: [makeFact()] }));

    const { facts, errors } = await registry.runAll();
    expect(facts).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].collector).toBe('rejects');
  });

  it('新来源接入零穿透: 注册新 collector 产出的 schema 事实直接并入, 无需改造', async () => {
    // D1: 扩展点固定在层边界 —— 新 runtime 只注册一个 collector。
    const registry = new CollectorRegistry();
    registry.register(collector('legacy-pi', { ok: [makeFact({ collector: 'pi-sdk' })] }));
    registry.register(
      collector('new-runtime', {
        ok: [makeFact({ collector: 'some-future-runtime', sessionRef: 'new' })],
      }),
    );

    const { facts, errors } = await registry.runAll();
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.collector)).toEqual(
      expect.arrayContaining(['pi-sdk', 'some-future-runtime']),
    );
    expect(errors).toEqual([]);
    // 产出的事实全部符合标准 schema（factId 可计算、schemaVersion 一致）。
    for (const f of facts) {
      expect(f.factId).toMatch(/^[0-9a-f]{64}$/);
      expect(f.schemaVersion).toBe(FACTS_SCHEMA_VERSION);
    }
  });
});
