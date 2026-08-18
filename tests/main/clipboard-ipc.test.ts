/**
 * 剪贴板 IPC 测试(输入栏粘贴图片,2026-08-14)。
 *
 * 环境照 skills-ipc.test.ts 先例:electron mock(clipboard.readImage 由测试桩
 * 提供图像源 + ipcMain.handle 捕获)+ 真实临时目录作为工作区。
 *
 * 契约:
 * - saveImage 无参;成功 → { fileId, name, dataUrl }(fileId = 工作区相对 posix 路径,
 * dataUrl = data:image/png;base64,…)
 * - 剪贴板无图片 → clipboard-no-image;图片 > 25MB → clipboard-image-too-large;
 * 工作区未就绪 → no-workspace;写盘失败 → clipboard-save-failed
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedClipboardImage } from '../../src/main/ipc/clipboard-ipc';
import type { SerializedResult } from '../../src/shared/result';

const electronMock = vi.hoisted(() => ({
  image: { isEmpty: () => true, toPNG: () => Buffer.from([]) } as {
    isEmpty: () => boolean;
    toPNG: () => Buffer;
  },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  clipboard: {
    readImage: () => electronMock.image,
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, fn);
    },
  },
}));

import { registerClipboardHandlers } from '../../src/main/ipc/clipboard-ipc';

/** 直接调用已捕获的 handler(模拟 ipcMain.handle 收到 invoke)。 */
async function call<T>(channel: string, args?: unknown): Promise<SerializedResult<T>> {
  const handler = electronMock.handlers.get(channel);
  expect(handler).toBeDefined();
  return (await handler!(null, args)) as SerializedResult<T>;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('clipboard-ipc(lorra.clipboard.saveImage)', () => {
  let ws: string;
  let activePath: string | null;

  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), 'lorra-clip-'));
    activePath = ws;
    electronMock.image = { isEmpty: () => false, toPNG: () => PNG_BYTES };
    electronMock.handlers.clear();
    registerClipboardHandlers({ getActiveWorkspacePath: () => activePath });
  });

  afterEach(() => {
    electronMock.image = { isEmpty: () => true, toPNG: () => Buffer.from([]) };
    activePath = null;
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('Scenario 剪贴板含图片 → PNG 落 <ws>/.lorra/attachments/ 并返回 fileId/name/dataUrl', async () => {
    const res = await call<SavedClipboardImage>('lorra.clipboard.saveImage');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.fileId).toMatch(/^\.lorra\/attachments\/paste-\d+-[a-z0-9]+\.png$/);
    expect(res.value.name).toBe(path.basename(res.value.fileId));
    expect(res.value.dataUrl.startsWith('data:image/png;base64,')).toBe(true);

    // 文件真实写入工作区,字节与剪贴板源一致;fileId 相对路径可直接 resolve。
    const abs = path.join(ws, ...res.value.fileId.split('/'));
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs)).toEqual(PNG_BYTES);
    expect(res.value.dataUrl).toBe(`data:image/png;base64,${PNG_BYTES.toString('base64')}`);
  });

  it('Scenario 剪贴板无图片 → clipboard-no-image,不写盘', async () => {
    electronMock.image = { isEmpty: () => true, toPNG: () => PNG_BYTES };
    const res = await call<SavedClipboardImage>('lorra.clipboard.saveImage');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('clipboard-no-image');
      expect(res.error.message).toContain('剪贴板没有图片');
    }
  });

  it('Scenario 图片超过 25MB → clipboard-image-too-large', async () => {
    electronMock.image = { isEmpty: () => false, toPNG: () => Buffer.alloc(25 * 1024 * 1024 + 1) };
    const res = await call<SavedClipboardImage>('lorra.clipboard.saveImage');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('clipboard-image-too-large');
      expect(res.error.message).toContain('图片过大');
    }
  });

  it('Scenario 工作区未就绪 → no-workspace', async () => {
    activePath = null;
    const res = await call<SavedClipboardImage>('lorra.clipboard.saveImage');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('no-workspace');
    }
  });

  it('Scenario 写盘失败(工作区路径是文件)→ clipboard-save-failed', async () => {
    const filePath = path.join(ws, 'not-a-dir');
    writeFileSync(filePath, 'x');
    activePath = filePath;
    const res = await call<SavedClipboardImage>('lorra.clipboard.saveImage');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('clipboard-save-failed');
    }
  });
});
