import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EditRecord, EditRecordStore } from '../../src/main/pi-sdk-driver/edit-records';

function makeRecord(over: Partial<EditRecord> = {}): EditRecord {
  return {
    id: 'call-1',
    sessionId: 's1',
    toolName: 'edit',
    fileId: 'docs/a.md',
    before: 'old',
    ts: Date.now(),
    status: 'applied',
    kind: 'snapshot',
    ...over,
  };
}

describe('EditRecordStore', () => {
  let dir: string;
  let store: EditRecordStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lorra-edits-'));
    store = new EditRecordStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('目录不存在时 load 为空存储,不抛错', async () => {
    await store.load();
    expect(await store.list()).toEqual([]);
    expect(await store.get('call-1')).toBeNull();
  });

  it('save 后 get/list 可见;updateStatus 变更并持久化', async () => {
    await store.load();
    await store.save(makeRecord());

    const got = await store.get('call-1');
    expect(got?.fileId).toBe('docs/a.md');
    expect(got?.status).toBe('applied');

    const updated = await store.updateStatus('call-1', 'accepted');
    expect(updated?.status).toBe('accepted');

    // 重新实例化(模拟重启)仍能读到落盘数据
    const store2 = new EditRecordStore(dir);
    await store2.load();
    const reloaded = await store2.get('call-1');
    expect(reloaded?.status).toBe('accepted');
  });

  it('list 按 sessionId 过滤,并按 ts 倒序', async () => {
    await store.load();
    await store.save(makeRecord({ id: 'a', sessionId: 's1', ts: 100 }));
    await store.save(makeRecord({ id: 'b', sessionId: 's1', ts: 300 }));
    await store.save(makeRecord({ id: 'c', sessionId: 's2', ts: 200 }));

    const all = await store.list();
    expect(all.map((r) => r.id)).toEqual(['b', 'c', 'a']);

    const s1 = await store.list('s1');
    expect(s1.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('load 丢弃超 7 天的已裁决记录;applied 保留', async () => {
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    await store.load();
    await store.save(makeRecord({ id: 'old-accepted', ts: weekAgo, status: 'accepted' }));
    await store.save(makeRecord({ id: 'old-reverted', ts: weekAgo, status: 'reverted' }));
    await store.save(makeRecord({ id: 'old-applied', ts: weekAgo, status: 'applied' }));
    await store.save(makeRecord({ id: 'fresh-accepted', ts: now, status: 'accepted' }));

    const store2 = new EditRecordStore(dir);
    await store2.load();
    const ids = (await store2.list()).map((r) => r.id);
    expect(ids).toContain('old-applied');
    expect(ids).toContain('fresh-accepted');
    expect(ids).not.toContain('old-accepted');
    expect(ids).not.toContain('old-reverted');
  });

  it('load 幂等:重复 load 不丢数据、不重复', async () => {
    await store.load();
    await store.save(makeRecord({ id: 'x' }));
    await store.load();
    await store.load();
    expect((await store.list()).map((r) => r.id)).toEqual(['x']);
  });

  it('损坏的 edits.json → 空存储,不抛错', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'edits.json'), '{ not json', 'utf8');
    await store.load();
    expect(await store.list()).toEqual([]);
  });

  it('updateStatus 对不存在 id 返回 null', async () => {
    await store.load();
    expect(await store.updateStatus('nope', 'accepted')).toBeNull();
    // 落盘文件不应被创建(无记录时 persist 不触发)
    await expect(readFile(path.join(dir, 'edits.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
