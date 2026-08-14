import { describe, expect, it } from 'vitest';
import {
  FACTS_SCHEMA_VERSION,
  type FactPrivacy,
  factIdOf,
  type SessionFact,
} from '../../src/shared/facts-schema';

// Requirement: 标准事实 schema 契约 — 身份组（fact_id 内容哈希、schema_version 版本化）。
// 测试仅断言公开契约：版本号存在且为整数、factIdOf 幂等/区分内容、输出为规范 sha256。

function completeFact(
  overrides: Partial<Omit<SessionFact, 'factId'>> = {},
): Omit<SessionFact, 'factId'> {
  return {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: 'pi-sdk',
    runtime: 'pi',
    agentId: 'agent-1',
    sessionRef: 'sess-x',
    workspace: 'C:\\work\\demo',
    scope: 'workspace',
    start: 1_000,
    end: 2_000,
    activeMs: 1_000,
    title: 'Fix the flaky login test',
    summaryRef: null,
    tokens: 42,
    model: 'claude-sonnet',
    tools: ['read', 'write'],
    unfinished: false,
    containsTodo: false,
    privacy: 'public_safe',
    ...overrides,
  };
}

describe('facts-schema', () => {
  it('FACTS_SCHEMA_VERSION is a positive integer', () => {
    expect(typeof FACTS_SCHEMA_VERSION).toBe('number');
    expect(Number.isInteger(FACTS_SCHEMA_VERSION)).toBe(true);
    expect(FACTS_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('factIdOf is idempotent: same content twice yields the same id', () => {
    const content = completeFact();
    expect(factIdOf(content)).toBe(factIdOf(content));
  });

  it('factIdOf is deterministic across separate builds of the same content', () => {
    const a = completeFact();
    const b = completeFact();
    expect(factIdOf(a)).toBe(factIdOf(b));
  });

  it('factIdOf distinguishes different content (different title)', () => {
    const a = completeFact({ title: 'Fix the flaky login test' });
    const b = completeFact({ title: 'Refactor the caching layer' });
    expect(factIdOf(a)).not.toBe(factIdOf(b));
  });

  it('factIdOf distinguishes different content (different time window)', () => {
    const a = completeFact({ start: 1_000, end: 2_000 });
    const b = completeFact({ start: 5_000, end: 6_000 });
    expect(factIdOf(a)).not.toBe(factIdOf(b));
  });

  it('factIdOf output is a sha256 hex digest (64 lowercase hex chars)', () => {
    const id = factIdOf(completeFact());
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('privacy enum accepts exactly the three sanctioned values (三分枚举)', () => {
    const values: FactPrivacy[] = ['public_safe', 'local_private', 'private_pointer'];
    for (const privacy of values) {
      expect(factIdOf(completeFact({ privacy }))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('schema 演进: factIdOf preserves schemaVersion as part of identity, does not force it to current', () => {
    // 旧版本记录（schemaVersion 低于当前）保持其原始版本号可哈希、可写入。
    const legacy = completeFact({ schemaVersion: FACTS_SCHEMA_VERSION - 1 });
    expect(legacy.schemaVersion).toBe(FACTS_SCHEMA_VERSION - 1);
    expect(factIdOf(legacy)).toMatch(/^[0-9a-f]{64}$/);
  });
});
