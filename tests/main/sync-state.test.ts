import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isFileUnchanged,
  readSyncState,
  SYNC_STATE_VERSION,
  statFile,
  syncStatePath,
  updateSyncState,
} from '../../src/main/ofk/sync-state';
import * as atomicWriteModule from '../../src/main/pi-sdk-driver/tool-safety/atomic-write';

// Requirement(plan S2/D1):同步水位存储——缺失/损坏/版本不符 → 空态;
// updateSyncState read-modify-write 串行化 + dirty-check;statFile/isFileUnchanged 判定。
// sync-state 只依赖 lorraConfigDir(调用时读 env),不依赖 electron;
// LORRA_E2E_USERDATA 指向 tmp 即隔离。

describe('sync-state', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-sync-state-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('syncStatePath = <userdata>/.lorra/sync-state.json', () => {
    expect(syncStatePath()).toBe(path.join(userdata, '.lorra', 'sync-state.json'));
  });

  it('缺失文件 → 空态', async () => {
    const state = await readSyncState();
    expect(state).toEqual({ version: SYNC_STATE_VERSION, files: {}, sources: {} });
  });

  it('损坏 JSON → 空态 + console.error', async () => {
    const p = syncStatePath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '{ not json', 'utf8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = await readSyncState();
    expect(state).toEqual({ version: SYNC_STATE_VERSION, files: {}, sources: {} });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('version 不符 → 空态', async () => {
    const p = syncStatePath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ version: 999, files: { a: {} }, sources: { opencode: 1 } }),
      'utf8',
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = await readSyncState();
    expect(state).toEqual({ version: SYNC_STATE_VERSION, files: {}, sources: {} });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('updateSyncState 写盘 + 可读回', async () => {
    await updateSyncState((s) => {
      s.files['C:\\work\\demo\\a.jsonl'] = { mtimeMs: 1, size: 2, conceptRel: 'sessions/x.md' };
      s.sources.opencode = 42;
    });
    const state = await readSyncState();
    expect(state.files['C:\\work\\demo\\a.jsonl']).toEqual({
      mtimeMs: 1,
      size: 2,
      conceptRel: 'sessions/x.md',
    });
    expect(state.sources.opencode).toBe(42);
  });

  it('两次并发 updateSyncState(不同 key) → 两次都生效(串行化)', async () => {
    await Promise.all([
      updateSyncState((s) => {
        s.files['C:\\a.jsonl'] = { mtimeMs: 1, size: 10, conceptRel: 'sessions/a.md' };
      }),
      updateSyncState((s) => {
        s.files['C:\\b.jsonl'] = { mtimeMs: 2, size: 20, conceptRel: 'sessions/b.md' };
      }),
    ]);
    const state = await readSyncState();
    expect(state.files['C:\\a.jsonl']).toBeDefined();
    expect(state.files['C:\\b.jsonl']).toBeDefined();
    expect(Object.keys(state.files).length).toBe(2);
  });

  it('mutate 后内容未变 → 不写盘(dirty-check)', async () => {
    const spy = vi.spyOn(atomicWriteModule, 'atomicWrite');
    try {
      await updateSyncState(() => {});
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('isFileUnchanged:全等 true;mtime/size 任一不等或 prev undefined → false', () => {
    const prev = { mtimeMs: 100, size: 10, conceptRel: 'sessions/x.md' };
    expect(isFileUnchanged(prev, { mtimeMs: 100, size: 10 })).toBe(true);
    expect(isFileUnchanged(prev, { mtimeMs: 101, size: 10 })).toBe(false);
    expect(isFileUnchanged(prev, { mtimeMs: 100, size: 11 })).toBe(false);
    expect(isFileUnchanged(undefined, { mtimeMs: 100, size: 10 })).toBe(false);
  });

  it('statFile:存在 → mtimeMs/size;不存在 → null', () => {
    const f = path.join(userdata, 'probe.txt');
    writeFileSync(f, 'hello', 'utf8');
    const stat = statFile(f);
    expect(stat).not.toBeNull();
    expect(stat!.size).toBe(5);
    expect(stat!.mtimeMs).toBeCloseTo(statSync(f).mtimeMs, 0);
    expect(statFile(path.join(userdata, 'nope.txt'))).toBeNull();
  });

  it('updateSyncState 写失败 → Err,水位不前移(fail-open)', async () => {
    await updateSyncState((s) => {
      s.files['C:\\keep.jsonl'] = { mtimeMs: 1, size: 1, conceptRel: 'sessions/keep.md' };
    });
    const before = readFileSync(syncStatePath(), 'utf8');
    const spy = vi
      .spyOn(atomicWriteModule, 'atomicWrite')
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      const result = await updateSyncState((s) => {
        s.files['C:\\c.jsonl'] = { mtimeMs: 3, size: 30, conceptRel: 'sessions/c.md' };
      });
      expect(result.isErr()).toBe(true);
      // 失败后磁盘仍是无新水位旧态(下轮 mtime 不匹配自然重提)
      expect(readFileSync(syncStatePath(), 'utf8')).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});
