import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonlCollector } from '../../src/main/ofk/builtin-collectors/collector-core';
import { readConcept, sessionConceptPath } from '../../src/main/ofk/ofk-bundle';
import { readSyncState } from '../../src/main/ofk/sync-state';
import { ok } from '../../src/shared/result';

// Requirement(plan S4/D3):jsonl 采集器增量——水位命中 + 概念在位 → 不重读;
// 未变文件二次 collect 返回空(不重复产出事实);改一个 → 仅该文件重读;
// 无时间戳文件 → 不记账(下轮重试)。

vi.mock('../../src/main/ofk/ofk-bundle', () => ({
  readConcept: vi.fn(),
  sessionConceptPath: vi.fn(),
}));

// node:fs 命名空间不可 spy(redefine blocked)→ 整模块 mock 透传真实实现,
// 用 vi.fn 包装 readFileSync 计数 jsonl 读取。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

import type * as NodeFs from 'node:fs';
import { readFileSync } from 'node:fs';

const SAMPLE = [
  { type: 'user', message: { role: 'user', content: 'Hi' }, timestamp: '2026-08-08T01:00:00.000Z' },
  {
    type: 'assistant',
    message: { role: 'assistant', content: 'Hello' },
    timestamp: '2026-08-08T01:01:00.000Z',
  },
]
  .map((l) => JSON.stringify(l))
  .join('\n');

describe('collector-core jsonl 增量', () => {
  let root: string;
  let fileA: string;
  let fileB: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lorra-jsonl-root-'));
    fileA = path.join(root, 'ws1', 'sess-a.jsonl');
    fileB = path.join(root, 'ws1', 'sess-b.jsonl');
    mkdirSync(path.dirname(fileA), { recursive: true });
    writeFileSync(fileA, SAMPLE, 'utf8');
    writeFileSync(fileB, SAMPLE, 'utf8');

    vi.mocked(readConcept).mockReset();
    vi.mocked(readConcept).mockResolvedValue(ok('concept-content'));
    vi.mocked(sessionConceptPath).mockImplementation((fact) => `sessions/${fact.sessionRef}.md`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function makeCollector() {
    return createJsonlCollector({
      name: 'claude-code',
      runtimePrefix: 'claude-code',
      root: () => root,
      workspaceOf: () => 'E:/work/demo',
    });
  }

  it('首次 collect 全量(2 文件 → 2 facts)+ 两文件水位记录', async () => {
    const collector = makeCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toHaveLength(2);
    const state = await readSyncState();
    expect(state.files[fileA]).toBeDefined();
    expect(state.files[fileB]).toBeDefined();
  });

  it('二次 collect(未变 + 概念在位)→ 不重读 jsonl、返回空 facts、不写盘', async () => {
    const collector = makeCollector();
    await collector.collect();
    vi.mocked(readFileSync).mockClear();
    const result = await collector.collect();
    // 只允许 sync-state.json 自身被读;jsonl 一律不重读
    const jsonlReads = vi
      .mocked(readFileSync)
      .mock.calls.filter(([p]) => String(p).startsWith(root));
    expect(jsonlReads).toHaveLength(0);
    expect(result.unwrapOr([])).toEqual([]);
    expect(vi.mocked(readConcept)).toHaveBeenCalledWith('sessions/claude-code-sess-a.md');
  });

  it('改一个文件 → 仅该文件重读且重产出', async () => {
    const collector = makeCollector();
    await collector.collect();
    writeFileSync(fileA, `${SAMPLE}\n`, 'utf8'); // mtime+size 变化
    vi.mocked(readFileSync).mockClear();
    const result = await collector.collect();
    const jsonlReads = vi
      .mocked(readFileSync)
      .mock.calls.filter(([p]) => String(p).startsWith(root))
      .map(([p]) => p);
    expect(jsonlReads).toEqual([fileA]);
    const facts = result.unwrapOr([]);
    expect(facts).toHaveLength(1);
    expect(facts[0].sessionRef).toBe('claude-code-sess-a');
    // 水位更新为新 stat
    const state = await readSyncState();
    expect(state.files[fileA].size).toBe(statSync(fileA).size);
  });

  it('概念缺失(被删)→ 强制重提:即使文件未变也重读', async () => {
    const collector = makeCollector();
    await collector.collect();
    vi.mocked(readConcept).mockResolvedValue(ok(null)); // 概念被删
    vi.mocked(readFileSync).mockClear();
    const result = await collector.collect();
    const jsonlReads = vi
      .mocked(readFileSync)
      .mock.calls.filter(([p]) => String(p).startsWith(root));
    expect(jsonlReads).toHaveLength(2);
    expect(result.unwrapOr([])).toHaveLength(2);
  });

  it('conceptRel 记录正确(随 fact 的 sessionRef 生成)', async () => {
    const collector = makeCollector();
    await collector.collect();
    const state = await readSyncState();
    expect(state.files[fileA].conceptRel).toBe('sessions/claude-code-sess-a.md');
    expect(state.files[fileB].conceptRel).toBe('sessions/claude-code-sess-b.md');
  });

  it('无时间戳文件 → 不记账,下轮仍重读(极小文件,可接受)', async () => {
    const noTs = path.join(root, 'ws1', 'sess-nots.jsonl');
    writeFileSync(noTs, '{"type":"user","message":{"role":"user","content":"x"}}\n', 'utf8');
    const collector = makeCollector();
    const first = await collector.collect();
    expect(first.unwrapOr([])).toHaveLength(2); // 仅两个有时间戳的
    const state = await readSyncState();
    expect(state.files[noTs]).toBeUndefined();
    vi.mocked(readFileSync).mockClear();
    await collector.collect();
    const jsonlReads = vi
      .mocked(readFileSync)
      .mock.calls.filter(([p]) => String(p).startsWith(root));
    expect(jsonlReads).toHaveLength(1); // 只有 noTs 被重读
  });
});
