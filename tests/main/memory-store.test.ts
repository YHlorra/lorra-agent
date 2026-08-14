import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entryIdOf } from '../../src/main/memory/entry-hash';
import {
  MEMORY_BUSY_TIMEOUT_MS,
  MEMORY_LINK_MAX,
  MEMORY_RECALL_HOP_MAX,
  MemoryStore,
  type ProposeInput,
} from '../../src/main/memory/memory-store';
import {
  getSharedMemoryStore,
  resetSharedMemoryStoreForTest,
} from '../../src/main/memory/shared-memory-store';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_EVIDENCE_ORDER,
  MEMORY_KINDS,
  MEMORY_RECALL_TOP_K,
  MEMORY_SPLIT_SUMMARY_MAX_BYTES,
  MEMORY_SPLIT_THRESHOLD_BYTES,
  type MemoryEntry,
  type MemoryEvidence,
  type MemoryKind,
  type MemorySource,
} from '../../src/shared/memory-schema';
import type { Result } from '../../src/shared/result';

// 存储核心契约 + 自主记忆改造:
// 无候选闸门——propose 直落 active(confirmedAt=now)、update/edit 走 supersedes
// 链、retire 即时撤销、开库迁移(candidate→active/rejected→retired 幂等)、
// listEvents 审计(ts 倒序)、八类 corpus 播种、FTS5 检索(仅 active + scope 过滤)、
// recall 排序(evidence 序 > 新鲜度 > 可选 BM25)、哈希幂等(entryIdOf)。

const storeRegistry: Array<{ close(): void }> = [];

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function expectErr<T>(result: Result<T>): { code: string; message: string } {
  expect(result.isErr()).toBe(true);
  return result.match({
    ok: () => {
      throw new Error('expected Err, got Ok');
    },
    err: (e) => e,
  });
}

function openStore(dir: string, name = 'memory.db'): MemoryStore {
  const store = expectOk(MemoryStore.open(path.join(dir, name)));
  storeRegistry.push(store);
  return store;
}

function makePropose(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return {
    kind: 'working_context',
    title: 'Flaky login test',
    content: 'The login flow fails intermittently on CI when the network drops',
    producer: 'agent-1',
    source: 'agent-proposal',
    scope: 'workspace',
    workspace: 'C:\\work\\demo',
    evidence: 'user-stated',
    basis: 'User stated this during the review session',
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-memory-'));
  });
  afterEach(() => {
    for (const store of storeRegistry.splice(0)) store.close();
    resetSharedMemoryStoreForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it('建表: open 创建库文件, corpus 六类各一行, entries/event_log 可写', () => {
    const dbPath = path.join(dir, 'memory.db');
    const store = openStore(dir);
    expect(existsSync(dbPath)).toBe(true);

    const corpus = expectOk(store.listCorpus());
    expect(corpus).toHaveLength(MEMORY_KINDS.length);
    // 枚举断言:六类 kind 恰好各一行
    expect(corpus.map((c) => c.kind).sort()).toEqual([...MEMORY_KINDS].sort());
    expect(new Set(corpus.map((c) => c.kind)).size).toBe(MEMORY_KINDS.length);

    // entries 可写:propose 直落 active
    const entry = expectOk(store.propose(makePropose()));
    expect(entry.lifecycle).toBe('active');

    // event_log 可写:recorded 审计事件
    const events = expectOk(store.listEvents());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entryId: entry.entryId, event: 'recorded' });
  });

  it('存储纪律: WAL journal mode 生效 + busy_timeout ≥ 5s', () => {
    const dbPath = path.join(dir, 'memory.db');
    openStore(dir);
    const raw = new DatabaseSync(dbPath);
    try {
      const row = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(row.journal_mode).toBe('wal');
    } finally {
      raw.close();
    }
    expect(MEMORY_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('六类枚举: 全部 kind 均可 propose 成功且直落 active', () => {
    const store = openStore(dir);
    for (const kind of MEMORY_KINDS) {
      const entry = expectOk(store.propose(makePropose({ kind })));
      expect(entry.kind).toBe(kind);
      expect(entry.lifecycle).toBe('active');
    }
    expect(expectOk(store.listActive())).toHaveLength(MEMORY_KINDS.length);
  });

  it('evidence 四态: 四态任意可落', () => {
    const store = openStore(dir);
    for (const evidence of MEMORY_EVIDENCE_ORDER) {
      const entry = expectOk(store.propose(makePropose({ evidence })));
      expect(entry.evidence).toBe(evidence);
    }
    expect(expectOk(store.listActive())).toHaveLength(MEMORY_EVIDENCE_ORDER.length);
  });

  it('entry_id 幂等: 同内容两次 propose -> 仅一条记录, 第二次返回既有条目', () => {
    const store = openStore(dir);
    const input = makePropose();
    const first = expectOk(store.propose(input));
    const second = expectOk(store.propose(input));

    expect(second.entryId).toBe(first.entryId);
    expect(second).toEqual(first);
    expect(expectOk(store.listActive()).filter((c) => c.entryId === first.entryId)).toHaveLength(1);
    // 幂等命中不重复记审计事件
    const recorded = expectOk(store.listEvents(first.entryId)).filter(
      (e) => e.event === 'recorded',
    );
    expect(recorded).toHaveLength(1);
  });

  it('自主语义: propose 直落 active + confirmedAt=now, 立即可召回, evidence/basis 不重估', () => {
    const store = openStore(dir);
    const input = makePropose();
    const entry = expectOk(store.propose(input));
    const params = { scope: 'workspace' as const, workspace: 'C:\\work\\demo' };

    // 直落 active + 确认时间戳非空(无确认环节,写入即激活)
    expect(entry.lifecycle).toBe('active');
    expect(entry.confirmedAt).toBeTypeOf('number');
    expect(entry.confirmedAt).not.toBeNull();
    expect(entry.supersedes).toBeNull();

    // 立即进召回池(闸门拆除后无需 confirm 步骤)
    const recalled = expectOk(store.recall(params));
    expect(recalled.map((e) => e.entryId)).toContain(entry.entryId);

    // evidence/basis 与入参逐字段一致(写入不改变证据等级)
    expect(entry.evidence).toBe(input.evidence);
    expect(entry.basis).toBe(input.basis);

    // 落库读回同样逐字段相等
    const active = expectOk(store.listActive()).find((e) => e.entryId === entry.entryId);
    expect(active).toBeDefined();
    expect(active?.evidence).toBe(input.evidence);
    expect(active?.basis).toBe(input.basis);
    expect(active?.lifecycle).toBe('active');
  });

  it('自主更新: update 部分补丁(title/content/basis 任意组合)走 supersedes 链', () => {
    const store = openStore(dir);
    const original = expectOk(store.propose(makePropose()));

    // 只改 title:content 继承原值
    const byTitle = expectOk(store.update(original.entryId, { title: '新标题' }));
    expect(byTitle.title).toBe('新标题');
    expect(byTitle.content).toBe(original.content);
    expect(byTitle.entryId).not.toBe(original.entryId);
    expect(byTitle.lifecycle).toBe('active');
    expect(byTitle.supersedes).toBe(original.entryId);
    expect(byTitle.confirmedAt).not.toBeNull();
    // 继承 kind/evidence/basis/scope/workspace
    expect(byTitle.kind).toBe(original.kind);
    expect(byTitle.evidence).toBe(original.evidence);
    expect(byTitle.basis).toBe(original.basis);
    expect(byTitle.scope).toBe(original.scope);
    expect(byTitle.workspace).toBe(original.workspace);

    // 在 byTitle 上只改 basis:title 继承
    const byBasis = expectOk(store.update(byTitle.entryId, { basis: '新依据' }));
    expect(byBasis.basis).toBe('新依据');
    expect(byBasis.title).toBe('新标题');
    expect(byBasis.supersedes).toBe(byTitle.entryId);

    // 空补丁 → no-change
    expect(expectErr(store.update(byBasis.entryId, {})).code).toBe('no-change');

    // 链完整: 前两代在归档(superseded), 仅链尾在 active
    const archived = expectOk(store.listArchived());
    expect(archived.map((e) => e.entryId)).toEqual(
      expect.arrayContaining([original.entryId, byTitle.entryId]),
    );
    expect(archived.map((e) => e.entryId)).not.toContain(byBasis.entryId);
    expect(archived.find((e) => e.entryId === original.entryId)?.lifecycle).toBe('superseded');
    expect(archived.find((e) => e.entryId === byTitle.entryId)?.lifecycle).toBe('superseded');
    expect(expectOk(store.listActive()).map((e) => e.entryId)).toEqual([byBasis.entryId]);

    // edited 事件 detail 记 原id→新id
    const ev = expectOk(store.listEvents(byTitle.entryId)).find((e) => e.event === 'edited');
    expect(ev?.detail).toBe(`${original.entryId}→${byTitle.entryId}`);

    // 召回只含链尾
    const params = { scope: 'workspace' as const, workspace: 'C:\\work\\demo' };
    const recalled = expectOk(store.recall(params)).map((e) => e.entryId);
    expect(recalled).toContain(byBasis.entryId);
    expect(recalled).not.toContain(original.entryId);
    expect(recalled).not.toContain(byTitle.entryId);
  });

  it('自主语义: edit 与 update 同语义——新条目 active + supersedes 指回, 原条目 superseded', () => {
    const store = openStore(dir);
    const original = expectOk(store.propose(makePropose()));

    const edited = expectOk(
      store.edit(original.entryId, 'Cache strategy', 'Use an LRU cache for model config reads'),
    );

    // 新 entry: active + supersedes 指回原 id + 内容为新内容 + 继承 kind/evidence
    expect(edited.entryId).not.toBe(original.entryId);
    expect(edited.lifecycle).toBe('active');
    expect(edited.supersedes).toBe(original.entryId);
    expect(edited.content).toBe('Use an LRU cache for model config reads');
    expect(edited.kind).toBe(original.kind);
    expect(edited.evidence).toBe(original.evidence);
    expect(edited.basis).toBe(original.basis);
    expect(edited.confirmedAt).not.toBeNull();

    // 原 entry 置 superseded, 进归档; 新 entry 在 active 列表
    const active = expectOk(store.listActive());
    expect(active.map((e) => e.entryId)).not.toContain(original.entryId);
    expect(active.map((e) => e.entryId)).toContain(edited.entryId);
    const archived = expectOk(store.listArchived());
    expect(archived.map((e) => e.entryId)).toContain(original.entryId);
    expect(archived.find((e) => e.entryId === original.entryId)?.lifecycle).toBe('superseded');

    // recall 只含新 entry
    const params = { scope: 'workspace' as const, workspace: 'C:\\work\\demo' };
    const recalled = expectOk(store.recall(params)).map((e) => e.entryId);
    expect(recalled).toContain(edited.entryId);
    expect(recalled).not.toContain(original.entryId);

    // edited 审计事件 detail 记 原id→新id
    const editedEvent = expectOk(store.listEvents(edited.entryId)).find(
      (e) => e.event === 'edited',
    );
    expect(editedEvent?.detail).toBe(`${original.entryId}→${edited.entryId}`);
  });

  it('自主语义: retire 后 recall 不再返回, listArchived 可见', () => {
    const store = openStore(dir);
    const entry = expectOk(store.propose(makePropose()));
    const params = { scope: 'workspace' as const, workspace: 'C:\\work\\demo' };

    expect(expectOk(store.recall(params)).map((e) => e.entryId)).toContain(entry.entryId);

    const retired = expectOk(store.retire(entry.entryId));
    expect(retired.lifecycle).toBe('retired');
    // retired 审计事件
    expect(expectOk(store.listEvents(entry.entryId)).map((e) => e.event)).toEqual([
      'retired',
      'recorded',
    ]);

    expect(expectOk(store.recall(params)).map((e) => e.entryId)).not.toContain(entry.entryId);
    expect(expectOk(store.listActive()).map((e) => e.entryId)).not.toContain(entry.entryId);
    const archived = expectOk(store.listArchived()).map((e) => e.entryId);
    expect(archived).toContain(entry.entryId);
  });

  it('迁移: 旧闸门库 candidate→active、rejected→retired(开库幂等, 旧 event 行保留原文)', () => {
    const dbPath = path.join(dir, 'memory.db');
    // 先用新 store 建库并写入两条(可 raw 改 lifecycle 模拟旧库)
    const store = openStore(dir);
    const cand = expectOk(store.propose(makePropose({ title: '旧候选' })));
    const rej = expectOk(
      store.propose(makePropose({ title: '旧被拒', content: 'rejected in old gate' })),
    );
    store.close();

    // 模拟旧闸门库: 直接改写 lifecycle + 插入旧版 event 行(proposed/rejected)
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE entries SET lifecycle = 'candidate' WHERE entry_id = ?")
        .run(cand.entryId);
      raw.prepare("UPDATE entries SET lifecycle = 'rejected' WHERE entry_id = ?").run(rej.entryId);
      raw
        .prepare('INSERT INTO event_log (ts, entry_id, event, detail) VALUES (?, ?, ?, ?)')
        .run(1000, cand.entryId, 'proposed', null);
      raw
        .prepare('INSERT INTO event_log (ts, entry_id, event, detail) VALUES (?, ?, ?, ?)')
        .run(1001, rej.entryId, 'rejected', null);
    } finally {
      raw.close();
    }

    // 重新打开 → 迁移生效: candidate → active(进生效区), rejected → retired(进归档)
    const reopened = openStore(dir);
    const active = expectOk(reopened.listActive());
    expect(active.map((e) => e.entryId)).toContain(cand.entryId);
    expect(active.find((e) => e.entryId === cand.entryId)?.lifecycle).toBe('active');
    const archived = expectOk(reopened.listArchived());
    expect(archived.find((e) => e.entryId === rej.entryId)?.lifecycle).toBe('retired');
    // 迁移后立即可召回(旧候选已被激活)
    expect(
      expectOk(reopened.recall({ scope: 'workspace', workspace: 'C:\\work\\demo' })).map(
        (e) => e.entryId,
      ),
    ).toContain(cand.entryId);

    // 幂等: 再关再开不翻车(无 candidate/rejected 行可迁 = no-op)
    reopened.close();
    const third = openStore(dir);
    expect(expectOk(third.listActive()).map((e) => e.entryId)).toContain(cand.entryId);
    expect(expectOk(third.listArchived()).find((e) => e.entryId === rej.entryId)?.lifecycle).toBe(
      'retired',
    );

    // 旧 event 行保留原文(迁移不改写 event_log)
    const candEvents = expectOk(third.listEvents(cand.entryId)).map((e) => e.event);
    expect(candEvents).toContain('proposed');
    const rejEvents = expectOk(third.listEvents(rej.entryId)).map((e) => e.event);
    expect(rejEvents).toContain('rejected');
  });

  it('退化: content 超 MEMORY_CONTENT_MAX_BYTES -> content-too-long (2048 字节边界)', () => {
    const store = openStore(dir);
    const asciiMax = expectOk(
      store.propose(makePropose({ content: 'a'.repeat(MEMORY_CONTENT_MAX_BYTES) })),
    );
    expect(asciiMax.content).toHaveLength(MEMORY_CONTENT_MAX_BYTES);

    const tooLong = expectErr(
      store.propose(makePropose({ content: 'a'.repeat(MEMORY_CONTENT_MAX_BYTES + 1) })),
    );
    expect(tooLong.code).toBe('content-too-long');

    // utf8 多字节: 683 个汉字 = 2049 字节
    const cnMax = expectOk(store.propose(makePropose({ content: '中'.repeat(682) })));
    expect(Buffer.byteLength(cnMax.content, 'utf8')).toBe(2046);
    const cnTooLong = expectErr(store.propose(makePropose({ content: '中'.repeat(683) })));
    expect(cnTooLong.code).toBe('content-too-long');
  });

  it('退化: 非法状态转换 -> invalid-state (retire 非 active)', () => {
    const store = openStore(dir);
    const entry = expectOk(store.propose(makePropose()));

    // retire 已 retired 条目
    expectOk(store.retire(entry.entryId));
    expect(expectErr(store.retire(entry.entryId)).code).toBe('invalid-state');
    // retire superseded 条目
    const other = expectOk(store.propose(makePropose({ title: 'Another note' })));
    expectOk(store.update(other.entryId, { title: 'Another note v2' }));
    expect(expectErr(store.retire(other.entryId)).code).toBe('invalid-state');
  });

  it('退化: update 未变内容 -> no-change', () => {
    const store = openStore(dir);
    const entry = expectOk(store.propose(makePropose()));
    // 全量补丁与原文一致
    const err = expectErr(
      store.update(entry.entryId, { title: entry.title, content: entry.content }),
    );
    expect(err.code).toBe('no-change');
    // 空补丁
    expect(expectErr(store.update(entry.entryId, {})).code).toBe('no-change');
    expect(expectOk(store.listActive())).toHaveLength(1);
    expect(expectOk(store.listArchived())).toHaveLength(0);
  });

  it('退化: 不存在的 entryId -> not-found (update/retire/edit)', () => {
    const store = openStore(dir);
    expect(expectErr(store.update('deadbeef'.repeat(8), { title: 't' })).code).toBe('not-found');
    expect(expectErr(store.retire('deadbeef'.repeat(8))).code).toBe('not-found');
    expect(expectErr(store.edit('deadbeef'.repeat(8), 't', 'c')).code).toBe('not-found');
  });

  it('退化: 空库 search/recall/列表均返回空数组', () => {
    const store = openStore(dir);
    expect(expectOk(store.search({ query: 'cache' }))).toEqual([]);
    expect(expectOk(store.recall({ scope: 'workspace', workspace: 'C:\\work\\demo' }))).toEqual([]);
    expect(expectOk(store.listActive())).toEqual([]);
    expect(expectOk(store.listArchived())).toEqual([]);
    expect(expectOk(store.listEvents())).toEqual([]);
  });

  it('退化: scope 隔离 - workspaceA 条目在 workspaceB 查询下不可见, user 级全局可见', () => {
    const store = openStore(dir);
    const inA = expectOk(
      store.propose(
        makePropose({ title: 'A note', workspace: 'WA', content: 'cache in workspace A' }),
      ),
    );
    const inB = expectOk(
      store.propose(
        makePropose({ title: 'B note', workspace: 'WB', content: 'cache in workspace B' }),
      ),
    );
    const userNote = expectOk(
      store.propose(
        makePropose({
          title: 'User note',
          scope: 'user',
          workspace: null,
          content: 'cache global user note',
        }),
      ),
    );

    const queryB = { scope: 'workspace' as const, workspace: 'WB' };
    const recalled = expectOk(store.recall(queryB)).map((e) => e.entryId);
    expect(recalled).toContain(inB.entryId);
    expect(recalled).toContain(userNote.entryId); // user 级全局可见
    expect(recalled).not.toContain(inA.entryId);

    const searched = expectOk(store.search({ query: 'cache', ...queryB })).map((e) => e.entryId);
    expect(searched).toContain(inB.entryId);
    expect(searched).toContain(userNote.entryId);
    expect(searched).not.toContain(inA.entryId);

    // 不传 scope -> 不过滤, 全部可见
    expect(expectOk(store.search({ query: 'cache' }))).toHaveLength(3);
  });

  it('FTS5: search 命中相关词、不命中无关词, 按命中位置启发式排序', () => {
    const store = openStore(dir);
    const sparse = expectOk(
      store.propose(
        makePropose({
          kind: 'knowledge',
          title: 'Cache strategy',
          content: 'Use a cache for repeated reads',
        }),
      ),
    );
    const dense = expectOk(
      store.propose(
        makePropose({
          kind: 'knowledge',
          title: 'Cache',
          content: 'cache cache cache cache cache cache',
        }),
      ),
    );
    const unrelated = expectOk(
      store.propose(
        makePropose({
          kind: 'knowledge',
          title: 'Flaky login',
          content: 'The login flow fails intermittently on CI',
        }),
      ),
    );

    const hits = expectOk(store.search({ query: 'cache' }));
    expect(hits.map((e) => e.entryId).sort()).toEqual([dense.entryId, sparse.entryId].sort());
    // 命中位置启发式:cache 在 dense 开头(pos 0)先于 sparse(pos 8)
    expect(hits[0].entryId).toBe(dense.entryId);
    expect(hits[1].entryId).toBe(sparse.entryId);

    expect(expectOk(store.search({ query: 'login' })).map((e) => e.entryId)).toEqual([
      unrelated.entryId,
    ]);
    expect(expectOk(store.search({ query: 'nonexistenttermxyz' }))).toEqual([]);
    // 空查询 -> 空结果（不抛语法错误）
    expect(expectOk(store.search({ query: '' }))).toEqual([]);
  });

  it('trigram: 中文子串检索——2 字/3 字/任意子串命中（unicode61 整词分词的替代）', () => {
    const store = openStore(dir);
    const flash = expectOk(
      store.propose(
        makePropose({
          title: '登录问题',
          content: '登录测试偶尔闪断，重试即可',
        }),
      ),
    );
    const weekly = expectOk(
      store.propose(
        makePropose({
          title: '周报节奏',
          content: '周报节奏周五写，复盘周一看',
        }),
      ),
    );

    // 2 字子串（旧 unicode61 整词分词必挂的场景）
    expect(expectOk(store.search({ query: '登录' })).map((e) => e.entryId)).toEqual([
      flash.entryId,
    ]);
    expect(expectOk(store.search({ query: '闪断' })).map((e) => e.entryId)).toEqual([
      flash.entryId,
    ]);
    // 任意子串（跨词边界）
    expect(expectOk(store.search({ query: '试偶尔' })).map((e) => e.entryId)).toEqual([
      flash.entryId,
    ]);
    expect(expectOk(store.search({ query: '周报' })).map((e) => e.entryId)).toEqual([
      weekly.entryId,
    ]);
    // 多 token AND
    expect(expectOk(store.search({ query: '登录 重试' })).map((e) => e.entryId)).toEqual([
      flash.entryId,
    ]);
    expect(expectOk(store.search({ query: '登录 周五' }))).toEqual([]);
  });

  it('LIKE 通配符转义: % 与 _ 按字面匹配，不放大为通配', () => {
    const store = openStore(dir);
    const progress = expectOk(
      store.propose(
        makePropose({
          title: '进度',
          content: '完成 100% 的目标，check_ok 通过',
        }),
      ),
    );
    const weekly = expectOk(
      store.propose(
        makePropose({
          title: '周报节奏',
          content: '周报节奏周五写',
        }),
      ),
    );

    expect(expectOk(store.search({ query: '100%' })).map((e) => e.entryId)).toEqual([
      progress.entryId,
    ]);
    expect(expectOk(store.search({ query: 'check_ok' })).map((e) => e.entryId)).toEqual([
      progress.entryId,
    ]);
    // 字面 % 与 _：只命中确实含该字符的条目（未转义会通配命中全部）
    expect(expectOk(store.search({ query: '%' })).map((e) => e.entryId)).toEqual([
      progress.entryId,
    ]);
    expect(expectOk(store.search({ query: '_' })).map((e) => e.entryId)).toEqual([
      progress.entryId,
    ]);
    expect(weekly.entryId).not.toBe(progress.entryId); // 两条独立条目,通配会全命中
  });

  it('排序启发式: 命中位置靠前优先；同位置内容短者优先', () => {
    const store = openStore(dir);
    const late = expectOk(
      store.propose(
        makePropose({
          title: '迟到命中',
          content: '开头无关内容很长很长很长，最后出现 target 字样',
        }),
      ),
    );
    const earlyLong = expectOk(
      store.propose(
        makePropose({
          title: '早命中但长',
          content: 'target 开头命中但后面有很多很多很多很多很多很多很多内容',
        }),
      ),
    );
    const earlyShort = expectOk(
      store.propose(
        makePropose({
          title: '早命中且短',
          content: 'target 短内容',
        }),
      ),
    );

    const hits = expectOk(store.search({ query: 'target' })).map((e) => e.entryId);
    expect(hits[0]).toBe(earlyShort.entryId); // 位置同为 0,内容最短优先
    expect(hits[1]).toBe(earlyLong.entryId);
    expect(hits[2]).toBe(late.entryId);
  });

  it('迁移: 旧 unicode61 entries_fts 开库重建为 trigram，中文子串检索可用', () => {
    // 手工构造旧版库：unicode61 整词分词 + 一条中文条目
    const dbPath = path.join(dir, 'legacy.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE entries (
        entry_id TEXT PRIMARY KEY, corpus_kind TEXT NOT NULL, schema_version INTEGER NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, producer TEXT NOT NULL, source TEXT NOT NULL,
        scope TEXT NOT NULL, workspace TEXT, evidence TEXT NOT NULL, basis TEXT NOT NULL,
        lifecycle TEXT NOT NULL, supersedes TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, confirmed_at INTEGER
      );
      CREATE VIRTUAL TABLE entries_fts USING fts5(title, content, entry_id UNINDEXED);
    `);
    legacy
      .prepare('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        'legacy-1',
        'knowledge',
        1,
        '登录问题',
        '登录测试偶尔闪断',
        'p',
        'agent-proposal',
        'workspace',
        'C:\\work\\demo',
        'user-stated',
        'b',
        'active',
        null,
        1,
        1,
        1,
      );
    legacy.exec(
      "INSERT INTO entries_fts (title, content, entry_id) VALUES ('登录问题', '登录测试偶尔闪断', 'legacy-1')",
    );
    legacy.close();

    const store = expectOk(MemoryStore.open(dbPath));
    // 子串命中 = FTS 已重建为 trigram（旧 unicode61 对 2 字子串必挂）
    const hits = expectOk(store.search({ query: '登录' }));
    expect(hits.map((e) => e.entryId)).toContain('legacy-1');
    store.close();
    // 再次打开幂等
    const reopened = expectOk(MemoryStore.open(dbPath));
    expect(expectOk(reopened.search({ query: '闪断' })).map((e) => e.entryId)).toContain(
      'legacy-1',
    );
    reopened.close();
  });

  it('recall 可选 query: 命中参与第三排序键（同 evidence 下新鲜度优先），未命中条目不过滤', () => {
    // 时间戳用 fake timers 确定性拉开（规则：测试不 sleep 真实时钟）
    vi.useFakeTimers();
    const store = openStore(dir);
    vi.setSystemTime(1_700_000_000_000);
    const matching = expectOk(
      store.propose(makePropose({ title: 'Cache note', content: 'cache cache cache' })),
    );
    vi.setSystemTime(1_700_000_000_005);
    const nonMatching = expectOk(
      store.propose(makePropose({ title: 'Login note', content: 'login flow on CI' })),
    );
    const params = { scope: 'workspace' as const, workspace: 'C:\\work\\demo' };

    // 同 evidence(user-stated)下: 新鲜度 > 查询命中, 排序键顺序 = evidence > 新鲜度 > 命中位置
    const withQuery = expectOk(store.recall({ ...params, query: 'cache' })).map((e) => e.entryId);
    expect(withQuery[0]).toBe(nonMatching.entryId);
    // 命中只参与排序, 不过滤未命中条目
    expect(withQuery).toContain(matching.entryId);
    expect(withQuery).toHaveLength(2);

    // 无 query 时同样新鲜度优先
    const withoutQuery = expectOk(store.recall(params)).map((e) => e.entryId);
    expect(withoutQuery[0]).toBe(nonMatching.entryId);
    vi.useRealTimers();
  });

  it('recall 中文 query: 命中位置参与排序且不过滤未命中条目', () => {
    vi.useFakeTimers();
    const store = openStore(dir);
    vi.setSystemTime(1_700_000_000_000);
    const flash = expectOk(
      store.propose(
        makePropose({
          title: '登录问题',
          content: '登录测试偶尔闪断',
          evidence: 'extracted',
        }),
      ),
    );
    vi.setSystemTime(1_700_000_000_005);
    const weekly = expectOk(
      store.propose(
        makePropose({
          title: '周报节奏',
          content: '周报节奏周五写',
          evidence: 'extracted',
        }),
      ),
    );

    const params = { scope: 'workspace' as const, workspace: 'C:\\work\\demo' };
    const recalled = expectOk(store.recall({ ...params, query: '登录' })).map((e) => e.entryId);
    // 同 evidence 同新鲜度排序由命中位置决定;未命中条目不被过滤
    expect(recalled).toContain(flash.entryId);
    expect(recalled).toContain(weekly.entryId);
    expect(recalled[0]).toBe(weekly.entryId); // 更新者优先(新鲜度 > 命中)
    vi.useRealTimers();
  });

  it('证据排序: 同新鲜度下 user-stated 排在 unverified 之前', () => {
    const store = openStore(dir);
    const stated = expectOk(store.propose(makePropose({ evidence: 'user-stated' })));
    const unverified = expectOk(
      store.propose(makePropose({ evidence: 'unverified', title: 'Second note' })),
    );

    const recalled = expectOk(store.recall({ scope: 'workspace', workspace: 'C:\\work\\demo' }));
    expect(recalled.map((e) => e.entryId)).toEqual([stated.entryId, unverified.entryId]);
  });

  it('审计: listEvents 按 ts 倒序, edit 链 detail 记 原id→新id', () => {
    const store = openStore(dir);
    const entry = expectOk(store.propose(makePropose()));
    const updated = expectOk(store.update(entry.entryId, { title: '改' }));

    // 原条目仅 recorded; 新条目的 edited 事件 detail 记 原id→新id
    expect(expectOk(store.listEvents(entry.entryId)).map((e) => e.event)).toEqual(['recorded']);
    const edited = expectOk(store.listEvents(updated.entryId)).find((e) => e.event === 'edited');
    expect(edited?.detail).toBe(`${entry.entryId}→${updated.entryId}`);

    // 无过滤时返回全部且 ts 倒序
    const all = expectOk(store.listEvents());
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].ts).toBeGreaterThanOrEqual(all[i].ts);
    }
  });
});

describe('getSharedMemoryStore（共享单例）', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-shared-memory-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSharedMemoryStoreForTest();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('默认路径 ~/.lorra/memory/memory.db, 多次调用返回同一实例', () => {
    const a = getSharedMemoryStore();
    const b = getSharedMemoryStore();
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    expect(a.value).toBe(b.value);
    expect(existsSync(path.join(userdata, '.lorra', 'memory', 'memory.db'))).toBe(true);
  });

  it('单例实例可用: 经同一引用 propose/recall 一致', () => {
    const store = expectOk(getSharedMemoryStore());
    const entry = expectOk(store.propose(makePropose()));
    const recalled = expectOk(store.recall({ scope: 'workspace', workspace: 'C:\\work\\demo' }));
    expect(recalled.map((e) => e.entryId)).toContain(entry.entryId);
  });

  it('reset 测试钩子: reset 后下一次调用返回新实例', () => {
    const first = expectOk(getSharedMemoryStore());
    expect(expectOk(getSharedMemoryStore())).toBe(first);

    resetSharedMemoryStoreForTest();
    const second = expectOk(getSharedMemoryStore());
    expect(second).not.toBe(first);
    expect(expectOk(getSharedMemoryStore())).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// ingest 编译匹配 compileMatch(标题/首段命中,确定性路由):
// 提取产物 → 找既有 knowledge 页就地 update,而非盲目新增。
// ---------------------------------------------------------------------------

describe('compileMatch(ingest 编译匹配)', () => {
  it('标题命中:提取标题与既有页一致 → 返回该页', () => {
    const store = openStore(mkdtempSync(path.join(tmpdir(), 'lorra-cm-')));
    const existing = expectOk(
      store.propose(
        makePropose({
          kind: 'knowledge',
          title: 'Rust 所有权模型',
          content: '所有权模型在编译期防止数据竞争。',
        }),
      ),
    );
    const hit = expectOk(
      store.compileMatch({ title: 'Rust 所有权模型', content: '所有权模型详解。' }),
    );
    expect(hit?.entryId).toBe(existing.entryId);
  });

  it('标题包含命中:提取标题含既有标题(或反向)→ 返回该页', () => {
    const store = openStore(mkdtempSync(path.join(tmpdir(), 'lorra-cm-')));
    expectOk(
      store.propose(
        makePropose({ kind: 'knowledge', title: 'SQLite', content: 'WAL 模式并发读写不互锁。' }),
      ),
    );
    const hit = expectOk(store.compileMatch({ title: 'SQLite 优化技巧', content: 'WAL…' }));
    expect(hit?.title).toBe('SQLite');
  });

  it('首段命中:内容首段互相包含(≥6 字符)→ 返回该页', () => {
    const store = openStore(mkdtempSync(path.join(tmpdir(), 'lorra-cm-')));
    const existing = expectOk(
      store.propose(
        makePropose({
          kind: 'knowledge',
          title: 'FTS5 中文检索',
          content: 'trigram 分词器使中文子串 LIKE 检索可用。\n\n第二段无关。',
        }),
      ),
    );
    const hit = expectOk(
      store.compileMatch({
        title: '新标题',
        content: 'trigram 分词器使中文子串 LIKE 检索可用。\n\n补充内容。',
      }),
    );
    expect(hit?.entryId).toBe(existing.entryId);
  });

  it('无命中:标题与首段都不沾边 → null', () => {
    const store = openStore(mkdtempSync(path.join(tmpdir(), 'lorra-cm-')));
    expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: 'Rust', content: '借用检查器。' })),
    );
    const hit = expectOk(
      store.compileMatch({ title: '摄影构图', content: '三分法、引导线、留白。' }),
    );
    expect(hit).toBeNull();
  });

  it('只匹配 knowledge 类:同名非知识条目(如偏好)不算命中', () => {
    const store = openStore(mkdtempSync(path.join(tmpdir(), 'lorra-cm-')));
    expectOk(
      store.propose(makePropose({ kind: 'soft_preference', title: '咖啡', content: '美式' })),
    );
    const hit = expectOk(store.compileMatch({ title: '咖啡', content: '咖啡因代谢。' }));
    expect(hit).toBeNull();
  });

  it('标题命中优先于首段命中;同级取 updatedAt 最新', () => {
    const store = openStore(mkdtempSync(path.join(tmpdir(), 'lorra-cm-')));
    // 首段命中页(旧)
    const paraHit = expectOk(
      store.propose(
        makePropose({
          kind: 'knowledge',
          title: 'A 主题',
          content: '共享首段内容。',
        }),
      ),
    );
    // 标题命中页(新)
    const titleHit = expectOk(
      store.propose(
        makePropose({
          kind: 'knowledge',
          title: '编译原理',
          content: '无关内容',
        }),
      ),
    );
    const hit = expectOk(
      store.compileMatch({ title: '编译原理', content: '共享首段内容。补充。' }),
    );
    expect(hit?.entryId).toBe(titleHit.entryId);
    expect(hit?.entryId).not.toBe(paraHit.entryId);
  });
});

// ---------------------------------------------------------------------------
// 自动关联回链 + 一跳检索(+ 跨 kind):
// linkRelated 确定性标题匹配建链(全部生效条目跨 kind、排除自身、幂等、上限
// MEMORY_LINK_MAX);recall 在 top-k 命中后沿 entry_links 扩展一跳关联页
// (active + scope 过滤,上限 MEMORY_RECALL_HOP_MAX),返回形状仍为数组。
// ---------------------------------------------------------------------------

describe('自动关联 + 一跳检索', () => {
  let dir: string;
  let store: MemoryStore;
  const params = { scope: 'workspace' as const, workspace: 'C:\\work\\demo' };

  function linkCount(): number {
    const raw = new DatabaseSync(path.join(dir, 'memory.db'));
    try {
      const row = raw.prepare('SELECT COUNT(*) AS n FROM entry_links').get() as { n: number };
      return row.n;
    } finally {
      raw.close();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-links-'));
    store = openStore(dir);
  });
  afterEach(() => {
    for (const s of storeRegistry.splice(0)) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- linkRelated ----

  it('linkRelated: 短语命中标题 → 建链 from→to 并返回 to_id', () => {
    const src = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    const target = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: 'Rust 所有权模型', content: 'y' })),
    );
    const linked = expectOk(store.linkRelated(src.entryId, ['Rust 所有权']));
    expect(linked).toEqual([target.entryId]);
    expect(linkCount()).toBe(1);
  });

  it('linkRelated 幂等: 重复调用 → 空列表、行数不变', () => {
    const src = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    const target = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: 'Rust 所有权模型', content: 'y' })),
    );
    expect(expectOk(store.linkRelated(src.entryId, ['Rust 所有权']))).toEqual([target.entryId]);
    const again = expectOk(store.linkRelated(src.entryId, ['Rust 所有权']));
    expect(again).toEqual([]);
    expect(linkCount()).toBe(1);
  });

  it('linkRelated 排除自身: 短语命中自己标题 → 不建链', () => {
    const page = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: 'Rust 所有权', content: 'y' })),
    );
    const linked = expectOk(store.linkRelated(page.entryId, ['Rust 所有权']));
    expect(linked).toEqual([]);
    expect(linkCount()).toBe(0);
  });

  it('linkRelated 跨 kind(): 非 knowledge 条目标题重合 → 建链', () => {
    const src = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    expectOk(
      store.propose(makePropose({ kind: 'working_context', title: 'Rust 所有权', content: 'y' })),
    );
    const linked = expectOk(store.linkRelated(src.entryId, ['Rust 所有权']));
    expect(linked).toHaveLength(1);
    expect(linkCount()).toBe(1);
  });

  it('linkRelated 上限: 6 个命中短语只建 MEMORY_LINK_MAX 条', () => {
    const src = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    const titles = ['AA1', 'AA2', 'AA3', 'AA4', 'AA5', 'AA6'].map(
      (t) =>
        expectOk(store.propose(makePropose({ kind: 'knowledge', title: t, content: 'y' }))).entryId,
    );
    const linked = expectOk(
      store.linkRelated(src.entryId, ['AA1', 'AA2', 'AA3', 'AA4', 'AA5', 'AA6']),
    );
    expect(linked).toHaveLength(MEMORY_LINK_MAX);
    expect(linked.every((id) => titles.includes(id))).toBe(true);
    expect(linkCount()).toBe(MEMORY_LINK_MAX);
  });

  it('linkRelated 空短语 → ok([]) 且不建链', () => {
    const src = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    expect(expectOk(store.linkRelated(src.entryId, []))).toEqual([]);
    expect(expectOk(store.linkRelated(src.entryId, ['  ', 'a']))).toEqual([]); // 空白/单字符短语跳过
    expect(linkCount()).toBe(0);
  });

  it('linkRelated 无命中 → ok([])', () => {
    const src = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: 'Rust 所有权模型', content: 'y' })),
    );
    const linked = expectOk(store.linkRelated(src.entryId, ['摄影构图']));
    expect(linked).toEqual([]);
    expect(linkCount()).toBe(0);
  });

  // ---- recall 一跳扩展 ----

  it('recall 一跳: 命中页后追加关联页(hits 在前 k 位)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const b = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: 'Rust 所有权模型', content: 'y' })),
    );
    vi.setSystemTime(1_700_000_001_000);
    const a = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    expect(expectOk(store.linkRelated(a.entryId, ['Rust 所有权']))).toEqual([b.entryId]);

    const recalled = expectOk(store.recall({ ...params, k: 1 }));
    expect(recalled.map((e) => e.entryId)).toEqual([a.entryId, b.entryId]); // [...hits, ...hops]
    vi.useRealTimers();
  });

  it('recall 一跳: 关联页 retired → 不出现', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const a = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    vi.setSystemTime(1_700_000_001_000);
    const b = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: 'Rust 所有权模型', content: 'y' })),
    );
    expectOk(store.linkRelated(a.entryId, ['Rust 所有权']));
    expectOk(store.retire(b.entryId));

    const recalled = expectOk(store.recall({ ...params, k: 1 }));
    expect(recalled.map((e) => e.entryId)).toEqual([a.entryId]);
    vi.useRealTimers();
  });

  it('recall 一跳: 关联页属其他 workspace(scope 过滤) → 不出现', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const a = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    vi.setSystemTime(1_700_000_001_000);
    const b = expectOk(
      store.propose(
        makePropose({ kind: 'knowledge', title: 'Rust 所有权模型', content: 'y', workspace: 'W2' }),
      ),
    );
    expectOk(store.linkRelated(a.entryId, ['Rust 所有权']));

    const recalled = expectOk(store.recall({ ...params, k: 1 }));
    expect(recalled.map((e) => e.entryId)).toEqual([a.entryId]);
    vi.useRealTimers();
  });

  it('recall 一跳上限: 4 个邻居只取 MEMORY_RECALL_HOP_MAX 条', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const neighbors = ['AA1', 'AA2', 'AA3', 'AA4'].map(
      (t) =>
        expectOk(store.propose(makePropose({ kind: 'knowledge', title: t, content: 'y' }))).entryId,
    );
    vi.setSystemTime(1_700_000_001_000);
    const a = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    expectOk(store.linkRelated(a.entryId, ['AA1', 'AA2', 'AA3', 'AA4']));

    const recalled = expectOk(store.recall({ ...params, k: 1 }));
    expect(recalled).toHaveLength(1 + MEMORY_RECALL_HOP_MAX);
    expect(recalled[0].entryId).toBe(a.entryId);
    const hopIds = recalled.slice(1).map((e) => e.entryId);
    expect(hopIds.every((id) => neighbors.includes(id))).toBe(true);
    vi.useRealTimers();
  });

  it('recall 无链 → 行为与 完全一致(仅 hits,无关联追加)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const b = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: 'Rust 所有权模型', content: 'y' })),
    );
    vi.setSystemTime(1_700_000_001_000);
    const a = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    const recalled = expectOk(store.recall({ ...params, k: 1 }));
    expect(recalled.map((e) => e.entryId)).toEqual([a.entryId]);
    expect(recalled).toHaveLength(1);
    expect(expectOk(store.recall(params)).map((e) => e.entryId)).toEqual([a.entryId, b.entryId]);
    vi.useRealTimers();
  });

  it('recall 空命中 → 不扩展一跳,返回空数组', () => {
    const empty = expectOk(store.recall({ ...params, k: 1 }));
    expect(empty).toEqual([]);
  });

  // ---- : 八类扩展 + listLinks 数据出口 + 提取水位 ----

  it('八类 corpus: user_profile / event 合法 propose 且直落 active', () => {
    const profile = expectOk(
      store.propose(makePropose({ kind: 'user_profile', title: '用户从事量化开发', content: 'y' })),
    );
    const event = expectOk(
      store.propose(makePropose({ kind: 'event', title: '策略上线里程碑', content: 'z' })),
    );
    expect(profile.kind).toBe('user_profile');
    expect(event.kind).toBe('event');
    expect(profile.lifecycle).toBe('active');
    expect(event.lifecycle).toBe('active');
    // corpus 表播种自动获得新两行(由 MEMORY_KINDS 驱动)。
    const corpus = expectOk(store.listCorpus());
    expect(corpus.map((c) => c.kind)).toEqual([...MEMORY_KINDS]);
  });

  it('linkRelated 跨 kind: 经验页 → 偏好页/知识页均可建边(图谱)', () => {
    const experience = expectOk(
      store.propose(
        makePropose({ kind: 'procedural_experience', title: '回测必须含滑点', content: 'x' }),
      ),
    );
    const pref = expectOk(
      store.propose(
        makePropose({ kind: 'soft_preference', title: '技术文章先结论后细节', content: 'y' }),
      ),
    );
    const knowledge = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '双均线策略框架', content: 'z' })),
    );
    const linked = expectOk(store.linkRelated(experience.entryId, ['双均线', '技术文章']));
    expect(linked).toHaveLength(2);
    expect(linked).toContain(knowledge.entryId);
    expect(linked).toContain(pref.entryId);
  });

  it('listLinks: 全量边列表 { fromId, toId } 形状', () => {
    const a = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '来源页', content: 'x' })),
    );
    const b = expectOk(
      store.propose(makePropose({ kind: 'knowledge', title: '目标页', content: 'y' })),
    );
    expect(expectOk(store.listLinks())).toEqual([]);
    expectOk(store.linkRelated(a.entryId, ['目标页']));
    expect(expectOk(store.listLinks())).toEqual([{ fromId: a.entryId, toId: b.entryId }]);
  });

  it('提取水位: 默认 0 → MAX 语义(低水位不覆盖高水位), force 覆盖', () => {
    expect(expectOk(store.getExtractionWatermark('/sessions/sess-a.jsonl'))).toBe(0);
    expectOk(store.setExtractionWatermark('/sessions/sess-a.jsonl', 12));
    expect(expectOk(store.getExtractionWatermark('/sessions/sess-a.jsonl'))).toBe(12);
    // 更高水位正常推进。
    expectOk(store.setExtractionWatermark('/sessions/sess-a.jsonl', 20));
    expect(expectOk(store.getExtractionWatermark('/sessions/sess-a.jsonl'))).toBe(20);
    // MAX: 低水位不覆盖高水位(并发完成乱序不后退)。
    expectOk(store.setExtractionWatermark('/sessions/sess-a.jsonl', 5));
    expect(expectOk(store.getExtractionWatermark('/sessions/sess-a.jsonl'))).toBe(20);
    // force: 无条件覆盖(只给重置路径)。
    expectOk(store.setExtractionWatermark('/sessions/sess-a.jsonl', 3, { force: true }));
    expect(expectOk(store.getExtractionWatermark('/sessions/sess-a.jsonl'))).toBe(3);
    // 文件间隔离。
    expect(expectOk(store.getExtractionWatermark('/sessions/sess-b.jsonl'))).toBe(0);
  });
});

// =========================================================================
// — OFK 指针(ofkRef)与存量长内容迁移
// =========================================================================

describe('MemoryStore ofkRef（）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-memory-ofk-'));
    vi.stubEnv('LORRA_E2E_USERDATA', dir); // OFK bundle 根 = <dir>/.lorra/knowledge
  });
  afterEach(() => {
    for (const store of storeRegistry.splice(0)) store.close();
    resetSharedMemoryStoreForTest();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('propose 带 ofkRef 落库;改 ofkRef 不改变 entryId(不入内容哈希)', () => {
    const store = openStore(dir);
    const withRef = expectOk(store.propose(makePropose({ ofkRef: '/memory/abc.md' })));
    expect(withRef.ofkRef).toBe('/memory/abc.md');

    const noRef = expectOk(store.propose(makePropose({ ofkRef: undefined })));
    // 同内容不同 ofkRef → 同一 entry_id(白名单外字段);哈希幂等命中既有条目
    expect(noRef.entryId).toBe(withRef.entryId);
    expect(noRef.ofkRef).toBe('/memory/abc.md'); // 幂等返回既有条目(首次写入的指针)
  });

  it('update 仅改 ofkRef → 就地更新不产 supersedes,entryId 不变,event_log 记 ref→ref', () => {
    const store = openStore(dir);
    const entry = expectOk(store.propose(makePropose()));
    const updated = expectOk(store.update(entry.entryId, { ofkRef: '/memory/new.md' }));
    expect(updated.entryId).toBe(entry.entryId); // 不产新条目
    expect(updated.ofkRef).toBe('/memory/new.md');
    expect(updated.lifecycle).toBe('active');

    // 原条目未被 superseded
    const events = expectOk(store.listEvents(entry.entryId));
    expect(events.some((e) => e.event === 'edited' && e.detail === 'ref→ref')).toBe(true);
    // 同值重复更新 → no-change(与内容同值语义一致)
    const again = store.update(entry.entryId, { ofkRef: '/memory/new.md' });
    expect(again.isErr()).toBe(true);
    expect(again.match({ ok: () => '', err: (e) => e.code })).toBe('no-change');
  });

  it('update 同值 ofkRef → no-change(不误改)', () => {
    const store = openStore(dir);
    const entry = expectOk(store.propose(makePropose({ ofkRef: '/memory/x.md' })));
    const res = store.update(entry.entryId, { ofkRef: '/memory/x.md' });
    expect(res.isErr()).toBe(true);
    expect(res.match({ ok: () => '', err: (e) => e.code })).toBe('no-change');
  });

  it('update 改 content 带 ofkRef → supersedes 新条目继承指针', () => {
    const store = openStore(dir);
    const entry = expectOk(store.propose(makePropose({ ofkRef: '/memory/old.md' })));
    const updated = expectOk(
      store.update(entry.entryId, { content: 'new content', ofkRef: '/memory/new.md' }),
    );
    expect(updated.entryId).not.toBe(entry.entryId);
    expect(updated.supersedes).toBe(entry.entryId);
    expect(updated.ofkRef).toBe('/memory/new.md'); // 新条目继承 patch 指针
  });

  it('迁移: >1024 字节存量条目 → open 后 OFK 文档存在,条目变摘要+指针,再 open 幂等', () => {
    const dbPath = path.join(dir, 'memory.db');
    const longContent = '第一段。\n\n' + 'x'.repeat(1_200) + '\n\n结尾段。';
    const first = expectOk(MemoryStore.open(dbPath));
    const entry = expectOk(first.propose(makePropose({ content: longContent })));
    first.close();

    // 重新 open → 迁移执行
    const reopened = expectOk(MemoryStore.open(dbPath));
    storeRegistry.push(reopened);
    const migratedEntry = expectOk(reopened.listActive()).find((e) => e.entryId === entry.entryId);
    expect(migratedEntry).toBeDefined();
    if (!migratedEntry) throw new Error('migrated entry missing');
    expect(migratedEntry.ofkRef).toBe(`/memory/${entry.entryId}.md`);
    expect(migratedEntry.content).toContain('完整内容见');
    expect(migratedEntry.content).toContain(`/memory/${entry.entryId}.md`);
    // OFK 文档已写入 bundle
    const docPath = path.join(dir, '.lorra', 'knowledge', 'memory', `${entry.entryId}.md`);
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    expect(doc).toContain('type: Memory');
    expect(doc).toContain('process:lorra-migration/1');

    // 再 open 幂等:已迁移条目不再重复
    const third = expectOk(MemoryStore.open(dbPath));
    storeRegistry.push(third);
    const again = expectOk(third.listActive());
    const secondPass = again.find((e) => e.entryId === entry.entryId);
    expect(secondPass).toBeDefined();
    if (!secondPass) throw new Error('entry missing on reopen');
    expect(secondPass.ofkRef).toBe(`/memory/${entry.entryId}.md`);
  });

  it('迁移写入失败 → 该条目跳过留待重试,memory.db 原内容不动', () => {
    const dbPath = path.join(dir, 'memory.db');
    const longContent = '段一。\n\n' + 'y'.repeat(1200);
    const first = expectOk(MemoryStore.open(dbPath));
    const entry = expectOk(first.propose(makePropose({ content: longContent })));
    first.close();

    // 占位:目标路径是目录 → 写入失败(EISDIR)
    const docDir = path.join(dir, '.lorra', 'knowledge', 'memory', `${entry.entryId}.md`);
    mkdirSync(docDir, { recursive: true });

    const reopened = expectOk(MemoryStore.open(dbPath));
    storeRegistry.push(reopened);
    const after = expectOk(reopened.listActive());
    const survived = after.find((e) => e.entryId === entry.entryId)!;
    // 写入失败 → 原内容保持(未变摘要),ofk_ref 未置位
    expect(survived.ofkRef).toBeNull();
    expect(survived.content).toBe(longContent);
  });

  it('迁移边界: 恰好 1024 字节 → 不迁移(阈值语义 bytes > 1024 才迁移)', () => {
    const dbPath = path.join(dir, 'memory.db');
    const base = '段一。\n\n';
    const boundaryContent =
      base + 'z'.repeat(MEMORY_SPLIT_THRESHOLD_BYTES - Buffer.byteLength(base, 'utf8'));
    expect(Buffer.byteLength(boundaryContent, 'utf8')).toBe(MEMORY_SPLIT_THRESHOLD_BYTES);
    const first = expectOk(MemoryStore.open(dbPath));
    const entry = expectOk(first.propose(makePropose({ content: boundaryContent })));
    first.close();

    const reopened = expectOk(MemoryStore.open(dbPath));
    storeRegistry.push(reopened);
    const after = expectOk(reopened.listActive()).find((e) => e.entryId === entry.entryId)!;
    expect(after.ofkRef).toBeNull();
    expect(after.content).toBe(boundaryContent);
    // bundle 未生成任何 memory/ 文档
    expect(existsSync(path.join(dir, '.lorra', 'knowledge', 'memory'))).toBe(false);
  });

  it('迁移只处理 active: superseded 长条目原样保留(不迁移)', () => {
    const dbPath = path.join(dir, 'memory.db');
    const longContent = '原条目。\n\n' + 's'.repeat(1_200);
    const first = expectOk(MemoryStore.open(dbPath));
    const original = expectOk(first.propose(makePropose({ content: longContent })));
    // 改内容产生 supersedes 链,原条目 → superseded(长内容仍在)
    const replacement = expectOk(first.update(original.entryId, { content: '短内容替换' }));
    expect(replacement.supersedes).toBe(original.entryId);
    first.close();

    const reopened = expectOk(MemoryStore.open(dbPath));
    storeRegistry.push(reopened);
    const archived = expectOk(reopened.listArchived()).find((e) => e.entryId === original.entryId);
    expect(archived).toBeDefined();
    if (!archived) throw new Error('archived entry missing');
    expect(archived.ofkRef).toBeNull();
    expect(archived.content).toBe(longContent);
    // 只有 active 的新条目可被迁移;新条目内容短 → 不迁移
    const active = expectOk(reopened.listActive());
    expect(active).toHaveLength(1);
    expect(active[0].ofkRef).toBeNull();
  });

  it('update 改 content(patch 不带 ofkRef)→ supersedes 新条目继承原指针', () => {
    const store = openStore(dir);
    const entry = expectOk(store.propose(makePropose({ ofkRef: '/memory/old.md' })));
    const updated = expectOk(store.update(entry.entryId, { content: 'new content' }));
    expect(updated.entryId).not.toBe(entry.entryId);
    expect(updated.supersedes).toBe(entry.entryId);
    expect(updated.ofkRef).toBe('/memory/old.md'); // 继承,不丢指针
  });

  it('迁移摘要: 超长多字节首段硬截断 ≤512 字节且不劈开字符', () => {
    const dbPath = path.join(dir, 'memory.db');
    // 首段 400 个汉字 = 1200 字节(>1024 触发迁移,>512 触发硬截断)
    const longContent = '汉'.repeat(400) + '\n\n第二段。';
    const first = expectOk(MemoryStore.open(dbPath));
    const entry = expectOk(first.propose(makePropose({ content: longContent })));
    first.close();

    const reopened = expectOk(MemoryStore.open(dbPath));
    storeRegistry.push(reopened);
    const migrated = expectOk(reopened.listActive()).find((e) => e.entryId === entry.entryId)!;
    expect(migrated.ofkRef).toBe(`/memory/${entry.entryId}.md`);
    const pointerIdx = migrated.content.indexOf('（完整内容见');
    expect(pointerIdx).toBeGreaterThan(0);
    const summary = migrated.content.slice(0, pointerIdx).trimEnd();
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(MEMORY_SPLIT_SUMMARY_MAX_BYTES);
    // 不劈开多字节字符:硬截断落在整数个汉字上(510 字节 = 170 汉字)
    expect(summary.endsWith('汉')).toBe(true);
    expect(migrated.content).toContain('完整内容见');
  });

  it('升级兼容: schema v1 存量条目(旧哈希域)重提同内容 → 幂等命中,不产重复', () => {
    const dbPath = path.join(dir, 'legacy.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE entries (
      entry_id TEXT PRIMARY KEY,
      corpus_kind TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      producer TEXT NOT NULL,
      source TEXT NOT NULL,
      scope TEXT NOT NULL,
      workspace TEXT,
      evidence TEXT NOT NULL,
      basis TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      supersedes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      confirmed_at INTEGER
    );`);
    const content = '升级前记住的内容';
    // v1 哈希域:entryIdOf 全字段(无 ofkRef 键)+ schemaVersion 1
    const v1Input = {
      schemaVersion: 1,
      kind: 'working_context' as const,
      title: '升级前条目',
      content,
      tags: [],
      producer: 'agent-1',
      source: 'agent-proposal' as const,
      scope: 'workspace' as const,
      workspace: 'C:\\work\\demo',
      evidence: 'user-stated' as const,
      basis: 'b',
      lifecycle: 'active' as const,
      supersedes: null,
      createdAt: 0,
      updatedAt: 0,
      confirmedAt: 0,
    };
    const v1Id = entryIdOf(v1Input as unknown as Omit<MemoryEntry, 'entryId'>);
    raw
      .prepare(
        `INSERT INTO entries (entry_id, corpus_kind, schema_version, title, content, tags, producer, source, scope, workspace, evidence, basis, lifecycle, supersedes, created_at, updated_at, confirmed_at)
       VALUES (?, 'working_context', 1, '升级前条目', ?, '[]', 'agent-1', 'agent-proposal', 'workspace', 'C:\\\\work\\\\demo', 'user-stated', 'b', 'active', NULL, 1, 1, 1)`,
      )
      .run(v1Id, content);
    raw.close();

    const store = expectOk(MemoryStore.open(dbPath));
    storeRegistry.push(store);
    // 升级后同内容重提 → 幂等返回既有 v1 条目,不产重复
    const reproposed = expectOk(
      store.propose(makePropose({ title: '升级前条目', content, producer: 'agent-1', basis: 'b' })),
    );
    expect(reproposed.entryId).toBe(v1Id);
    expect(expectOk(store.listActive())).toHaveLength(1);
    // v2 域哈希不同(证明幂等是靠 v1 域回退,不是哈希碰巧相同)
    const v2Id = MemoryStore.contentIdForTest({
      kind: 'working_context',
      title: '升级前条目',
      content,
      producer: 'agent-1',
      source: 'agent-proposal',
      scope: 'workspace',
      workspace: 'C:\\work\\demo',
      evidence: 'user-stated',
      basis: 'b',
    });
    expect(v2Id).not.toBe(v1Id);
  });

  it('迁移: legacy 恶意 entry_id(.. 段/分隔符注入)全部约束在 bundle 内,不逃逸', async () => {
    const dbPath = path.join(dir, 'legacy.db');
    // v1 旧库(无 ofk_ref 列),手工 SQL 播种——legacy 数据不受信任(entry_id 可为任意串)
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE entries (
      entry_id TEXT PRIMARY KEY,
      corpus_kind TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      producer TEXT NOT NULL,
      source TEXT NOT NULL,
      scope TEXT NOT NULL,
      workspace TEXT,
      evidence TEXT NOT NULL,
      basis TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      supersedes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      confirmed_at INTEGER
    );`);
    const longContent = '长内容。\n\n' + 'e'.repeat(1_200);
    const insert = raw.prepare(
      `INSERT INTO entries (entry_id, corpus_kind, schema_version, title, content, tags, producer, source, scope, workspace, evidence, basis, lifecycle, supersedes, created_at, updated_at, confirmed_at)
       VALUES (?, 'working_context', 1, 'evil id', ?, '[]', 'legacy', 'agent-proposal', 'workspace', 'C:\\\\work\\\\demo', 'user-stated', 'b', 'active', NULL, 1, 1, 1)`,
    );
    // 三种恶意 id:纯 .. 段、反斜杠穿越、正斜杠穿越(safeFileName 清洗分隔符,
    // .md 后缀吸收 .. 段 → 文件名永远落在 memory/ 单段内)
    for (const evilId of ['..', '..\\..\\escape', 'a/../../escape']) {
      insert.run(evilId, longContent);
    }
    raw.close();

    const store = expectOk(MemoryStore.open(dbPath));
    storeRegistry.push(store);
    const entries = expectOk(store.listActive());
    expect(entries).toHaveLength(3);

    const knowledgeRoot = path.join(dir, '.lorra', 'knowledge');
    for (const entry of entries) {
      // 全部被迁移(memory/ 内合法文件名),指针可读且内容完整
      expect(entry.ofkRef).not.toBeNull();
      expect(entry.content).toContain('完整内容见');
      const docPath = path.join(knowledgeRoot, entry.ofkRef!.replace(/^\//, ''));
      expect(existsSync(docPath)).toBe(true);
      expect(readFileSync(docPath, 'utf8')).toContain('长内容');
      // 指针再经 readConcept 校验读回(在 bundle 内可读)
      const { readConcept } = await import('../../src/main/ofk/ofk-bundle');
      const read = await readConcept(entry.ofkRef!);
      expect(read.isOk()).toBe(true);
      expect(read.unwrapOr('') ?? '').toContain('长内容');
    }
    // bundle 外无任何逃逸文件:userdata 根目录无穿越名/escape 名文件
    const rootNames = readdirSync(dir);
    expect(rootNames.some((n) => n.includes('escape') || n === '..' || n.startsWith('..'))).toBe(
      false,
    );
    // bundle 根内无穿越残留(不出现裸 .. 名)
    expect(readdirSync(knowledgeRoot).filter((n) => n.includes('..'))).toEqual([]);
  });
});
