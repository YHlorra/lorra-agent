import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryStore, UpdatePatch } from '../../src/main/memory/memory-store';
import {
  createMemoryTool,
  type MemoryProposeInput,
  type MemorySearchInput,
  type MemoryTool,
  type MemoryToolStore,
} from '../../src/main/memory/propose-memory-tool';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_EVIDENCE_LABELS,
  MEMORY_KIND_LABELS,
  type MemoryEntry,
  type MemoryKind,
  type MemorySource,
} from '../../src/shared/memory-schema';
import type { Result } from '../../src/shared/result';
import { err, ok } from '../../src/shared/result';

// 类型级引用（esbuild 剔除 type import）:真实 MemoryStore 由共享单例动态装载。

// Requirement（/ design D3, 落地锚点 1.3）:
// 候选闸门拆除后, propose_memory 扩展为 memory 工具, op 四操作:
// propose —— 直落 active(confirmedAt=now), 返回「已记住：<title>（证据：<label>）」
// update —— {entryId, title?, content?, basis?} → 就地更新(supersedes 链), 返回新 entry_id
// retire —— {entryId} → 撤销, 返回确认
// search —— {query, scope?, k?} → 命中条目文本(含 evidence 标注, MEMORY_EVIDENCE_LABELS)
// 校验不变(2KB 拒原文/枚举/workspace 组合);「被拒不重复提议」语义随闸门删除。
// 成功写入(propose/update) emit MemoryRecordedPayload(形状 = RendererAutonomy 定稿)。
// 工具侧一律文本返回、不抛异常。

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    entryId: 'e'.repeat(64),
    schemaVersion: 1,
    tags: [],
    kind: 'procedural_experience',
    title: '登录测试偶尔闪断',
    content: '修复 flaky 登录测试: 先等元素可见再断言',
    producer: 'pi-sdk',
    source: 'agent-proposal',
    scope: 'workspace',
    workspace: 'C:\\work\\demo',
    evidence: 'extracted',
    basis: '本次调试中观察到的模式',
    lifecycle: 'active',
    supersedes: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    confirmedAt: 1_700_000_000_000,
    ofkRef: null,
    ...overrides,
  };
}

interface FakeStoreHandle {
  /** 按调用顺序记录 (method, args), 断言 store 契约面。 */
  calls: Array<{ method: string; args: unknown[] }>;
  store: MemoryToolStore;
}

/** 记录操作调用的假 store: 契约面 = { propose, update, retire, search, listActive }。 */
function makeFakeStore(
  overrides: {
    propose?: (input: MemoryProposeInput) => Result<MemoryEntry>;
    update?: (entryId: string, patch: UpdatePatch) => Result<MemoryEntry>;
    retire?: (entryId: string) => Result<MemoryEntry>;
    search?: (input: MemorySearchInput) => Result<MemoryEntry[]>;
    listActive?: (kind?: MemoryKind) => Result<MemoryEntry[]>;
  } = {},
): FakeStoreHandle {
  const calls: FakeStoreHandle['calls'] = [];
  const store: MemoryToolStore = {
    propose(input) {
      calls.push({ method: 'propose', args: [input] });
      return (overrides.propose ?? (() => ok(makeEntry())))(input);
    },
    update(entryId, patch) {
      calls.push({ method: 'update', args: [entryId, patch] });
      return (overrides.update ?? (() => ok(makeEntry({ entryId: 'u'.repeat(64) }))))(
        entryId,
        patch,
      );
    },
    retire(entryId) {
      calls.push({ method: 'retire', args: [entryId] });
      return (overrides.retire ?? (() => ok(makeEntry({ lifecycle: 'retired' }))))(entryId);
    },
    search(input) {
      calls.push({ method: 'search', args: [input] });
      return (overrides.search ?? (() => ok([])))(input);
    },
    listActive(kind) {
      calls.push({ method: 'listActive', args: [kind] });
      return (overrides.listActive ?? (() => ok([])))(kind);
    },
  };
  return { calls, store };
}

function callOf(handle: FakeStoreHandle, method: string) {
  const call = handle.calls.find((c) => c.method === method);
  expect(call, `expected store.${method} call`).toBeDefined();
  return call!;
}

const VALID_PARAMS = {
  op: 'propose',
  kind: 'procedural_experience',
  title: '登录测试偶尔闪断',
  content: '修复 flaky 登录测试: 先等元素可见再断言',
  scope: 'workspace',
  workspace: 'C:\\work\\demo',
  evidence: 'extracted',
  basis: '本次调试中观察到的模式',
};

async function runTool(tool: MemoryTool, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute(
    'call-1',
    params as never,
    undefined,
    undefined,
    undefined as never,
  );
  const first = (result.content as unknown as Array<{ text?: string }>)[0];
  if (!first || typeof first.text !== 'string') {
    throw new Error('tool result has no text');
  }
  return first.text;
}

function toolWith(deps: Partial<Parameters<typeof createMemoryTool>[0]> = {}): MemoryTool {
  return createMemoryTool({
    getStore: () => makeFakeStore().store,
    ...deps,
  } as never);
}

describe('memory 工具 propose（校验与文本返回, 假 store）', () => {
  it('正常 propose: store.propose 收到完整入参（source=agent-proposal / producer 取当前 agent）, 返回「已记住：<title>（证据：<label>）」', async () => {
    const fake = makeFakeStore({
      propose: () => ok(makeEntry({ entryId: 'a'.repeat(64) })),
    });
    const tool = createMemoryTool({
      getStore: () => fake.store,
      getProducer: () => 'agent-42',
    });

    const text = await runTool(tool, VALID_PARAMS);

    const call = callOf(fake, 'propose');
    const input = call.args[0] as Record<string, unknown>;
    expect(input.source).toBe('agent-proposal');
    expect(input.producer).toBe('agent-42');
    expect(input.kind).toBe('procedural_experience');
    expect(input.title).toBe(VALID_PARAMS.title);
    expect(input.content).toBe(VALID_PARAMS.content);
    expect(input.scope).toBe('workspace');
    expect(input.workspace).toBe('C:\\work\\demo');
    expect(input.evidence).toBe('extracted');
    expect(input.basis).toBe(VALID_PARAMS.basis);
    expect(text).toBe(`已记住：登录测试偶尔闪断（证据：${MEMORY_EVIDENCE_LABELS.extracted}）`);
  });

  it('成功 propose 时 emitRecorded 被调用: payload 含 entryId/title/kind/evidence, sessionId 由注册处闭包注入', async () => {
    const fake = makeFakeStore({
      propose: () => ok(makeEntry({ entryId: 'b'.repeat(64) })),
    });
    const emitRecorded = vi.fn();
    const tool = createMemoryTool({
      getStore: () => fake.store,
      emitRecorded,
      sessionId: () => 'sess-9',
    });

    await runTool(tool, VALID_PARAMS);

    expect(emitRecorded).toHaveBeenCalledTimes(1);
    expect(emitRecorded.mock.calls[0][0]).toEqual({
      entryId: 'b'.repeat(64),
      title: '登录测试偶尔闪断',
      kind: 'procedural_experience',
      evidence: 'extracted',
      sessionId: 'sess-9',
    });
  });

  it('emitRecorded 未提供时成功 propose 不报错', async () => {
    const text = await runTool(toolWith(), VALID_PARAMS);
    expect(text).toContain('已记住：');
  });

  it('超长 content（>2048 utf8 字节）→ 结构化拒绝 content-too-long, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, {
      ...VALID_PARAMS,
      content: 'a'.repeat(MEMORY_CONTENT_MAX_BYTES + 1),
    });

    expect(text).toContain('content-too-long');
    expect(text).toContain('拒绝');
    expect(fake.calls).toHaveLength(0);
  });

  it('超长 content 精确边界: 恰 2048 字节放行, 2049 拒绝', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const okText = await runTool(tool, {
      ...VALID_PARAMS,
      content: 'a'.repeat(MEMORY_CONTENT_MAX_BYTES),
    });
    expect(okText).toContain('已记住：');
    expect(callOf(fake, 'propose')).toBeDefined();

    const rejectText = await runTool(tool, {
      ...VALID_PARAMS,
      content: 'a'.repeat(MEMORY_CONTENT_MAX_BYTES + 1),
    });
    expect(rejectText).toContain('content-too-long');
    expect(fake.calls).toHaveLength(1); // 第二次被拒, 不再触达 store
  });

  it('非法 kind → 结构化拒绝 invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { ...VALID_PARAMS, kind: 'bogus_kind' });

    expect(text).toContain('invalid-args');
    expect(text).toContain('kind');
    expect(fake.calls).toHaveLength(0);
  });

  it('非法 evidence → 结构化拒绝 invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { ...VALID_PARAMS, evidence: 'certain' });

    expect(text).toContain('invalid-args');
    expect(text).toContain('evidence');
    expect(fake.calls).toHaveLength(0);
  });

  it('非法 scope → 结构化拒绝 invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { ...VALID_PARAMS, scope: 'global' });

    expect(text).toContain('invalid-args');
    expect(text).toContain('scope');
    expect(fake.calls).toHaveLength(0);
  });

  it('propose 必填字段缺失（title/content/basis 空）→ invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    for (const missing of ['title', 'content', 'basis']) {
      const text = await runTool(tool, { ...VALID_PARAMS, [missing]: '' });
      expect(text).toContain('invalid-args');
      expect(fake.calls).toHaveLength(0);
    }
  });

  it('propose scope=workspace/project 缺 workspace → 结构化拒绝', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    for (const scope of ['workspace', 'project']) {
      const { workspace: _drop, ...rest } = VALID_PARAMS;
      const text = await runTool(tool, { ...rest, scope });
      expect(text).toContain('invalid-args');
      expect(text).toContain('workspace');
      expect(fake.calls).toHaveLength(0);
    }
  });

  it('propose scope=user 时携带 workspace → 归一为 null 照常提议（user 级不绑定工作区）', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    await runTool(tool, { ...VALID_PARAMS, scope: 'user', workspace: 'C:\\work\\demo' });

    const input = callOf(fake, 'propose').args[0] as Record<string, unknown>;
    expect(input.scope).toBe('user');
    expect(input.workspace).toBeNull();
  });

  it('重复 propose → 幂等: 两次调用同一规范化入参（同 entry_id 依据）', async () => {
    const fake = makeFakeStore({
      propose: () => ok(makeEntry({ entryId: 'c'.repeat(64) })),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });

    const first = await runTool(tool, VALID_PARAMS);
    const second = await runTool(tool, VALID_PARAMS);

    expect(first).toContain('已记住：');
    expect(second).toContain('已记住：');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].args[0]).toEqual(fake.calls[1].args[0]);
  });

  it('store 返回 Err → 错误文本含 code, 不抛异常', async () => {
    const fake = makeFakeStore({
      propose: () => err({ code: 'store-broken', message: '磁盘错误' }),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, VALID_PARAMS);

    expect(text).toContain('store-broken');
    expect(text).toContain('磁盘错误');
  });

  it('store 抛异常 → 返回错误文本, 不抛异常', async () => {
    const tool = createMemoryTool({
      getStore: () => {
        throw new Error('store exploded');
      },
    });

    const text = await runTool(tool, VALID_PARAMS);

    expect(text).toContain('记忆操作失败');
    expect(text).toContain('store exploded');
  });
});

describe('memory 工具 update / retire（假 store）', () => {
  it('正常 update: store.update 收到 {entryId, patch}, 返回新 entry_id 文本', async () => {
    const fake = makeFakeStore({
      update: () => ok(makeEntry({ entryId: 'u'.repeat(64), title: '登录测试偶发闪断（已修复）' })),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, {
      op: 'update',
      entryId: 'e'.repeat(64),
      title: '登录测试偶发闪断（已修复）',
      basis: '用户确认: 超时阈值已调大',
    });

    const call = callOf(fake, 'update');
    expect(call.args[0]).toBe('e'.repeat(64));
    expect(call.args[1]).toEqual({
      title: '登录测试偶发闪断（已修复）',
      basis: '用户确认: 超时阈值已调大',
    });
    expect(text).toContain('已更新记忆');
    expect(text).toContain('u'.repeat(64));
    expect(text).toContain(`证据：${MEMORY_EVIDENCE_LABELS.extracted}`);
  });

  it('成功 update 时 emitRecorded 被调用: payload 为新条目信息', async () => {
    const fake = makeFakeStore({
      update: () => ok(makeEntry({ entryId: 'u'.repeat(64), title: '新标题' })),
    });
    const emitRecorded = vi.fn();
    const tool = createMemoryTool({
      getStore: () => fake.store,
      emitRecorded,
      sessionId: () => 'sess-9',
    });

    await runTool(tool, { op: 'update', entryId: 'e'.repeat(64), title: '新标题' });

    expect(emitRecorded).toHaveBeenCalledTimes(1);
    expect(emitRecorded.mock.calls[0][0]).toEqual({
      entryId: 'u'.repeat(64),
      title: '新标题',
      kind: 'procedural_experience',
      evidence: 'extracted',
      sessionId: 'sess-9',
    });
  });

  it('update 缺 entryId → invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { op: 'update', title: '新标题' });

    expect(text).toContain('invalid-args');
    expect(text).toContain('entryId');
    expect(fake.calls).toHaveLength(0);
  });

  it('update 空 patch（无 title/content/basis）→ invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { op: 'update', entryId: 'e'.repeat(64) });

    expect(text).toContain('invalid-args');
    expect(text).toContain('title/content/basis');
    expect(fake.calls).toHaveLength(0);
  });

  it('update content 超长 → content-too-long, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, {
      op: 'update',
      entryId: 'e'.repeat(64),
      content: 'a'.repeat(MEMORY_CONTENT_MAX_BYTES + 1),
    });

    expect(text).toContain('content-too-long');
    expect(fake.calls).toHaveLength(0);
  });

  it('update 提供的 title/content/basis 为空 → invalid-args', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    for (const [field, value] of [
      ['title', ''],
      ['content', ''],
      ['basis', '   '],
    ] as const) {
      const text = await runTool(tool, { op: 'update', entryId: 'e'.repeat(64), [field]: value });
      expect(text).toContain('invalid-args');
      expect(fake.calls).toHaveLength(0);
    }
  });

  it('正常 retire: store.retire 收到 entryId, 返回确认文本', async () => {
    const fake = makeFakeStore({
      retire: () => ok(makeEntry({ lifecycle: 'retired', title: '过时的登录经验' })),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { op: 'retire', entryId: 'e'.repeat(64) });

    expect(callOf(fake, 'retire').args[0]).toBe('e'.repeat(64));
    expect(text).toBe('已撤销记忆：过时的登录经验');
  });

  it('retire 缺 entryId → invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { op: 'retire' });

    expect(text).toContain('invalid-args');
    expect(fake.calls).toHaveLength(0);
  });

  it('store update/retire 返回 Err → 错误文本含 code, 不抛异常', async () => {
    const fake = makeFakeStore({
      update: () => err({ code: 'not-found', message: 'entry not found' }),
      retire: () => err({ code: 'invalid-state', message: 'cannot retire' }),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });

    const updateText = await runTool(tool, { op: 'update', entryId: 'missing', title: 'x' });
    expect(updateText).toContain('not-found');

    const retireText = await runTool(tool, { op: 'retire', entryId: 'candidate-e' });
    expect(retireText).toContain('invalid-state');
  });
});

describe('memory 工具 search（假 store）', () => {
  const HITS = [
    makeEntry({
      entryId: 's1'.padEnd(64, '1'),
      title: '部署流程',
      kind: 'knowledge',
      evidence: 'user-stated',
      content: '生产部署先跑冒烟测试',
    }),
    makeEntry({
      entryId: 's2'.padEnd(64, '2'),
      title: '登录测试闪断',
      evidence: 'inferred',
      content: '与 CI 并发有关',
    }),
    makeEntry({
      entryId: 's3'.padEnd(64, '3'),
      title: '命名规范',
      evidence: 'unverified',
      content: '组件用 PascalCase',
    }),
  ];

  it('search 命中: 文本含标题/kind 标签/evidence 标注（MEMORY_EVIDENCE_LABELS）/entry_id/正文', async () => {
    const fake = makeFakeStore({ search: () => ok(HITS) });
    const tool = createMemoryTool({
      getStore: () => fake.store,
      getWorkspace: () => 'C:\\work\\demo',
    });

    const text = await runTool(tool, { op: 'search', query: '部署' });

    expect(text).toContain('命中 3 条');
    expect(text).toContain('[1] 部署流程');
    expect(text).toContain(MEMORY_KIND_LABELS.knowledge);
    expect(text).toContain(`证据：${MEMORY_EVIDENCE_LABELS['user-stated']}`);
    expect(text).toContain(`证据：${MEMORY_EVIDENCE_LABELS.inferred}`);
    expect(text).toContain(`证据：${MEMORY_EVIDENCE_LABELS.unverified}`);
    expect(text).toContain('生产部署先跑冒烟测试');
    expect(text).toContain('entry_id=');
    // scope 过滤把工作区传给 store（getWorkspace 解析）
    const searchInput = callOf(fake, 'search').args[0] as Record<string, unknown>;
    expect(searchInput.query).toBe('部署');
    expect(searchInput.scope).toBeUndefined();
    expect(searchInput.workspace).toBe('C:\\work\\demo');
  });

  it('search 带 scope: scope 原样传 store', async () => {
    const fake = makeFakeStore({ search: () => ok(HITS) });
    const tool = createMemoryTool({ getStore: () => fake.store });

    await runTool(tool, { op: 'search', query: '部署', scope: 'workspace' });

    const searchInput = callOf(fake, 'search').args[0] as Record<string, unknown>;
    expect(searchInput.scope).toBe('workspace');
  });

  it('search 无命中 → 「未找到匹配的记忆条目」', async () => {
    const fake = makeFakeStore({ search: () => ok([]) });
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { op: 'search', query: '不存在的东西' });

    expect(text).toBe('未找到匹配的记忆条目');
  });

  it('search k 截断: store 返回 3 条, k=2 → 只返回前 2 条', async () => {
    const fake = makeFakeStore({ search: () => ok(HITS) });
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { op: 'search', query: '部署', k: 2 });

    expect(text).toContain('命中 2 条');
    expect(text).toContain('[1] 部署流程');
    expect(text).toContain('[2] 登录测试闪断');
    expect(text).not.toContain('[3] 命名规范');
  });

  it('search 缺 query → invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    for (const params of [{ op: 'search' }, { op: 'search', query: '   ' }]) {
      const text = await runTool(tool, params);
      expect(text).toContain('invalid-args');
      expect(text).toContain('query');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('search 非法 scope / 非法 k → invalid-args, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const scopeText = await runTool(tool, { op: 'search', query: 'x', scope: 'global' });
    expect(scopeText).toContain('invalid-args');
    expect(scopeText).toContain('scope');

    for (const k of [0, 51, 2.5, '3']) {
      const text = await runTool(tool, { op: 'search', query: 'x', k });
      expect(text).toContain('invalid-args');
      expect(text).toContain('k');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('search store 返回 Err → 错误文本含 code, 不抛异常', async () => {
    const fake = makeFakeStore({
      search: () => err({ code: 'memory-store-search-failed', message: 'fts error' }),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { op: 'search', query: 'x' });

    expect(text).toContain('memory-store-search-failed');
  });

  it('非法 op → invalid-args 文本, 不触达 store', async () => {
    const fake = makeFakeStore();
    const tool = createMemoryTool({ getStore: () => fake.store });

    const text = await runTool(tool, { op: 'bogus' });

    expect(text).toContain('invalid-args');
    expect(text).toContain('propose/update/retire/search');
    expect(fake.calls).toHaveLength(0);
  });
});

// 真实 MemoryStore 落库断言（依赖 StoreContract 的 D1 直落 active 语义,
// 已落地: propose → active + confirmedAt / update supersedes 链 / retire / search）。
describe('memory 工具（真实 MemoryStore 落库, 临时目录）', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-memory-tool-'));
    dbPath = path.join(dir, 'memory.db');
  });

  afterEach(async () => {
    const shared = await import('../../src/main/memory/shared-memory-store').catch(() => null);
    shared?.resetSharedMemoryStoreForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  async function openStore() {
    const shared = await import('../../src/main/memory/shared-memory-store');
    return expectOk<MemoryStore>(shared.getSharedMemoryStore(dbPath));
  }

  it('propose 直落 active: lifecycle=active, confirmedAt 非空, 返回「已记住」并 emit', async () => {
    const store = await openStore();
    const emitRecorded = vi.fn();
    const tool = createMemoryTool({
      getStore: () => store,
      emitRecorded,
      getProducer: () => 'agent-7',
      sessionId: () => 'sess-1',
    });

    const text = await runTool(tool, VALID_PARAMS);

    expect(text).toBe(`已记住：登录测试偶尔闪断（证据：${MEMORY_EVIDENCE_LABELS.extracted}）`);
    const actives = expectOk(store.listActive());
    expect(actives).toHaveLength(1);
    const [entry] = actives;
    expect(entry.lifecycle).toBe('active');
    expect(entry.confirmedAt).not.toBeNull();
    expect(entry.source).toBe('agent-proposal');
    expect(entry.producer).toBe('agent-7');
    expect(entry.supersedes).toBeNull();
    expect(emitRecorded).toHaveBeenCalledTimes(1);
    expect(emitRecorded.mock.calls[0][0]).toEqual({
      entryId: entry.entryId,
      title: entry.title,
      kind: 'procedural_experience',
      evidence: 'extracted',
      sessionId: 'sess-1',
    });
  });

  it('重复 propose → 幂等: 仅落一条 active, 两次返回同一 entry_id', async () => {
    const store = await openStore();
    const tool = createMemoryTool({ getStore: () => store });

    const first = await runTool(tool, VALID_PARAMS);
    const second = await runTool(tool, VALID_PARAMS);

    expect(first).toContain('已记住：');
    expect(second).toContain('已记住：');
    const actives = expectOk(store.listActive());
    expect(actives).toHaveLength(1);
    expect(first).toContain(actives[0].title);
  });

  it('update 建立 supersedes 链: 原条目 → superseded, 新条目 active + supersedes=原 id', async () => {
    const store = await openStore();
    const tool = createMemoryTool({ getStore: () => store });

    const proposeText = await runTool(tool, VALID_PARAMS);
    const original = expectOk(store.listActive())[0];

    const updateText = await runTool(tool, {
      op: 'update',
      entryId: original.entryId,
      title: '登录测试偶发闪断（已修复）',
      basis: '用户确认: 超时阈值已调大',
    });

    expect(updateText).toContain('已更新记忆');
    const archived = expectOk(store.listArchived());
    expect(
      archived.some((e) => e.entryId === original.entryId && e.lifecycle === 'superseded'),
    ).toBe(true);
    const actives = expectOk(store.listActive());
    expect(actives).toHaveLength(1);
    const [updated] = actives;
    expect(updated.supersedes).toBe(original.entryId);
    expect(updated.title).toBe('登录测试偶发闪断（已修复）');
    expect(updated.kind).toBe('procedural_experience'); // kind 继承
    expect(updated.evidence).toBe('extracted'); // evidence 继承
    expect(updated.workspace).toBe('C:\\work\\demo'); // workspace 继承
    expect(proposeText).toContain('已记住：');
  });

  it('retire: active → retired, 退出召回池', async () => {
    const store = await openStore();
    const tool = createMemoryTool({ getStore: () => store });

    await runTool(tool, VALID_PARAMS);
    const original = expectOk(store.listActive())[0];

    const text = await runTool(tool, { op: 'retire', entryId: original.entryId });

    expect(text).toBe(`已撤销记忆：${original.title}`);
    expect(expectOk(store.listActive())).toHaveLength(0);
    const archived = expectOk(store.listArchived());
    expect(archived.some((e) => e.entryId === original.entryId && e.lifecycle === 'retired')).toBe(
      true,
    );
  });

  it('search 真实落库命中: 返回文本含 evidence 标注', async () => {
    const store = await openStore();
    const tool = createMemoryTool({ getStore: () => store, getWorkspace: () => 'C:\\work\\demo' });

    await runTool(tool, VALID_PARAMS);

    // 注: store FTS5 unicode61 把连续汉字当整词 token, 查询词需为完整 token
    // （子串 '登录' 不命中 '登录测试偶尔闪断'——StoreContract 存储层已知行为）。
    const text = await runTool(tool, { op: 'search', query: '登录测试' });
    expect(text).toContain('命中 1 条');
    expect(text).toContain('登录测试偶尔闪断');
    expect(text).toContain(`证据：${MEMORY_EVIDENCE_LABELS.extracted}`);
  });

  it('search scope 过滤: workspace 匹配才命中', async () => {
    const store = await openStore();
    const tool = createMemoryTool({ getStore: () => store, getWorkspace: () => 'C:\\work\\demo' });

    await runTool(tool, VALID_PARAMS);

    const hitText = await runTool(tool, { op: 'search', query: '登录测试', scope: 'workspace' });
    expect(hitText).toContain('命中 1 条');

    // 其他工作区 → 不命中（workspace/project 级条目被 scope 过滤）
    const otherWsTool = createMemoryTool({
      getStore: () => store,
      getWorkspace: () => 'D:\\elsewhere',
    });
    const missText = await runTool(otherWsTool, {
      op: 'search',
      query: '登录测试',
      scope: 'workspace',
    });
    expect(missText).toBe('未找到匹配的记忆条目');
  });
});

// 类型面断言: MemorySource 枚举不被移除（propose input source 通道）。
void (null as unknown as MemorySource);

// ---------------------------------------------------------------------------
// lint:audit op —— 确定性自查(重复主题/陈旧/孤儿页),agent 依结果维护。
// ---------------------------------------------------------------------------

describe('memory 工具 audit（lint,假 store）', () => {
  const now = Date.now();
  const day = 86_400_000;
  const entry = (overrides: Partial<MemoryEntry>): MemoryEntry =>
    makeEntry({ updatedAt: now, ...overrides });

  it('健康库 → 无发现文案', async () => {
    const fake = makeFakeStore({
      listActive: () =>
        ok([
          entry({ title: 'A', kind: 'knowledge', content: '内容引用 [[B]]' }),
          entry({ title: 'B', kind: 'knowledge', content: 'B 的内容,见 [[A]]' }),
        ]),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });
    const text = await runTool(tool, { op: 'audit' });
    expect(text).toContain('记忆健康');
    expect(text).not.toContain('[重复主题]');
  });

  it('重复主题:同规范化标题多条生效条目 → [重复主题] 收敛建议', async () => {
    const fake = makeFakeStore({
      listActive: () =>
        ok([
          entry({ title: '部署流程', content: 'v1' }),
          entry({ title: ' 部署 流程 ', content: 'v2', kind: 'knowledge' }),
        ]),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });
    const text = await runTool(tool, { op: 'audit' });
    expect(text).toContain('[重复主题]');
    expect(text).toContain('收敛');
  });

  it('陈旧:updatedAt 早于 90 天 → [陈旧]', async () => {
    const fake = makeFakeStore({
      listActive: () =>
        ok([
          entry({ title: '老知识', kind: 'knowledge', content: 'c', updatedAt: now - 100 * day }),
        ]),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });
    const text = await runTool(tool, { op: 'audit' });
    expect(text).toContain('[陈旧]');
    expect(text).toContain('老知识');
  });

  it('孤儿页:knowledge 无任何 [[链接]] 引用 → [孤儿页];被引用者不报', async () => {
    const fake = makeFakeStore({
      listActive: () =>
        ok([
          entry({ title: '引用方', kind: 'knowledge', content: '详见 [[被引用页]]' }),
          entry({ title: '被引用页', kind: 'knowledge', content: '内容' }),
          entry({ title: '孤儿页', kind: 'knowledge', content: '没人链我' }),
        ]),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });
    const text = await runTool(tool, { op: 'audit' });
    expect(text).toContain('[孤儿页]');
    expect(text).toContain('孤儿页');
    expect(text).not.toContain('被引用页');
  });

  it('非 knowledge 条目(偏好/规则)不算孤儿', async () => {
    const fake = makeFakeStore({
      listActive: () =>
        ok([entry({ title: '咖啡偏好', kind: 'soft_preference', content: '美式' })]),
    });
    const tool = createMemoryTool({ getStore: () => fake.store });
    const text = await runTool(tool, { op: 'audit' });
    expect(text).not.toContain('[孤儿页]');
  });

  it('store 不可用 → 结构化失败文本', async () => {
    const tool = createMemoryTool({
      getStore: () => {
        throw new Error('store exploded');
      },
    });
    const text = await runTool(tool, { op: 'audit' });
    expect(text).toContain('store exploded');
  });
});

describe('memory 工具 ofkRef（）', () => {
  it('propose 带 ofkRef → store.propose 收到 ofkRef 透传', async () => {
    const fake = makeFakeStore({
      propose: () => ok(makeEntry({ entryId: 'a'.repeat(64) })),
    });
    const tool = createMemoryTool({
      getStore: () => fake.store,
      getProducer: () => 'agent-42',
    });
    const text = await runTool(tool, { ...VALID_PARAMS, ofkRef: '/memory/long.md' });
    expect(text).toContain('已记住');
    const input = callOf(fake, 'propose').args[0] as Record<string, unknown>;
    expect(input.ofkRef).toBe('/memory/long.md');
  });

  it('propose 非法 ofkRef（不在白名单路径形态）→ invalid-args,不触达 store', async () => {
    const fake = makeFakeStore({
      propose: () => ok(makeEntry({ entryId: 'a'.repeat(64) })),
    });
    const tool = createMemoryTool({
      getStore: () => fake.store,
      getProducer: () => 'agent-42',
    });
    for (const bad of [
      '../x.md',
      'memory/x.md',
      '',
      'a b.md',
      'x'.repeat(300),
      // 穿越 token 藏在合法路径形态内:含 .. / . 段或双斜杠的「合法」字符集路径
      '/memory/a/../b.md',
      '/memory/./b.md',
      '/memory//b.md',
      '/memory/..',
      '/..',
    ]) {
      const text = await runTool(tool, { ...VALID_PARAMS, ofkRef: bad });
      expect(text).toContain('invalid-args');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('update 带 ofkRef → store.update 收到 patch.ofkRef', async () => {
    const fake = makeFakeStore({
      update: () => ok(makeEntry({ entryId: 'b'.repeat(64) })),
    });
    const tool = createMemoryTool({
      getStore: () => fake.store,
      getProducer: () => 'agent-42',
    });
    const text = await runTool(tool, { op: 'update', entryId: 'e1', ofkRef: '/memory/new.md' });
    expect(text).toContain('已更新');
    const patch = callOf(fake, 'update').args[1] as UpdatePatch;
    expect(patch.ofkRef).toBe('/memory/new.md');
  });

  it('update 非法 ofkRef → invalid-args', async () => {
    const fake = makeFakeStore({
      update: () => ok(makeEntry({ entryId: 'b'.repeat(64) })),
    });
    const tool = createMemoryTool({
      getStore: () => fake.store,
      getProducer: () => 'agent-42',
    });
    for (const bad of ['../escape.md', '/memory/a/../b.md', '/memory/./x.md']) {
      const text = await runTool(tool, { op: 'update', entryId: 'e1', ofkRef: bad });
      expect(text).toContain('invalid-args');
    }
  });
});
