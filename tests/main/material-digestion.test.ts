import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  crystallize,
  DIGEST_INPUT_MAX_BYTES,
  digestFile,
  digestMaterial,
} from '../../src/main/memory/material-digestion';
import type { MemoryStore, UpdatePatch } from '../../src/main/memory/memory-store';
import type { ModelInvoke } from '../../src/main/memory/review-generator';
import {
  MEMORY_CONTENT_MAX_BYTES,
  type MemoryEntry,
  type MemorySource,
} from '../../src/shared/memory-schema';
import { err, ok, type Result } from '../../src/shared/result';

// pi-coding-agent 纯 ESM 依赖重;消化测试全部注入假 invoke,不触达真实会话运行时。
// 同 review-model.test.ts 纪律:mock 掉保持导入图轻量。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: { inMemory: vi.fn() },
  createAgentSessionFromServices: vi.fn(),
  createAgentSessionServices: vi.fn(),
}));

// 默认 propose 经 getSharedMemoryStore 持有写句柄,测试后不会自行关闭 →
// Windows 无法 unlink 打开的 db。包一层真实 MemoryStore 登记实例,afterEach 统一 close。
const openStores = vi.hoisted(() => [] as Array<{ close(): void }>);

vi.mock('../../src/main/memory/memory-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/memory/memory-store')>();
  return {
    ...actual,
    MemoryStore: {
      open: (dbPath: string) => {
        const result = actual.MemoryStore.open(dbPath);
        if (result.isOk()) openStores.push(result.value);
        return result;
      },
    },
  };
});

import {
  getSharedMemoryStore,
  resetSharedMemoryStoreForTest,
} from '../../src/main/memory/shared-memory-store';

function store(): MemoryStore {
  const r = getSharedMemoryStore();
  if (r.isErr()) throw new Error(`getSharedMemoryStore 失败: ${JSON.stringify(r.error)}`);
  return r.value;
}

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function expectErrCode(result: Result<unknown>): string {
  expect(result.isErr()).toBe(true);
  return result.match({
    ok: () => {
      throw new Error('expected Ok, got Err');
    },
    err: (e) => e.code,
  });
}

/** : 无候选列表——生效区按写入通道(source)过滤读回。 */
function activeBySource(source: MemorySource): MemoryEntry[] {
  return expectOk<MemoryEntry[]>(store().listActive()).filter((e) => e.source === source);
}

describe('material-digestion(素材消化 + 用户结晶,真 store + 临时库)', () => {
  let userdata: string;
  const workspace = 'C:\\ws\\demo';

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-digestion-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const s of openStores.splice(0)) s.close();
    resetSharedMemoryStoreForTest();
    rmSync(userdata, { recursive: true, force: true });
  });

  // ---- digestMaterial ----

  it('消化成功 → 落 knowledge 生效条目(kind/source/evidence/scope/workspace/producer/lifecycle=active)', async () => {
    const invoke = vi.fn<ModelInvoke>(async () => ok('# 知识要点\n\n- 要点一\n- 要点二'));
    const res = await digestMaterial(
      { text: '这是一段素材原文', title: '素材标题', workspace },
      { invoke },
    );
    expect(res.isOk()).toBe(true);

    const entries = activeBySource('material-digestion');
    const entry = entries.find((e) => e.entryId === expectOk(res).entryId);
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('knowledge');
    expect(entry!.source).toBe('material-digestion');
    expect(entry!.evidence).toBe('extracted');
    expect(entry!.scope).toBe('workspace');
    expect(entry!.workspace).toBe(workspace);
    expect(entry!.producer).toBe('material-digestion');
    expect(entry!.basis).toBe('素材消化提取');
    expect(entry!.lifecycle).toBe('active');
    expect(entry!.title).toBe('素材标题');
    // 原文不落库:content 是提取产物,不是素材原文。
    expect(entry!.content).toContain('知识要点');
    expect(entry!.content).not.toContain('素材原文');
  });

  it('未给 title → 标题取提取产物首个 markdown 标题行', async () => {
    const invoke = vi.fn<ModelInvoke>(async () => ok('# 提取出的标题\n\n正文'));
    const res = await digestMaterial({ text: '素材', workspace }, { invoke });
    expect(res.isOk()).toBe(true);
    const entry = activeBySource('material-digestion')[0];
    expect(entry.title).toBe('提取出的标题');
  });

  it('提取产物超 2KB → 截断至 ≤2KB 后落生效条目,且无 U+FFFD', async () => {
    const longContent = '要'.repeat(3000); // 3000 汉字 ≈ 9KB,远超 2048 字节
    const invoke = vi.fn<ModelInvoke>(async () => ok(`# 长文\n\n${longContent}`));
    const res = await digestMaterial({ text: '素材', workspace }, { invoke });
    expect(res.isOk()).toBe(true);

    const entry = activeBySource('material-digestion')[0];
    expect(Buffer.byteLength(entry.content, 'utf8')).toBeLessThanOrEqual(MEMORY_CONTENT_MAX_BYTES);
    expect(entry.content).not.toContain('\uFFFD');
  });

  it('截断不劈开多字节字符(代理对边界)', async () => {
    // 2046 字节 ASCII + 4 字节代理对字符(2050 字节) → 截断到 2048 字节必须整字符切。
    const straddle = 'a'.repeat(2046) + '𠀀' + 'b'.repeat(10);
    const invoke = vi.fn<ModelInvoke>(async () => ok(straddle));
    const res = await digestMaterial({ text: '素材', workspace }, { invoke });
    expect(res.isOk()).toBe(true);

    const entry = activeBySource('material-digestion')[0];
    expect(Buffer.byteLength(entry.content, 'utf8')).toBeLessThanOrEqual(MEMORY_CONTENT_MAX_BYTES);
    expect(entry.content).not.toContain('\uFFFD');
  });

  it('invoke 返回 Err(model-unavailable)→ err 同码直通,零落库', async () => {
    const proposeMemory = vi.fn();
    const invoke = vi.fn<ModelInvoke>(async () =>
      err({ code: 'model-unavailable', message: '未配置可用模型' }),
    );
    const res = await digestMaterial({ text: '素材', workspace }, { invoke, proposeMemory });
    expect(res.isErr()).toBe(true);
    expect(expectErrCode(res)).toBe('model-unavailable');
    expect(proposeMemory).not.toHaveBeenCalled();
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });

  it('invoke 超时(review-timed-out 返回 / 抛 timed out)→ digest-timed-out,零落库', async () => {
    // 生产 invoke 超时返回 review-timed-out → 归化为 digest-timed-out。
    const invoke1 = vi.fn<ModelInvoke>(async () =>
      err({ code: 'review-timed-out', message: '复盘生成超时,请重试(上限 120s)' }),
    );
    const res1 = await digestMaterial({ text: '素材', workspace }, { invoke: invoke1 });
    expect(expectErrCode(res1)).toBe('digest-timed-out');
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);

    // invoke 抛错(超时)→ 同样归化。
    const invoke2 = vi.fn<ModelInvoke>(async () => {
      throw new Error('request timed out');
    });
    const res2 = await digestMaterial({ text: '素材', workspace }, { invoke: invoke2 });
    expect(expectErrCode(res2)).toBe('digest-timed-out');
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });

  it('invoke 抛错(认证缺失)→ model-unavailable,零落库', async () => {
    const invoke = vi.fn<ModelInvoke>(async () => {
      throw new Error('No API key found');
    });
    const res = await digestMaterial({ text: '素材', workspace }, { invoke });
    expect(expectErrCode(res)).toBe('model-unavailable');
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });

  it('文本超过 200KB → 结构化拒绝,不调 invoke', async () => {
    const invoke = vi.fn<ModelInvoke>();
    const res = await digestMaterial(
      { text: 'x'.repeat(DIGEST_INPUT_MAX_BYTES + 1), workspace },
      { invoke },
    );
    expect(expectErrCode(res)).toBe('input-too-long');
    expect(invoke).not.toHaveBeenCalled();
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });

  it('空文本 → 结构化拒绝', async () => {
    const res = await digestMaterial({ text: '   \n ', workspace }, { invoke: vi.fn() });
    expect(expectErrCode(res)).toBe('empty-input');
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });

  // ---- digestFile ----

  it('digestFile: 读取文件 → 复用 digestMaterial 落 knowledge 生效条目', async () => {
    const file = path.join(userdata, 'notes.md');
    writeFileSync(file, '# 素材\n\n要点内容', 'utf8');
    const invoke = vi.fn<ModelInvoke>(async () => ok('# 提取\n\n- A'));
    const res = await digestFile(file, { workspace, invoke });
    expect(res.isOk()).toBe(true);

    const entry = activeBySource('material-digestion')[0];
    expect(entry.kind).toBe('knowledge');
    expect(entry.source).toBe('material-digestion');
    expect(entry.lifecycle).toBe('active');
  });

  it('digestFile: 文件不存在 → not-found,零落库', async () => {
    const res = await digestFile(path.join(userdata, 'missing.md'), {
      workspace,
      invoke: vi.fn(),
    });
    expect(expectErrCode(res)).toBe('not-found');
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });

  it('digestFile: 文件超过 200KB → 拒绝,不调 invoke', async () => {
    const file = path.join(userdata, 'big.md');
    writeFileSync(file, 'x'.repeat(DIGEST_INPUT_MAX_BYTES + 1), 'utf8');
    const invoke = vi.fn<ModelInvoke>();
    const res = await digestFile(file, { workspace, invoke });
    expect(expectErrCode(res)).toBe('input-too-long');
    expect(invoke).not.toHaveBeenCalled();
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });

  // ---- crystallize ----

  it('crystallize 成功 → user-stated/用户结晶 source 生效条目', async () => {
    const res = await crystallize({
      content: '记住:数据库连接池上限 20',
      title: '连接池',
      workspace,
    });
    expect(res.isOk()).toBe(true);

    const entry = activeBySource('user-crystallization')[0];
    expect(entry.kind).toBe('knowledge');
    expect(entry.source).toBe('user-crystallization');
    expect(entry.evidence).toBe('user-stated');
    expect(entry.scope).toBe('workspace');
    expect(entry.workspace).toBe(workspace);
    expect(entry.producer).toBe('user');
    expect(entry.basis).toBe('用户主动结晶');
    expect(entry.lifecycle).toBe('active');
    expect(entry.title).toBe('连接池');
    expect(entry.content).toBe('记住:数据库连接池上限 20');
  });

  it('crystallize 未给 title → 标题取内容首行', async () => {
    const res = await crystallize({
      content: '首行标题\n第二行细节',
      workspace,
    });
    expect(res.isOk()).toBe(true);
    const entry = activeBySource('user-crystallization')[0];
    expect(entry.title).toBe('首行标题');
  });

  it('结晶超长(>2048 字节)→ content-too-long,零落库', async () => {
    const res = await crystallize({
      content: 'x'.repeat(MEMORY_CONTENT_MAX_BYTES + 1),
      workspace,
    });
    expect(expectErrCode(res)).toBe('content-too-long');
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });

  it('结晶空内容 → empty-input,零落库', async () => {
    const res = await crystallize({ content: '  ', workspace });
    expect(expectErrCode(res)).toBe('empty-input');
    expect(expectOk<MemoryEntry[]>(store().listActive())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ingest 编译:命中既有知识页 → 调和 → 就地 update(supersedes 链);
// 未命中 → 新增。匹配/更新回调可注入,失败 fail-open。
// ---------------------------------------------------------------------------

describe('digestMaterial ingest 编译()', () => {
  const workspace = 'C:\\ws\\demo';
  const makeEntry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
    entryId: 'a'.repeat(64),
    schemaVersion: 1,
    tags: [],
    kind: 'knowledge',
    title: 't',
    content: 'c',
    producer: 'test',
    source: 'material-digestion',
    scope: 'workspace',
    workspace,
    evidence: 'extracted',
    basis: 'b',
    lifecycle: 'active',
    supersedes: null,
    createdAt: 1,
    updatedAt: 1,
    confirmedAt: 1,
    ofkRef: null,
    ...overrides,
  });

  it('标题命中既有知识页 → 第二次调和调用 → update(compiled=true + matchedTitle)', async () => {
    const invoke = vi
      .fn<ModelInvoke>()
      .mockResolvedValueOnce(ok('# 更新后的页面\n\n- 新要点')) // 提取
      .mockResolvedValueOnce(ok('# 合并后的页面\n\n- 保留旧\n- 吸收新')); // 调和
    const matched: MemoryEntry = makeEntry({
      entryId: 'old'.repeat(21) + 'x',
      title: '既有页',
      content: '旧内容',
      basis: '旧依据',
    });
    const updateMemory = vi.fn(async (_id: string, patch: UpdatePatch) => {
      expect(patch.title).toBe('既有页');
      expect(patch.content).toContain('合并后的页面');
      return ok(makeEntry({ title: '既有页', content: '合并后的页面' }));
    });
    const matchKnowledge = vi.fn(async () => ok(matched));

    const res = await digestMaterial(
      { text: '新材料', title: '既有页', workspace },
      { invoke, matchKnowledge, updateMemory, proposeMemory: vi.fn() },
    );
    expect(res.isOk()).toBe(true);
    expect(expectOk(res)).toMatchObject({ compiled: true, matchedTitle: '既有页' });
    expect(invoke).toHaveBeenCalledTimes(3); // 提取 + 调和 + 主题提取
    expect(updateMemory).toHaveBeenCalledTimes(1);
    expect(updateMemory).toHaveBeenCalledWith(
      matched.entryId,
      expect.objectContaining({ title: '既有页' }),
    );
  });

  it('未命中 → 新增(原语义,compiled 缺省)', async () => {
    const invoke = vi.fn<ModelInvoke>(async () => ok('# 新页\n\n内容'));
    const matchKnowledge = vi.fn(async () => ok(null));
    const res = await digestMaterial(
      { text: '素材', workspace },
      { invoke, matchKnowledge, proposeMemory: vi.fn(async () => ok(makeEntry())) },
    );
    expect(res.isOk()).toBe(true);
    expect(expectOk(res)).toEqual({ entryId: expect.any(String) });
    expect(invoke).toHaveBeenCalledTimes(2); // 提取 + 主题提取
  });

  it('匹配失败(fail-open)→ 退化为新增,不阻塞消化', async () => {
    const invoke = vi.fn<ModelInvoke>(async () => ok('# 新页\n\n内容'));
    const matchKnowledge = vi.fn(async () =>
      err({ code: 'digest-match-failed', message: '匹配器炸了' }),
    );
    const res = await digestMaterial({ text: '素材', workspace }, { invoke, matchKnowledge });
    expect(res.isOk()).toBe(true);
    expect(expectOk(res)).toEqual({ entryId: expect.any(String) });
  });

  it('调和调用失败 → 以新提取物直接 update(fail-open)', async () => {
    const invoke = vi
      .fn<ModelInvoke>()
      .mockResolvedValueOnce(ok('# 提取页\n\n- A'))
      .mockRejectedValueOnce(new Error('调和超时'));
    const matched = makeEntry({ entryId: 'm'.repeat(64), title: '既有页', content: '旧' });
    const updateMemory = vi.fn(async (_id: string, patch: UpdatePatch) =>
      ok(makeEntry({ title: '既有页', content: patch.content ?? '' })),
    );
    const res = await digestMaterial(
      { text: '素材', title: '既有页', workspace },
      { invoke, matchKnowledge: async () => ok(matched), updateMemory },
    );
    expect(res.isOk()).toBe(true);
    expect(expectOk(res)).toMatchObject({ compiled: true });
    expect(updateMemory).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ content: expect.stringContaining('提取页') }),
    );
  });
});

// ---------------------------------------------------------------------------
// 自动关联回链:digestMaterial 两个成功出口
// (新增 propose / 编译 update)在建链前提取主题短语(第三次 invoke)→ 注入
// linkKnowledge 建链。任何失败 fail-open:不改变消化结果。
// ---------------------------------------------------------------------------

describe('digestMaterial 自动关联()', () => {
  let userdata: string;
  const workspace = 'C:\\ws\\demo';
  const makeEntry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
    entryId: 'a'.repeat(64),
    schemaVersion: 1,
    tags: [],
    kind: 'knowledge',
    title: '新页',
    content: '内容',
    producer: 'material-digestion',
    source: 'material-digestion',
    scope: 'workspace',
    workspace,
    evidence: 'extracted',
    basis: '素材消化提取',
    lifecycle: 'active',
    supersedes: null,
    createdAt: 1,
    updatedAt: 1,
    confirmedAt: 1,
    ofkRef: null,
    ...overrides,
  });

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-digestion-links-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const s of openStores.splice(0)) s.close();
    resetSharedMemoryStoreForTest();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('propose 出口: 主题提取(第三次 invoke)→ linkKnowledge 以新页 id 建链', async () => {
    const invoke = vi
      .fn<ModelInvoke>()
      .mockResolvedValueOnce(ok('# 新页\n\n内容')) // 提取
      .mockResolvedValueOnce(ok('主题A')); // 主题提取
    const proposed = makeEntry({ entryId: 'p'.repeat(64) });
    const linkKnowledge = vi.fn(async () => ok([]));

    const res = await digestMaterial(
      { text: '素材', workspace },
      {
        invoke,
        matchKnowledge: async () => ok(null),
        proposeMemory: async () => ok(proposed),
        linkKnowledge,
      },
    );
    expect(res.isOk()).toBe(true);
    expect(expectOk(res)).toEqual({ entryId: 'p'.repeat(64) });
    expect(invoke).toHaveBeenCalledTimes(2); // 提取 + 主题
    expect(linkKnowledge).toHaveBeenCalledTimes(1);
    expect(linkKnowledge).toHaveBeenCalledWith('p'.repeat(64), ['主题A']);
  });

  it('update 出口: 调和后同样建链,以 update 返回的 entryId 为来源', async () => {
    const invoke = vi
      .fn<ModelInvoke>()
      .mockResolvedValueOnce(ok('# 提取页\n\n- A')) // 提取
      .mockResolvedValueOnce(ok('# 合并页\n\n- 新旧合并')) // 调和
      .mockResolvedValueOnce(ok('主题B')); // 主题提取
    const matched = makeEntry({ entryId: 'm'.repeat(64), title: '既有页', content: '旧' });
    const updated = makeEntry({ entryId: 'u'.repeat(64), title: '既有页', content: '合并页' });
    const updateMemory = vi.fn(async () => ok(updated));
    const linkKnowledge = vi.fn(async () => ok([]));

    const res = await digestMaterial(
      { text: '素材', title: '既有页', workspace },
      {
        invoke,
        matchKnowledge: async () => ok(matched),
        updateMemory,
        proposeMemory: vi.fn(),
        linkKnowledge,
      },
    );
    expect(res.isOk()).toBe(true);
    expect(expectOk(res)).toMatchObject({ compiled: true });
    expect(invoke).toHaveBeenCalledTimes(3); // 提取 + 调和 + 主题
    expect(linkKnowledge).toHaveBeenCalledTimes(1);
    expect(linkKnowledge).toHaveBeenCalledWith('u'.repeat(64), ['主题B']);
  });

  it('主题提取返回空串 → linkKnowledge 不被调,digest 仍 ok', async () => {
    const invoke = vi
      .fn<ModelInvoke>()
      .mockResolvedValueOnce(ok('# 新页\n\n内容')) // 提取
      .mockResolvedValueOnce(ok('   \n ')); // 主题提取:空输出
    const linkKnowledge = vi.fn(async () => ok([]));

    const res = await digestMaterial(
      { text: '素材', workspace },
      {
        invoke,
        matchKnowledge: async () => ok(null),
        proposeMemory: async () => ok(makeEntry()),
        linkKnowledge,
      },
    );
    expect(res.isOk()).toBe(true);
    expect(linkKnowledge).not.toHaveBeenCalled();
  });

  it('linkKnowledge 返回 err → 消化仍 ok(fail-open)', async () => {
    const invoke = vi
      .fn<ModelInvoke>()
      .mockResolvedValueOnce(ok('# 新页\n\n内容'))
      .mockResolvedValueOnce(ok('主题A'));
    const linkKnowledge = vi.fn(async () =>
      err({ code: 'memory-store-link-failed', message: '建链失败' }),
    );

    const res = await digestMaterial(
      { text: '素材', workspace },
      {
        invoke,
        matchKnowledge: async () => ok(null),
        proposeMemory: async () => ok(makeEntry()),
        linkKnowledge,
      },
    );
    expect(res.isOk()).toBe(true);
    expect(expectOk(res)).toEqual({ entryId: 'a'.repeat(64) });
  });

  it('linkKnowledge 抛错 → 消化仍 ok(fail-open)', async () => {
    const invoke = vi
      .fn<ModelInvoke>()
      .mockResolvedValueOnce(ok('# 新页\n\n内容'))
      .mockResolvedValueOnce(ok('主题A'));
    const linkKnowledge = vi.fn(async () => {
      throw new Error('链接器炸了');
    });

    const res = await digestMaterial(
      { text: '素材', workspace },
      {
        invoke,
        matchKnowledge: async () => ok(null),
        proposeMemory: async () => ok(makeEntry()),
        linkKnowledge,
      },
    );
    expect(res.isOk()).toBe(true);
  });

  it('主题提取 invoke 抛错 → 退化为纯确定性路径,digest 仍 ok', async () => {
    const invoke = vi
      .fn<ModelInvoke>()
      .mockResolvedValueOnce(ok('# 新页\n\n内容'))
      .mockRejectedValueOnce(new Error('主题提取超时'));
    const linkKnowledge = vi.fn(async () => ok([]));

    const res = await digestMaterial(
      { text: '素材', workspace },
      {
        invoke,
        matchKnowledge: async () => ok(null),
        proposeMemory: async () => ok(makeEntry()),
        linkKnowledge,
      },
    );
    expect(res.isOk()).toBe(true);
    expect(linkKnowledge).not.toHaveBeenCalled();
  });
});
