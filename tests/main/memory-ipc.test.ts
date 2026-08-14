import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../src/shared/result';

/**
 * 记忆 IPC 黑盒测试(任务 6.9 + ,TDD)。
 *
 * 规范真源:
 * - src/shared/memory-api.ts(通道名/参数形状唯一事实源,逐字使用)
 * - src/shared/memory-schema.ts 状态机(propose 直落 active / update 走
 * supersedes 链 / retire 语义)
 * - 契约:证据不因写入而改变(测试断言);edit = update 语义
 * (新建条目 + supersedes 链);归档 = retired + superseded;search 仅
 * active 按 scope 过滤;list-events = 审计视图(ts 倒序)。
 *
 * 测试模式照 today-ipc.test.ts:mock electron.ipcMain.handle 收集 handler,
 * 真 store + mkdtemp 临时库(LORRA_E2E_USERDATA 指向临时目录,禁碰真实
 * ~/.lorra;handler 与种子数据经 getSharedMemoryStore 同路径同实例)。
 */

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openStores: [] as Array<{ close(): void }>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, fn);
    },
  },
}));

// 6.13 消化/结晶:mock 提取器注入,断言三通道注册 + 错误码直通(真实提取器
// 链路由 material-digestion.test.ts 覆盖,这里只测 IPC 薄层)。
const digestionMock = vi.hoisted(() => ({
  digestMaterial: vi.fn(),
  digestFile: vi.fn(),
  crystallize: vi.fn(),
}));

vi.mock('../../src/main/memory/material-digestion', () => digestionMock);

// handler 内 getSharedMemoryStore 持有写句柄,测试后不会自行关闭 →
// Windows 无法 unlink 打开的 db。包一层真实 MemoryStore 登记实例,afterEach 统一 close。
vi.mock('../../src/main/memory/memory-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/memory/memory-store')>();
  return {
    ...actual,
    MemoryStore: {
      open: (dbPath: string) => {
        const result = actual.MemoryStore.open(dbPath);
        if (result.isOk()) electronMock.openStores.push(result.value);
        return result;
      },
    },
  };
});

import { registerMemoryIpc } from '../../src/main/ipc/memory-ipc';
import type { MemoryStore } from '../../src/main/memory/memory-store';
import {
  getSharedMemoryStore,
  resetSharedMemoryStoreForTest,
} from '../../src/main/memory/shared-memory-store';
import {
  MEMORY_CHANNEL_CRYSTALLIZE,
  MEMORY_CHANNEL_DIGEST_FILE,
  MEMORY_CHANNEL_DIGEST_TEXT,
  MEMORY_CHANNEL_EDIT,
  MEMORY_CHANNEL_LIST_ACTIVE,
  MEMORY_CHANNEL_LIST_ARCHIVED,
  MEMORY_CHANNEL_LIST_EVENTS,
  MEMORY_CHANNEL_LIST_LINKS,
  MEMORY_CHANNEL_RETIRE,
  MEMORY_CHANNEL_SEARCH,
} from '../../src/shared/memory-api';
import {
  MEMORY_SCHEMA_VERSION,
  type MemoryEntry,
  type MemoryEvent,
} from '../../src/shared/memory-schema';

type OkRes<T> = { status: 'ok'; value: T };
type ErrRes = { status: 'error'; error: { code: string; message: string } };
type IpcRes<T> = OkRes<T> | ErrRes;

async function invoke<T>(channel: string, args?: unknown): Promise<IpcRes<T>> {
  const handler = electronMock.handlers.get(channel);
  expect(handler).toBeDefined();
  return (await handler!(null, args)) as IpcRes<T>;
}

function okOf<T>(res: IpcRes<T>): T {
  expect(res.status).toBe('ok');
  return (res as OkRes<T>).value;
}

let seedSeq = 0;

/** 经真 store 直接 propose 一条(propose 即直落 active,无确认环节)。 */
function seedEntry(store: MemoryStore, over: Partial<Record<string, unknown>> = {}): MemoryEntry {
  seedSeq += 1;
  type ProposeInput = Parameters<MemoryStore['propose']>[0];
  const input: ProposeInput = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'working_context',
    title: `条目 ${seedSeq}`,
    content: `内容 ${seedSeq}`,
    producer: 'memory-ipc-test',
    source: 'agent-proposal',
    scope: 'user',
    workspace: null,
    evidence: 'inferred',
    basis: '测试依据',
    ...over,
  } as ProposeInput;
  const proposed = store.propose(input);
  if (proposed.isErr()) {
    throw new Error(`seed propose 失败: ${JSON.stringify(proposed.error)}`);
  }
  return proposed.value;
}

describe('memory-ipc(真 store + 临时库)', () => {
  let userdata: string;

  beforeEach(() => {
    seedSeq = 0;
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-memory-ipc-'));
    // handler 经 getSharedMemoryStore 默认路径落库;env 指向临时目录即隔离。
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    electronMock.handlers.clear();
    // 6.13:消化/结晶通道注入 workspace 当前值(参照 fs-ipc 的 getter 模式)。
    registerMemoryIpc({ getActiveWorkspacePath: () => 'ws-test' });
    digestionMock.digestMaterial.mockReset();
    digestionMock.digestFile.mockReset();
    digestionMock.crystallize.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const store of electronMock.openStores.splice(0)) store.close();
    resetSharedMemoryStoreForTest();
    rmSync(userdata, { recursive: true, force: true });
  });

  function store() {
    const r = getSharedMemoryStore();
    if (r.isErr()) throw new Error(`getSharedMemoryStore 失败: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  it('全部 memory 通道已注册(契约逐字;无 confirm/reject/batch 闸门通道)', () => {
    const channels = [
      MEMORY_CHANNEL_LIST_ACTIVE,
      MEMORY_CHANNEL_LIST_ARCHIVED,
      MEMORY_CHANNEL_LIST_EVENTS,
      MEMORY_CHANNEL_LIST_LINKS,
      MEMORY_CHANNEL_EDIT,
      MEMORY_CHANNEL_RETIRE,
      MEMORY_CHANNEL_SEARCH,
      // 6.13 素材消化 + 用户结晶。
      MEMORY_CHANNEL_DIGEST_TEXT,
      MEMORY_CHANNEL_DIGEST_FILE,
      MEMORY_CHANNEL_CRYSTALLIZE,
    ];
    for (const ch of channels) {
      expect(electronMock.handlers.has(ch)).toBe(true);
    }
    // 闸门通道已移除。
    expect(electronMock.handlers.has('lorra.memory.list-candidates')).toBe(false);
    expect(electronMock.handlers.has('lorra.memory.confirm')).toBe(false);
    expect(electronMock.handlers.has('lorra.memory.confirm-batch')).toBe(false);
    expect(electronMock.handlers.has('lorra.memory.reject')).toBe(false);
    expect(electronMock.handlers.has('lorra.memory.reject-batch')).toBe(false);
  });

  it('种子即生效: propose 直落 active + confirmedAt 非空, evidence/basis 与入参一致', async () => {
    const seeded = seedEntry(store(), { evidence: 'extracted', basis: '观察自会话记录' });
    // 无确认环节:写入即激活。
    expect(seeded.lifecycle).toBe('active');
    expect(seeded.confirmedAt).toBeTypeOf('number');
    // evidence/basis 原样(证据不因写入而改变)。
    expect(seeded.evidence).toBe('extracted');
    expect(seeded.basis).toBe('观察自会话记录');
    expect(seeded.supersedes).toBeNull();
    // 生效区可见(经 list-active 通道读回同一条)。
    const active = okOf<MemoryEntry[]>(await invoke(MEMORY_CHANNEL_LIST_ACTIVE));
    expect(active.map((e) => e.entryId)).toContain(seeded.entryId);
  });

  it('list-active / list-archived / list-events 三视图直通', async () => {
    const a = seedEntry(store());
    const b = seedEntry(store());
    await invoke(MEMORY_CHANNEL_RETIRE, { entryId: b.entryId });

    // 生效区:仅 a(propose 即 active;b 已 retired)。
    const active = okOf<MemoryEntry[]>(await invoke(MEMORY_CHANNEL_LIST_ACTIVE));
    expect(active.map((e) => e.entryId)).toContain(a.entryId);
    expect(active.map((e) => e.entryId)).not.toContain(b.entryId);

    // 归档:仅 b(retired)。
    const archived = okOf<MemoryEntry[]>(await invoke(MEMORY_CHANNEL_LIST_ARCHIVED));
    expect(archived.map((e) => e.entryId)).toEqual([b.entryId]);
    expect(archived[0].lifecycle).toBe('retired');
  });

  it('list-events:审计视图,ts 倒序;entryId 过滤直通', async () => {
    const seeded = seedEntry(store());
    const updated = okOf<MemoryEntry>(
      await invoke(MEMORY_CHANNEL_EDIT, {
        entryId: seeded.entryId,
        title: '改',
        content: '新内容',
      }),
    );

    // 无过滤:全部事件(seed recorded + update edited),ts 倒序。
    const all = okOf<MemoryEvent[]>(await invoke(MEMORY_CHANNEL_LIST_EVENTS));
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].ts).toBeGreaterThanOrEqual(all[i].ts);
    }

    // entryId 过滤:新条目仅有 edited(且 detail 记链)。
    const byEntry = okOf<MemoryEvent[]>(
      await invoke(MEMORY_CHANNEL_LIST_EVENTS, { entryId: updated.entryId }),
    );
    expect(byEntry.map((e) => e.event)).toEqual(['edited']);
    expect(byEntry[0].detail).toBe(`${seeded.entryId}→${updated.entryId}`);

    // 未知 entryId → 空数组。
    expect(
      okOf<MemoryEvent[]>(await invoke(MEMORY_CHANNEL_LIST_EVENTS, { entryId: 'missing' })),
    ).toEqual([]);
  });

  it('edit:新内容建新条目(supersedes 指向原),原条目 → superseded,新条目 active 且继承证据字段', async () => {
    const seeded = seedEntry(store(), {
      source: 'user-crystallization',
      evidence: 'user-stated',
      basis: '用户原话',
    });

    const res = await invoke<MemoryEntry>(MEMORY_CHANNEL_EDIT, {
      entryId: seeded.entryId,
      title: '新标题',
      content: '新内容 v2',
      basis: '用户澄清后的依据',
    });
    expect(res.status).toBe('ok');
    const edited = (res as OkRes<MemoryEntry>).value;

    // 新条目:active + supersedes 链 + 继承(update 语义)。
    expect(edited.entryId).not.toBe(seeded.entryId);
    expect(edited.lifecycle).toBe('active');
    expect(edited.supersedes).toBe(seeded.entryId);
    expect(edited.confirmedAt).toBeTypeOf('number');
    expect(edited.kind).toBe(seeded.kind);
    expect(edited.source).toBe(seeded.source);
    expect(edited.scope).toBe(seeded.scope);
    expect(edited.workspace).toBe(seeded.workspace);
    expect(edited.producer).toBe(seeded.producer);
    expect(edited.evidence).toBe(seeded.evidence); // 铁律:证据继承,不重估
    expect(edited.basis).toBe('用户澄清后的依据'); // 依据按编辑入参更新
    expect(edited.title).toBe('新标题');
    expect(edited.content).toBe('新内容 v2');

    // 原条目 → superseded(归档区)。
    const archived = okOf<MemoryEntry[]>(await invoke(MEMORY_CHANNEL_LIST_ARCHIVED));
    const old = archived.find((e) => e.entryId === seeded.entryId);
    expect(old).toBeDefined();
    expect(old!.lifecycle).toBe('superseded');

    // 新条目在生效区。
    const active = okOf<MemoryEntry[]>(await invoke(MEMORY_CHANNEL_LIST_ACTIVE));
    expect(active.map((e) => e.entryId)).toContain(edited.entryId);
    expect(active.map((e) => e.entryId)).not.toContain(seeded.entryId);
  });

  it('retire:active → retired,即时退出生效区并进入归档', async () => {
    const seeded = seedEntry(store());

    const res = await invoke<MemoryEntry>(MEMORY_CHANNEL_RETIRE, { entryId: seeded.entryId });
    expect(res.status).toBe('ok');
    expect((res as OkRes<MemoryEntry>).value.lifecycle).toBe('retired');

    const archived = okOf<MemoryEntry[]>(await invoke(MEMORY_CHANNEL_LIST_ARCHIVED));
    expect(archived.map((e) => e.entryId)).toContain(seeded.entryId);
    expect(archived.find((e) => e.entryId === seeded.entryId)!.lifecycle).toBe('retired');

    const active = okOf<MemoryEntry[]>(await invoke(MEMORY_CHANNEL_LIST_ACTIVE));
    expect(active.map((e) => e.entryId)).not.toContain(seeded.entryId);
  });

  it('search:仅 active,按 scope 过滤(user 全局 + 指定工作区)', async () => {
    const storeImpl = store();
    // propose 即 active(无确认环节)。
    const userEntry = seedEntry(storeImpl, {
      scope: 'user',
      workspace: null,
      content: 'alpha global memory note',
    });
    const wsEntry = seedEntry(storeImpl, {
      scope: 'workspace',
      workspace: 'ws-a',
      content: 'beta workspace log convention',
    });
    // retired 条目带同样关键词,不得进检索(检索永不授权)。
    const retired = seedEntry(storeImpl, { content: 'alpha retired copy' });
    await invoke(MEMORY_CHANNEL_RETIRE, { entryId: retired.entryId });

    // scope=user:只命中 user 级。
    const byUser = okOf<MemoryEntry[]>(
      await invoke(MEMORY_CHANNEL_SEARCH, { query: 'alpha', scope: 'user' }),
    );
    expect(byUser.map((e) => e.entryId)).toEqual([userEntry.entryId]);

    // scope=workspace + workspace=ws-a:user 级全局 + 本工作区。
    const byWs = okOf<MemoryEntry[]>(
      await invoke(MEMORY_CHANNEL_SEARCH, { query: 'beta', scope: 'workspace', workspace: 'ws-a' }),
    );
    expect(byWs.map((e) => e.entryId)).toEqual([wsEntry.entryId]);
    const byWsGlobal = okOf<MemoryEntry[]>(
      await invoke(MEMORY_CHANNEL_SEARCH, {
        query: 'alpha',
        scope: 'workspace',
        workspace: 'ws-a',
      }),
    );
    expect(byWsGlobal.map((e) => e.entryId)).toContain(userEntry.entryId);

    // retired 不进检索(检索永不授权)。
    const all = okOf<MemoryEntry[]>(await invoke(MEMORY_CHANNEL_SEARCH, { query: 'alpha' }));
    expect(all.map((e) => e.entryId)).not.toContain(retired.entryId);
    expect(all.every((e) => e.lifecycle === 'active')).toBe(true);
  });

  it('错误路径:edit/retire 不存在的 id → not-found', async () => {
    const editRes = await invoke<MemoryEntry>(MEMORY_CHANNEL_EDIT, {
      entryId: 'no-such-entry',
      title: 't',
      content: 'c',
    });
    expect(editRes.status).toBe('error');
    expect((editRes as ErrRes).error.code).toBe('not-found');

    const retireRes = await invoke<MemoryEntry>(MEMORY_CHANNEL_RETIRE, { entryId: 'missing' });
    expect(retireRes.status).toBe('error');
    expect((retireRes as ErrRes).error.code).toBe('not-found');
  });

  it('错误路径:retire 非 active 条目 → invalid-state;超长内容 edit → content-too-long', async () => {
    const seeded = seedEntry(store());
    await invoke(MEMORY_CHANNEL_RETIRE, { entryId: seeded.entryId });

    // 已 retired 再 retire → invalid-state。
    const again = await invoke<MemoryEntry>(MEMORY_CHANNEL_RETIRE, { entryId: seeded.entryId });
    expect(again.status).toBe('error');
    expect((again as ErrRes).error.code).toBe('invalid-state');

    // 超长内容 edit → content-too-long。
    const other = seedEntry(store());
    const tooLong = await invoke<MemoryEntry>(MEMORY_CHANNEL_EDIT, {
      entryId: other.entryId,
      title: '超长',
      content: 'x'.repeat(3000), // > MEMORY_CONTENT_MAX_BYTES(2048)
    });
    expect(tooLong.status).toBe('error');
    expect((tooLong as ErrRes).error.code).toBe('content-too-long');
  });

  it('list-links():图谱边数据出口全量直通', async () => {
    const storeImpl = store();
    const a = seedEntry(storeImpl, { kind: 'knowledge', title: '来源页' });
    const b = seedEntry(storeImpl, { kind: 'soft_preference', title: '目标偏好' });
    expect(
      okOf<Array<{ fromId: string; toId: string }>>(await invoke(MEMORY_CHANNEL_LIST_LINKS)),
    ).toEqual([]);

    const linked = storeImpl.linkRelated(a.entryId, ['目标偏好']);
    expect(linked.isErr()).toBe(false);
    if (linked.isOk()) expect(linked.value).toEqual([b.entryId]);

    const links = okOf<Array<{ fromId: string; toId: string }>>(
      await invoke(MEMORY_CHANNEL_LIST_LINKS),
    );
    expect(links).toEqual([{ fromId: a.entryId, toId: b.entryId }]);
  });

  // -------------------------------------------------------------------------
  // 6.13 素材消化 + 用户结晶:三通道注册 + 参数/错误码直通(mock 提取器注入)。
  // 真实提取逻辑由 material-digestion.test.ts 覆盖,这里只钉 IPC 薄层契约。
  // -------------------------------------------------------------------------

  it('digest-text:成功直通,注入 workspace 当前值', async () => {
    digestionMock.digestMaterial.mockResolvedValue(ok({ entryId: 'e1' }));

    const res = await invoke<{ entryId: string }>(MEMORY_CHANNEL_DIGEST_TEXT, {
      text: '素材正文',
      title: '素材标题',
    });
    expect(res.status).toBe('ok');
    expect((res as OkRes<{ entryId: string }>).value).toEqual({ entryId: 'e1' });
    expect(digestionMock.digestMaterial).toHaveBeenCalledWith({
      text: '素材正文',
      title: '素材标题',
      workspace: 'ws-test',
    });
  });

  it('digest-text:错误码直通(model-unavailable / digest-timed-out)', async () => {
    digestionMock.digestMaterial.mockResolvedValue(
      err({ code: 'model-unavailable', message: '未配置可用模型' }),
    );
    const res1 = await invoke(MEMORY_CHANNEL_DIGEST_TEXT, { text: 'x' });
    expect(res1.status).toBe('error');
    expect((res1 as ErrRes).error.code).toBe('model-unavailable');

    digestionMock.digestMaterial.mockResolvedValue(
      err({ code: 'digest-timed-out', message: '素材消化超时,请重试' }),
    );
    const res2 = await invoke(MEMORY_CHANNEL_DIGEST_TEXT, { text: 'x' });
    expect(res2.status).toBe('error');
    expect((res2 as ErrRes).error.code).toBe('digest-timed-out');
  });

  it('digest-file:注册 + 参数直通(filePath + workspace)', async () => {
    digestionMock.digestFile.mockResolvedValue(ok({ entryId: 'e2' }));

    const res = await invoke<{ entryId: string }>(MEMORY_CHANNEL_DIGEST_FILE, {
      filePath: 'C:\\tmp\\notes.md',
    });
    expect(res.status).toBe('ok');
    expect((res as OkRes<{ entryId: string }>).value).toEqual({ entryId: 'e2' });
    expect(digestionMock.digestFile).toHaveBeenCalledWith('C:\\tmp\\notes.md', {
      workspace: 'ws-test',
    });
  });

  it('digest-file:错误码直通(not-found)', async () => {
    digestionMock.digestFile.mockResolvedValue(err({ code: 'not-found', message: '文件不存在' }));
    const res = await invoke(MEMORY_CHANNEL_DIGEST_FILE, { filePath: 'C:\\tmp\\missing.md' });
    expect(res.status).toBe('error');
    expect((res as ErrRes).error.code).toBe('not-found');
  });

  it('crystallize:成功直通 + content-too-long 错误码直通', async () => {
    digestionMock.crystallize.mockResolvedValue(ok({ entryId: 'e3' }));
    const okRes = await invoke<{ entryId: string }>(MEMORY_CHANNEL_CRYSTALLIZE, {
      content: '记住这段',
      title: '标题',
    });
    expect(okRes.status).toBe('ok');
    expect((okRes as OkRes<{ entryId: string }>).value).toEqual({ entryId: 'e3' });
    expect(digestionMock.crystallize).toHaveBeenCalledWith({
      content: '记住这段',
      title: '标题',
      workspace: 'ws-test',
    });

    digestionMock.crystallize.mockResolvedValue(
      err({ code: 'content-too-long', message: 'content exceeds 2048 bytes' }),
    );
    const errRes = await invoke(MEMORY_CHANNEL_CRYSTALLIZE, { content: 'x'.repeat(3000) });
    expect(errRes.status).toBe('error');
    expect((errRes as ErrRes).error.code).toBe('content-too-long');
  });
});

describe('lorra.knowledge.read（）', () => {
  // 本 describe 独立注册 handler:within-file 随机序下不依赖兄弟 describe 先跑
  beforeEach(() => {
    registerMemoryIpc({ getActiveWorkspacePath: () => 'ws-test' });
  });

  it('读取 bundle 文档;穿越路径拒绝;不存在 → content null', async () => {
    const handler = electronMock.handlers.get('lorra.knowledge.read');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('handler missing');

    // 写入一个 bundle 文档
    const { writeConcept } = await import('../../src/main/ofk/ofk-bundle');
    const written = await writeConcept('memory/e1.md', '# 文档正文');
    expect(written.isOk()).toBe(true);

    const okRes = (await handler(null, { path: 'memory/e1.md' })) as {
      status: string;
      value?: { content: string | null };
      error?: { code: string };
    };
    expect(okRes.status).toBe('ok');
    expect(okRes.value?.content).toContain('# 文档正文');

    // canonical ofkRef 形态:迁移/工具产出的指针带前导 /(/memory/<id>.md),
    // 读取边界必须接受该形态(否则「查看文档」链路全断)
    const slashRes = (await handler(null, { path: '/memory/e1.md' })) as {
      status: string;
      value?: { content: string | null };
      error?: { code: string };
    };
    expect(slashRes.status).toBe('ok');
    expect(slashRes.value?.content).toContain('# 文档正文');

    const missing = (await handler(null, { path: 'memory/none.md' })) as {
      status: string;
      value?: { content: string | null };
    };
    expect(missing.status).toBe('ok');
    expect(missing.value?.content).toBeNull();

    const traversal = (await handler(null, { path: '../escape.md' })) as {
      status: string;
      error?: { code: string };
    };
    expect(traversal.status).toBe('error');
    expect(traversal.error?.code).toBe('ofk-path-invalid');

    // 前导斜杠剥除后仍是穿越 → 同样拒绝
    const slashTraversal = (await handler(null, { path: '/../escape.md' })) as {
      status: string;
      error?: { code: string };
    };
    expect(slashTraversal.status).toBe('error');
    expect(slashTraversal.error?.code).toBe('ofk-path-invalid');
  });
});
