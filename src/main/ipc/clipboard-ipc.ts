import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clipboard, ipcMain } from 'electron';
import type { SerializedResult } from '../../shared/result';
import { err, ok, toSerialized } from '../../shared/result';

/**
 * 剪贴板 IPC（输入栏粘贴图片，2026-08-14）：
 * saveImage —— 读取系统剪贴板图片，PNG 编码后写入
 * `<ws>/.lorra/attachments/paste-<ts>-<rand>.png`，返回 { fileId, name, dataUrl }。
 *
 * - fileId = 工作区相对路径（posix 分隔）：agent 的 read 工具以工作区为 cwd，
 * 可直接按此路径读取图片文件；也兼容 fs.open（resolveId 相对路径语义）。
 * - dataUrl 供渲染端缩略预览（单次 IPC 往返，不二次回读）。
 * - 剪贴板无图片 → clipboard-no-image；图片 > 25MB → clipboard-image-too-large
 * （防巨型 IPC 消息与磁盘占用）；写盘失败 → clipboard-save-failed。
 * - 渲染端仅在 paste 事件 clipboardData 含图片项时才调用，文本粘贴走默认行为。
 * 工作区路径经 getter 取当前活跃值（切换工作区后仍写最新路径，fs-ipc 同款）。
 */

/** 粘贴图片字节上限（PNG 编码后；4K 截图通常 < 15MB）。 */
const IMAGE_BYTES_MAX = 25 * 1024 * 1024;

export interface SavedClipboardImage {
  fileId: string;
  name: string;
  dataUrl: string;
}

export function registerClipboardHandlers(opts: {
  getActiveWorkspacePath: () => string | null;
}): void {
  ipcMain.handle(
    'lorra.clipboard.saveImage',
    async (): Promise<SerializedResult<SavedClipboardImage>> => {
      const wsPath = opts.getActiveWorkspacePath();
      if (!wsPath) {
        return toSerialized(err({ code: 'no-workspace', message: '工作区未就绪' }));
      }
      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return toSerialized(err({ code: 'clipboard-no-image', message: '剪贴板没有图片' }));
      }
      const png = image.toPNG();
      if (png.byteLength > IMAGE_BYTES_MAX) {
        return toSerialized(
          err({ code: 'clipboard-image-too-large', message: '图片过大，无法粘贴' }),
        );
      }
      const rel = path.posix.join(
        '.lorra',
        'attachments',
        `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
      );
      const abs = path.join(wsPath, ...rel.split('/'));
      try {
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, png);
      } catch (cause) {
        return toSerialized(
          err({
            code: 'clipboard-save-failed',
            message: cause instanceof Error ? cause.message : '图片保存失败',
          }),
        );
      }
      return toSerialized(
        ok({
          fileId: rel,
          name: path.basename(rel),
          dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        }),
      );
    },
  );
}
