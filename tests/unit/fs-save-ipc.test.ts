import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPathRegistry, registerPath } from '../../src/main/fs/path-resolve';
import { registerFsHandlers } from '../../src/main/ipc/fs-ipc';

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
  if (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    result.status === 'ok'
  ) {
    return (result as { status: 'ok'; value: T }).value;
  }
  throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
}

function errCode(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    result.status === 'error'
  ) {
    return (result as { status: 'error'; error: { code: string } }).error.code;
  }
  throw new Error(`expected error result, got ${JSON.stringify(result)}`);
}

let ws: string;
let fileAbs: string;
let fileId: string;
let calls: IpcCall[];

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-save-ipc-'));
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

async function save(args: {
  fileId: string;
  content: string;
  baseMtime?: number;
}): Promise<unknown> {
  const call = calls.find((c) => c.channel === 'lorra.fs.save');
  expect(call, 'lorra.fs.save registered').toBeDefined();
  return call?.handler(null, args);
}

describe('lorra.fs.save IPC', () => {
  it('无工作区 → no-workspace', async () => {
    calls = captureIpcHandlers();
    registerFsHandlers({ getActiveWorkspacePath: () => null });
    const result = await save({ fileId, content: 'x' });
    expect(errCode(result)).toBe('no-workspace');
  });

  it('未知 fileId → unknown-id', async () => {
    const result = await save({ fileId: 'bogus-id', content: 'x' });
    expect(errCode(result)).toBe('unknown-id');
  });

  it('happy path:baseMtime 匹配 → 原子写入,返回新 mtime', async () => {
    const baseMtime = statSync(fileAbs).mtimeMs;
    const content = '---\ntitle: 新标题\n---\n\n正文\n';
    const result = await save({ fileId, content, baseMtime });
    expect(result).toMatchObject({ status: 'ok' });
    const value = okValue<{ mtime: number }>(result);
    expect(value.mtime).toBeGreaterThanOrEqual(baseMtime);
    expect(readFileSync(fileAbs, 'utf8')).toBe(content);
  });

  it('保存内容逐字节等于入参(含尾换行等)', async () => {
    const content = '# hi\nsome text\n\n- [ ] task\n```js\n1+1\n```\n';
    const baseMtime = statSync(fileAbs).mtimeMs;
    const result = await save({ fileId, content, baseMtime });
    expect(result).toMatchObject({ status: 'ok' });
    expect(readFileSync(fileAbs, 'utf8')).toBe(content);
  });

  it('baseMtime 不匹配(文件被其他来源修改)→ file-changed,文件内容未被改动', async () => {
    const baseMtime = statSync(fileAbs).mtimeMs;
    // 模拟外部修改:直接写盘,并把 mtime 显式推进(同毫秒内连续写盘时
    // NTFS 时间戳可能不变,导致守卫误判——utimes 保证确定性)。
    writeFileSync(fileAbs, '# hi\nexternal edit');
    const later = new Date(Date.now() + 2000);
    utimesSync(fileAbs, later, later);
    const result = await save({ fileId, content: '# hi\ninternal edit', baseMtime });
    expect(errCode(result)).toBe('file-changed');
    expect(readFileSync(fileAbs, 'utf8')).toBe('# hi\nexternal edit');
  });

  it('baseMtime 缺省时不做守卫,直接写入', async () => {
    const result = await save({ fileId, content: 'no guard' });
    expect(result).toMatchObject({ status: 'ok' });
    expect(readFileSync(fileAbs, 'utf8')).toBe('no guard');
  });
});
