import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawSessionEntry } from '../../src/main/memory/cleanse';
import { ofkBundleRoot, readConcept, sessionConceptPath } from '../../src/main/ofk/ofk-bundle';
import {
  buildSessionConcept,
  computeBreaks,
  syncSessionFile,
  writeSessionConcept,
} from '../../src/main/ofk/session-writer';
import { FACTS_SCHEMA_VERSION, factIdOf, type SessionFact } from '../../src/shared/facts-schema';
import { SEGMENT_BREAK_GAP_MS } from '../../src/shared/gap';
import { parseSessionConcept } from '../../src/shared/ofk-schema';

// Requirement(step 4):pi-sdk 会话清洗 → D3 概念文档(确定性正文,
// 无 LLM);二次同步内容相同 diff-skip(mtime 不变);坏文件 Err 不抛。

const CWD = 'C:\\work\\demo';
const BASE = new Date(2026, 7, 8, 9, 5);

function ts(offsetSec: number): string {
  return new Date(BASE.getTime() + offsetSec * 1000).toISOString();
}

/** 线性会话 jsonl:user → assistant(带 tool_use×2)→ assistant,含 model_change。 */
function linearSessionJsonl(sessionId: string): string {
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: ts(0), cwd: CWD },
    {
      type: 'model_change',
      id: `${sessionId}-mc`,
      parentId: null,
      timestamp: ts(1),
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    },
    {
      type: 'message',
      id: `${sessionId}-m1`,
      parentId: `${sessionId}-mc`,
      timestamp: ts(5),
      message: { role: 'user', content: [{ type: 'text', text: 'Fix the flaky login test' }] },
    },
    {
      type: 'message',
      id: `${sessionId}-m2`,
      parentId: `${sessionId}-m1`,
      timestamp: ts(40),
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } },
          { type: 'tool_use', id: 't2', name: 'write', input: { path: 'x' } },
        ],
        usage: { totalTokens: 500 },
      },
    },
    {
      type: 'message',
      id: `${sessionId}-m3`,
      parentId: `${sessionId}-m2`,
      timestamp: ts(70),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Found and fixed it.' }] },
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

function makeFact(overrides: Partial<SessionFact> = {}): SessionFact {
  const content: Omit<SessionFact, 'factId'> = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: 'pi-sdk',
    runtime: 'pi-sdk',
    agentId: 'pi-sdk',
    sessionRef: 'sess-abc123',
    workspace: CWD,
    scope: 'workspace',
    start: BASE.getTime() + 5_000,
    end: BASE.getTime() + 70_000,
    activeMs: 65_000,
    title: 'Fix the flaky login test',
    summaryRef: null,
    tokens: 500,
    model: 'anthropic/claude-sonnet-4',
    tools: ['read', 'write'],
    unfinished: false,
    containsTodo: false,
    privacy: 'public_safe',
  };
  const merged = { ...content, ...overrides };
  return { factId: factIdOf(merged), ...merged };
}

describe('ofk-session-writer', () => {
  let userdata: string;
  let sessionsDir: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-writer-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    sessionsDir = path.join(userdata, '.lorra', 'sessions', '--C--work-demo--');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('syncSessionFile: 真实 jsonl → 概念落盘,frontmatter 全字段 + 三段正文 + 目录/文件名', async () => {
    const sessionId = 'sess-real-a';
    const jsonlPath = path.join(sessionsDir, `2026-08-08T09-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(jsonlPath, linearSessionJsonl(sessionId), 'utf8');

    const result = await syncSessionFile(jsonlPath, path.basename(sessionsDir));
    expect(result.isOk()).toBe(true);
    const fact = result.unwrapOr(null as never);
    expect(fact.sessionRef).toBe(sessionId);
    expect(fact.workspace).toBe(CWD); // header.cwd 优先

    const rel = sessionConceptPath(fact);
    expect(rel).toBe(
      path.join('sessions', 'C--work-demo', '2026', '2026-08-08', `${sessionId}.md`),
    );
    const read = await readConcept(rel);
    expect(read.isOk()).toBe(true);
    const doc = read.unwrapOr('') ?? '';

    // frontmatter 全字段(D3 精确序)
    expect(doc.startsWith('---\ntype: Session\n')).toBe(true);
    expect(doc).toContain('title: Fix the flaky login test\n');
    expect(doc).toContain('description: Fix the flaky login test\n');
    expect(doc).toContain('category: 未分类\n');
    expect(doc).toContain(`workspace: ${CWD}\n`);
    expect(doc).toContain(`sessionRef: ${sessionId}\n`);
    expect(doc).toContain(`start: ${ts(5)}\n`);
    expect(doc).toContain(`end: ${ts(70)}\n`);
    expect(doc).toContain('active_ms: 65000\n');
    expect(doc).toContain('tokens: 500\n');
    expect(doc).toContain('model: anthropic/claude-sonnet-4\n');
    expect(doc).toContain('tools: [read, write]\n');
    expect(doc).toContain('unfinished: false\n');
    expect(doc).toContain('contains_todo: false\n');
    expect(doc).toContain('privacy: public_safe\n');
    expect(doc).toContain('sources:');
    expect(doc).toContain(`  - id: pi-sdk\n    resource: ${jsonlPath}`);
    // generated.at = fact.end(确定性)
    expect(doc).toContain(`generated: { by: process:lorra-cleanse/1, at: ${ts(70)} }`);

    // 三段正文(确定性,无 LLM)
    expect(doc).toContain('## 用户要求');
    expect(doc).toContain('- [09:05] Fix the flaky login test');
    expect(doc).toContain('## 智能体做了什么');
    // 工具名列表 = 去重 fact.tools;「共 N 次」= 序列中 tool 块总数(2 个 tool_use)
    expect(doc).toContain('- 调用工具：read、write（共 2 次）');
    expect(doc).toContain('## 结果');
    expect(doc).toContain('- Found and fixed it.');

    // parseSessionConcept 读回:字段与 fact 一一对应
    const parsed = parseSessionConcept(doc);
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error('expected parsed concept');
    expect(parsed.title).toBe(fact.title);
    expect(parsed.category).toBe('未分类');
    expect(parsed.workspace).toBe(CWD);
    expect(parsed.sessionRef).toBe(sessionId);
    expect(parsed.activeMs).toBe(65_000);
    expect(parsed.tokens).toBe(500);
    expect(parsed.model).toBe('anthropic/claude-sonnet-4');
    expect(parsed.tools).toEqual(['read', 'write']);
    expect(parsed.unfinished).toBe(false);
    expect(parsed.containsTodo).toBe(false);
    expect(parsed.privacy).toBe('public_safe');
  });

  it('二次同步:内容相同 diff-skip,mtime 不变,不重复刷 index/log', async () => {
    const sessionId = 'sess-real-a';
    const jsonlPath = path.join(sessionsDir, `2026-08-08T09-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(jsonlPath, linearSessionJsonl(sessionId), 'utf8');

    await syncSessionFile(jsonlPath, 'ws');
    const first = await syncSessionFile(jsonlPath, 'ws');
    expect(first.isOk()).toBe(true);
    const rel = sessionConceptPath(first.unwrapOr(null as never));
    const mtime1 = statSync(path.join(ofkBundleRoot(), rel)).mtimeMs;
    const index1 = (await readConcept('index.md')).unwrapOr('');
    const log1 = (await readConcept('log.md')).unwrapOr('');

    const second = await syncSessionFile(jsonlPath, 'ws');
    expect(second.isOk()).toBe(true);
    const mtime2 = statSync(path.join(ofkBundleRoot(), rel)).mtimeMs;
    expect(mtime2).toBe(mtime1);
    expect((await readConcept('index.md')).unwrapOr('')).toBe(index1);
    expect((await readConcept('log.md')).unwrapOr('')).toBe(log1);
  });

  it('坏文件 → Err 不抛;缺头文件判 session-header-missing', async () => {
    const bad = path.join(sessionsDir, 'bad.jsonl');
    writeFileSync(bad, 'not-json-at-all\n', 'utf8');
    const result = await syncSessionFile(bad, 'ws');
    expect(result.isErr()).toBe(true);
    expect(result.match({ ok: () => '', err: (e) => e.code })).toBe('session-header-missing');

    const missing = path.join(sessionsDir, 'missing.jsonl');
    const unreadable = await syncSessionFile(missing, 'ws');
    expect(unreadable.isErr()).toBe(true);
    expect(unreadable.match({ ok: () => '', err: (e) => e.code })).toBe('session-file-unreadable');
  });

  it('buildSessionConcept: 无工具会话 → 无(共 0 次);无序列(插件源)→ 仅工具名列表', () => {
    const fact = makeFact({ tools: [] });
    const doc = buildSessionConcept(fact, null, 'work');
    expect(doc).toContain('category: work');
    expect(doc).toContain('## 智能体做了什么');
    expect(doc).toContain('- 调用工具：无');
    expect(doc).not.toContain('## 用户要求'); // 插件源无正文三段
    expect(doc).not.toContain('resource:'); // 无 jsonl 源

    const noTools = buildSessionConcept(fact, null, '未分类');
    expect(noTools).toContain('- 调用工具：无');
  });

  it('buildSessionConcept: 正文截断(>500 字符加 …)、YAML 特殊字符引号包裹、sessionRef 清洗', () => {
    const fact = makeFact({
      title: '带: 冒号的标题',
      sessionRef: 'bad/ref:name',
      workspace: 'C:\\work\\demo',
    });
    const doc = buildSessionConcept(fact, null, '未分类', 'C:\\src\\s.jsonl');
    expect(doc).toContain('title: "带: 冒号的标题"'); // 含冒号+空格 → 引号
    expect(doc).toContain('sessionRef: bad/ref:name'); // 原值保留(路径清洗只发生在文件名)
    expect(doc).toContain('resource: C:\\src\\s.jsonl');
    // sessionConceptPath 对非法文件名字符做清洗(路径防注入)
    const rel = sessionConceptPath(fact);
    expect(rel.endsWith('bad-ref-name.md')).toBe(true);

    // 正文截断:>500 字符的用户消息加 …
    const longText = 'y'.repeat(600);
    const seq: RawSessionEntry[] = [
      {
        id: 'm1',
        parentId: null,
        timestamp: BASE.getTime() + 5_000,
        message: { role: 'user', content: longText },
      },
    ];
    const truncated = buildSessionConcept(fact, seq, '未分类');
    expect(truncated).toContain(`- [09:05] ${'y'.repeat(500)}…`);
  });

  it('writeSessionConcept(插件源):sequence=null 写概念成功,路径/日志联动', async () => {
    const fact = makeFact({
      collector: 'claude-code',
      runtime: 'claude-code',
      agentId: 'claude-code',
    });
    const res = await writeSessionConcept(fact, 'work');
    expect(res.isOk()).toBe(true);
    const rel = sessionConceptPath(fact);
    // 非 pi 源 slug = basename 清洗
    expect(rel.startsWith(path.join('sessions', 'demo', '2026', '2026-08-08'))).toBe(true);
    const read = await readConcept(rel);
    expect(read.unwrapOr('')).toContain('category: work');
    const log = await readConcept('log.md');
    expect(log.unwrapOr('')).toContain('**Creation**');
    const index = await readConcept('index.md');
    expect(index.unwrapOr('')).toContain('## 会话');
  });

  it('computeBreaks: 相邻间隔 > 15 分钟 → 后一条消息时刻为断口;14 分 59 秒不断、15 分 1 秒断', () => {
    const base = BASE.getTime();
    const seq = (gapMs: number): RawSessionEntry[] => [
      { id: 'a', parentId: null, timestamp: base, message: { role: 'user', content: 'a' } },
      {
        id: 'b',
        parentId: 'a',
        timestamp: base + gapMs,
        message: { role: 'user', content: 'b' },
      },
    ];
    // 边界:恰 15 分钟不超阈值 → 不断;14 分 59 秒不断
    expect(computeBreaks(seq(SEGMENT_BREAK_GAP_MS))).toEqual([]);
    expect(computeBreaks(seq(SEGMENT_BREAK_GAP_MS - 1_000))).toEqual([]);
    // 15 分 1 秒断 → 断口 = 后一条消息时刻
    expect(computeBreaks(seq(SEGMENT_BREAK_GAP_MS + 1_000))).toEqual([
      base + SEGMENT_BREAK_GAP_MS + 1_000,
    ]);
    // 插件源 → []
    expect(computeBreaks(null)).toEqual([]);
    // 单消息 / 空序列 → []
    expect(
      computeBreaks([
        { id: 'x', parentId: null, timestamp: base, message: { role: 'user', content: '' } },
      ]),
    ).toEqual([]);
    expect(computeBreaks([])).toEqual([]);
  });

  it('computeBreaks: 乱序输入按时间升序判定,多个断口依次记录', () => {
    const base = BASE.getTime();
    const gap = SEGMENT_BREAK_GAP_MS + 1_000;
    const seq: RawSessionEntry[] = [
      {
        id: 'c',
        parentId: null,
        timestamp: base + 2 * gap,
        message: { role: 'user', content: 'c' },
      },
      { id: 'a', parentId: null, timestamp: base, message: { role: 'user', content: 'a' } },
      { id: 'b', parentId: null, timestamp: base + gap, message: { role: 'user', content: 'b' } },
    ];
    expect(computeBreaks(seq)).toEqual([base + gap, base + 2 * gap]);
  });

  it('buildSessionConcept: 序列含 20 分钟间隔 → frontmatter 写 breaks 行(间隔后消息时刻)', () => {
    const base = BASE.getTime();
    const seq: RawSessionEntry[] = [
      { id: 'm1', parentId: null, timestamp: base, message: { role: 'user', content: 'a' } },
      {
        id: 'm2',
        parentId: 'm1',
        timestamp: base + 20 * 60_000,
        message: { role: 'user', content: 'b' },
      },
    ];
    const doc = buildSessionConcept(makeFact(), seq, 'work');
    expect(doc).toContain(`breaks: [${base + 20 * 60_000}]`);
    // breaks 行位于 active_ms 之后
    expect(doc.indexOf('active_ms: 65000\n') < doc.indexOf(`breaks: [${base + 20 * 60_000}]`)).toBe(
      true,
    );
  });

  it('buildSessionConcept: 无 15 分钟级间隔 → 不写 breaks 行;插件源同', () => {
    // 线性序列:间隔 30s/35s,无断口
    const fact = makeFact();
    const seq: RawSessionEntry[] = [
      {
        id: 'm1',
        parentId: null,
        timestamp: BASE.getTime(),
        message: { role: 'user', content: 'a' },
      },
      {
        id: 'm2',
        parentId: 'm1',
        timestamp: BASE.getTime() + 35_000,
        message: { role: 'user', content: 'b' },
      },
    ];
    const doc = buildSessionConcept(fact, seq, 'work');
    expect(doc).not.toContain('\nbreaks:');
    // 插件源(sequence=null)→ 无 breaks 行
    const pluginDoc = buildSessionConcept(fact, null, 'work');
    expect(pluginDoc).not.toContain('\nbreaks:');
  });

  it('buildSessionConcept: description 入参 → frontmatter 写归纳;缺省 = title 播种', () => {
    const doc = buildSessionConcept(makeFact(), null, 'work', undefined, '修复登录测试');
    expect(doc).toContain('description: 修复登录测试');
    expect(doc).toContain('title: Fix the flaky login test');
    const seeded = buildSessionConcept(makeFact(), null, 'work');
    expect(seeded).toContain('description: Fix the flaky login test');
  });

  it('syncSessionFile: 重清洗保留编译写回的 description(归纳不被清洗覆盖)', async () => {
    const sessionId = 'sess-desc-a';
    const jsonlPath = path.join(sessionsDir, `2026-08-08T09-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(jsonlPath, linearSessionJsonl(sessionId), 'utf8');
    const first = await syncSessionFile(jsonlPath, 'ws');
    expect(first.isOk()).toBe(true);
    const rel = sessionConceptPath(first.unwrapOr(null as never));
    const file = path.join(ofkBundleRoot(), rel);
    // 模拟 P2 编译写回 description(LLM 整会话归纳)
    const seeded = readFileSync(file, 'utf8');
    expect(seeded).toContain('description: Fix the flaky login test');
    writeFileSync(
      file,
      seeded.replace(/^description:.*$/m, 'description: 修复了不稳定的登录测试'),
      'utf8',
    );
    // 重清洗 → description 保留、title 不变
    const second = await syncSessionFile(jsonlPath, 'ws');
    expect(second.isOk()).toBe(true);
    const doc = readFileSync(file, 'utf8');
    expect(doc).toContain('description: 修复了不稳定的登录测试');
    expect(doc).toContain('title: Fix the flaky login test');
  });
});
