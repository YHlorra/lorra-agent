import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPiSdkCollector } from '../../src/main/memory/collectors/pi-sdk-collector';
import {
  FACTS_SCHEMA_VERSION,
  type FactPrivacy,
  type SessionFact,
} from '../../src/shared/facts-schema';
import type { LorraError } from '../../src/shared/result';

// Requirement: pi-sdk jsonl collector — 读真实 jsonl 会话文件、分支树取活跃叶、
// 清洗不修改原始文件、损坏文件跳过并记录错误、其余文件照常。
// Requirement: 热会话实时增量（数据侧）——文件随会话增长后重清洗反映增长。
// collect 单一契约: ok 携带 { facts, errors: LorraError[] }，err 仅用于整体性失败。

const FIXTURES = fileURLToPath(new URL('fixtures/sessions', import.meta.url));

function fixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lorra-pi-fixtures-'));
  cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

async function collectFacts(sessionsDir: string, workspace = 'C:\\work\\demo') {
  const result = await createPiSdkCollector({ sessionsDir, workspace }).collect();
  expect(result.isOk()).toBe(true);
  return result.unwrapOr({ facts: [], errors: [] } as never) as {
    facts: SessionFact[];
    errors: LorraError[];
  };
}

describe('pi-sdk collector', () => {
  let dir: string;
  beforeEach(() => {
    dir = fixtureDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('从真实 jsonl 文件产出标准 schema 事实（每个有效文件一条）', async () => {
    const { facts, errors } = await collectFacts(dir);

    expect(facts).toHaveLength(4); // linear + branch + unfinished + usage
    expect(errors).toHaveLength(2); // corrupted + no-header

    // 工作区身份 = 各文件会话头 header.cwd 的真实路径（审查 #1 钉死契约）。
    const cwdByRef: Record<string, string> = {
      'sess-linear-001': 'C:\\work\\demo',
      'sess-branch-002': 'C:\\work\\demo',
      'sess-unfinished-004': 'C:\\work\\demo',
      'sess-usage-005': 'C:\\work\\usage',
    };
    for (const f of facts) {
      expect(f.factId).toMatch(/^[0-9a-f]{64}$/);
      expect(f.schemaVersion).toBe(FACTS_SCHEMA_VERSION);
      expect(f.workspace).toBe(cwdByRef[f.sessionRef]);
      expect(f.collector.length).toBeGreaterThan(0);
      expect(f.runtime.length).toBeGreaterThan(0);
      expect(f.summaryRef).toBeNull();
      expect(f.tokens).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(f.tools)).toBe(true);
      const scopes = ['user', 'workspace', 'project', 'agent'];
      expect(scopes).toContain(f.scope);
      const privacies: FactPrivacy[] = ['public_safe', 'local_private', 'private_pointer'];
      expect(privacies).toContain(f.privacy);
    }
  });

  it('线性会话: title=首条 user 消息, 时长=首末差, unfinished=false', async () => {
    const { facts } = await collectFacts(dir);
    const f = facts.find((x) => x.sessionRef === 'sess-linear-001');
    expect(f).toBeDefined();
    expect(f!.title).toBe('Fix the flaky login test');
    expect(f!.start).toBe(Date.parse('2026-08-08T09:00:05.000Z'));
    expect(f!.end).toBe(Date.parse('2026-08-08T09:01:10.000Z'));
    expect(f!.activeMs).toBe(65_000);
    expect(f!.unfinished).toBe(false);
    expect(f!.containsTodo).toBe(false);
    // 无 model_change / tool_use 的会话:model 空串、tools 空数组、tokens 0。
    expect(f!.model).toBe('');
    expect(f!.tools).toEqual([]);
    expect(f!.tokens).toBe(0);
  });

  it('usage 提取: model 取 model_change（provider/modelId）, tools 为去重工具名, tokens=usage.totalTokens 之和', async () => {
    const { facts } = await collectFacts(dir);
    const f = facts.find((x) => x.sessionRef === 'sess-usage-005');
    expect(f).toBeDefined();
    // 钉死格式 'provider/modelId'（'anthropic/claude-sonnet-4-5'）：UI 需要同时
    // 区分 provider 与具体模型；SDK model_change 条目提供两者，拼接可无损往返。
    expect(f!.model).toBe('anthropic/claude-sonnet-4-5');
    // tools = 去重后的工具名数组，按首次出现顺序（read 出现两次只记一次）——
    // UI 需要的是「用过哪些工具」而非调用次数。
    expect(f!.tools).toEqual(['read', 'edit', 'bash']);
    // tokens = 活跃序列内 assistant 消息 usage.totalTokens 之和（SDK 口径,
    // totalTokens 已含 input/output/cacheRead/cacheWrite）:
    // m2 11076 + m3 12866 = 23942；m4 无 usage 字段（模拟报错/超时条目）贡献 0。
    expect(f!.tokens).toBe(23_942);
    // 其余语义不受影响。
    expect(f!.title).toBe('Investigate the slow build');
    expect(f!.activeMs).toBe(90_000);
    expect(f!.unfinished).toBe(false);
  });

  it('分支会话: 取最后活跃叶, 事实反映活跃分支的内容与时长', async () => {
    const { facts } = await collectFacts(dir);
    const f = facts.find((x) => x.sessionRef === 'sess-branch-002');
    expect(f).toBeDefined();
    expect(f!.title.startsWith('Actually, pivot to the caching strategy')).toBe(true);
    expect(f!.start).toBe(Date.parse('2026-08-08T10:05:00.000Z'));
    expect(f!.end).toBe(Date.parse('2026-08-08T10:05:30.000Z'));
    expect(f!.activeMs).toBe(30_000);
    expect(f!.containsTodo).toBe(true); // 分支内容含 TODO 表述
  });

  it('未完成会话: 末条为 user -> unfinished=true', async () => {
    const { facts } = await collectFacts(dir);
    const f = facts.find((x) => x.sessionRef === 'sess-unfinished-004');
    expect(f).toBeDefined();
    expect(f!.unfinished).toBe(true);
    expect(f!.containsTodo).toBe(true);
    expect(f!.title.startsWith('Can you add a retry loop?')).toBe(true);
  });

  it('损坏文件退化: 坏文件与缺会话头文件被跳过并记录 LorraError, 其余文件照常', async () => {
    const { facts, errors } = await collectFacts(dir);

    // 两个损坏文件都不产出事实。
    expect(facts.some((f) => f.sessionRef === 'corrupted' || f.sessionRef === 'no-header')).toBe(
      false,
    );
    // 但好文件一个不落。
    expect(facts.map((f) => f.sessionRef)).toEqual(
      expect.arrayContaining(['sess-linear-001', 'sess-branch-002', 'sess-unfinished-004']),
    );
    // 错误以 LorraError 形状记录（契约: collect ok.errors: LorraError[]）。
    expect(errors).toHaveLength(2);
    for (const e of errors) {
      expect(typeof e.code).toBe('string');
      expect(e.code.length).toBeGreaterThan(0);
      expect(typeof e.message).toBe('string');
    }
  });

  it('原始记录只读: 清洗前后文件内容与 mtime 完全不变', async () => {
    const files = [
      '2026-08-08T09-00-00-000Z_sess-linear-001.jsonl',
      '2026-08-08T10-00-00-000Z_sess-branch-002.jsonl',
    ];
    const before = new Map(
      files.map((f) => [
        f,
        { content: readFileSync(path.join(dir, f)), mtimeMs: statSync(path.join(dir, f)).mtimeMs },
      ]),
    );

    await collectFacts(dir);

    for (const [f, b] of before) {
      const p = path.join(dir, f);
      expect(readFileSync(p).equals(b.content)).toBe(true);
      expect(statSync(p).mtimeMs).toBe(b.mtimeMs);
    }
  });

  it('退化: 空目录 -> 空 facts、空 errors', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'lorra-pi-empty-'));
    try {
      const { facts, errors } = await collectFacts(empty);
      expect(facts).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('热会话实时增量（数据侧）: 文件随会话增长后重清洗, 新事实时长与 tokens 增长', async () => {
    // 复制线性会话到独立目录模拟进行中会话。
    const growing = mkdtempSync(path.join(tmpdir(), 'lorra-pi-growing-'));
    try {
      const src = path.join(FIXTURES, '2026-08-08T09-00-00-000Z_sess-linear-001.jsonl');
      const target = path.join(growing, '2026-08-08T09-00-00-000Z_sess-linear-001.jsonl');
      cpSync(src, target);

      const first = await collectFacts(growing);
      const fact1 = first.facts.find((f) => f.sessionRef === 'sess-linear-001');
      expect(fact1).toBeDefined();
      expect(fact1!.tokens).toBe(0); // 线性 fixture 无 usage

      // 模拟会话继续: jsonl 追加一条用户消息。追加时间落在末条消息 5 分钟
      // 窗口内（09:01:10 → 09:02:00），按 D6 口径仍在同一活跃窗口，activeMs
      // 必然随对话增长；若间隔超过 5 分钟，孤立单条消息贡献 0，增长断言失真。
      appendFileSync(
        target,
        '{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-08-08T09:02:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Now also fix the race in the retry loop"}]}}\n',
        'utf8',
      );
      // 再追加一条带 usage 的 assistant 回复 -> tokens 随对话进行增长。
      appendFileSync(
        target,
        '{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-08-08T09:02:30.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Race fixed."}],"usage":{"input":300,"output":200,"cacheRead":0,"cacheWrite":0,"totalTokens":500,"cost":{"total":0.001}}}}\n',
        'utf8',
      );

      const second = await collectFacts(growing);
      const fact2 = second.facts.find((f) => f.sessionRef === 'sess-linear-001');
      expect(fact2).toBeDefined();
      // 内容变化 -> 新 factId；同一会话两条记录共存（非重复清洗）。
      expect(fact2!.factId).not.toBe(fact1!.factId);
      // 时长随对话进行增长（今日页无需刷新即可反映）。
      expect(fact2!.end).toBeGreaterThan(fact1!.end);
      expect(fact2!.activeMs).toBeGreaterThan(fact1!.activeMs);
      expect(fact2!.title).toBe('Fix the flaky login test'); // title 仍取首条 user 消息
      // tokens 随追加的 assistant usage 增长（0 -> 500）。
      expect(fact2!.tokens).toBe(500);
    } finally {
      rmSync(growing, { recursive: true, force: true });
    }
  });
});
