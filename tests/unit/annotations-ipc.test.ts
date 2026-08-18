import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAnnotation } from '../../src/main/annotations/annotations-store';
import { clearPathRegistry, registerPath } from '../../src/main/fs/path-resolve';
import { registerFsHandlers } from '../../src/main/ipc/fs-ipc';
import type { Annotation, AnnotationDraft } from '../../src/shared/annotations';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

interface IpcCall {
  channel: string;
  handler: (...args: unknown[]) => unknown;
}

function captureIpcHandlers(): IpcCall[] {
  const calls: IpcCall[] = [];
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel: string, handler) => {
    calls.push({ channel, handler: handler as (...args: unknown[]) => unknown });
    return undefined;
  });
  return calls;
}

/** IPC 信封收窄:handler 返回值是 SerializedResult<T> 纯数据,运行时校验后取 value。 */
function okValue<T>(result: unknown): T {
  if (typeof result === 'object' && result !== null && 'ok' in result && result.ok === true) {
    return (result as { ok: true; value: T }).value;
  }
  throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
}

let ws: string;
let fileAbs: string;
let fileId: string;
let calls: IpcCall[];

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-ann-ipc-'));
  fileAbs = path.join(ws, 'a.md');
  writeFileSync(fileAbs, '# hi\nsome text');
  fileId = 'file-a';
  clearPathRegistry();
  registerPath(fileAbs, fileId);
  calls = captureIpcHandlers();
  registerFsHandlers({ getActiveWorkspacePath: () => ws });
});

afterEach(() => {
  clearPathRegistry();
  rmSync(ws, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeAnn(over: Partial<Annotation> & { id: string }): Annotation {
  return {
    relPath: 'a.md',
    kind: 'md',
    text: '选中文本',
    anchor: { type: 'text', before: '', after: '' },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function makeDraft(over: Partial<AnnotationDraft> & { id: string }): AnnotationDraft {
  return {
    kind: 'md',
    text: '选中文本',
    anchor: { type: 'text', before: '', after: '' },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

async function handlerOf(channel: string) {
  const call = calls.find((c) => c.channel === channel);
  expect(call, `channel ${channel} registered`).toBeDefined();
  return call?.handler.bind(null);
}

describe('annotations IPC boundary', () => {
  it('lorra.annotations.list:无工作区 → no-workspace', async () => {
    clearPathRegistry();
    calls = captureIpcHandlers();
    registerFsHandlers({ getActiveWorkspacePath: () => null });
    const result = await calls
      .find((c) => c.channel === 'lorra.annotations.list')
      ?.handler(null, {
        fileId,
      });
    expect(result).toMatchObject({ ok: false, error: { code: 'no-workspace' } });
  });

  it('lorra.annotations.list:未知 fileId → unknown-file', async () => {
    const h = await handlerOf('lorra.annotations.list');
    const result = await h?.(null, { fileId: 'bogus-id' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-file' } });
  });

  it('lorra.annotations.list:成功路径返回该文件(relPath 过滤后)的标注', async () => {
    await saveAnnotation(ws, makeAnn({ id: 'mine', relPath: 'a.md' }));
    await saveAnnotation(ws, makeAnn({ id: 'other', relPath: 'b.md' }));

    const h = await handlerOf('lorra.annotations.list');
    const result = await h?.(null, { fileId });
    expect(result).toMatchObject({ ok: true });
    expect(okValue<Annotation[]>(result).map((a) => a.id)).toEqual(['mine']);
  });

  it('lorra.annotations.save:未知 fileId → unknown-file', async () => {
    const h = await handlerOf('lorra.annotations.save');
    const result = await h?.(null, {
      fileId: 'bogus-id',
      annotation: makeDraft({ id: 'x' }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-file' } });
  });

  it('lorra.annotations.save:成功路径回填 relPath 并落盘', async () => {
    const h = await handlerOf('lorra.annotations.save');
    const result = await h?.(null, {
      fileId,
      annotation: makeDraft({ id: 'new1' }),
    });
    expect(result).toMatchObject({ ok: true });

    const list = await handlerOf('lorra.annotations.list');
    const listed = await list?.(null, { fileId });
    expect(okValue<Annotation[]>(listed)).toEqual([
      expect.objectContaining({ id: 'new1', relPath: 'a.md' }),
    ]);
  });

  it('lorra.annotations.remove:成功路径删除后 list 为空', async () => {
    await saveAnnotation(ws, makeAnn({ id: 'del1', relPath: 'a.md' }));
    const h = await handlerOf('lorra.annotations.remove');
    const result = await h?.(null, { fileId, id: 'del1' });
    expect(result).toMatchObject({ ok: true });

    const list = await handlerOf('lorra.annotations.list');
    const listed = await list?.(null, { fileId });
    expect(okValue<Annotation[]>(listed)).toEqual([]);
  });

  it('lorra.annotations.remove:未知 fileId → unknown-file', async () => {
    const h = await handlerOf('lorra.annotations.remove');
    const result = await h?.(null, { fileId: 'bogus-id', id: 'x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-file' } });
  });

  it('通道名遵守 lorra.* 白名单且不含 path 字段', () => {
    for (const call of calls) {
      expect(call.channel).toMatch(/^lorra\.(workspace|session|fs|annotations|events)/);
      expect(call.channel).not.toContain('path');
    }
  });
});
