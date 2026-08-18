import { readFile } from 'node:fs/promises';
import { resolveId } from '../fs/path-resolve';

/**
 * 粘贴图片 → 视觉内容块(2026-08-15):
 *
 * 输入栏粘贴的图片被保存为 `<ws>/.lorra/attachments/paste-*.png`(见
 * clipboard-ipc.ts),composer 发送时只透传 fileId。driver.send 侧据此解析
 * 路径、读取字节、嗅探 mime,组装成 SDK prompt 支持的视觉块
 * `{ type: 'image', data: <base64>, mimeType }`。
 *
 * 为何在此手写 mime 嗅探而非复用 SDK:
 * - SDK 的 `detectSupportedImageMimeTypeFromFile` 位于 `dist/utils/mime.js`,
 * package.json exports 仅暴露 `.` / `./rpc-entry` / `./client`,子路径不可
 * 由消费者正则导入(与 loadInlineExtension 手写最小 Extension 同款纪律)。
 * - 此处只判定 SDK 支持的既定图片格式(png/jpeg/gif/webp/bmp),判定结果与
 * `dist/core/tools/read.js` 一致,保证粘贴图与 read 工具走同一视觉管道。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Buffer, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readUint32BE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}

function isAnimatedPng(buffer: Buffer): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, 'acTL')) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, 'IDAT')) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

/**
 * 嗅探前若干字节,判定是否为 SDK 支持的图片格式。非图片/bmp/动画 png → null。
 * 只取支持格式,与 SDK `detectSupportedImageMimeType` 行为对齐。
 */
export function sniffImageMimeType(buffer: Buffer): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : 'image/jpeg';
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return !isAnimatedPng(buffer) ? 'image/png' : null;
  }
  if (startsWithAscii(buffer, 0, 'GIF')) return 'image/gif';
  if (startsWithAscii(buffer, 0, 'RIFF') && startsWithAscii(buffer, 8, 'WEBP')) {
    return 'image/webp';
  }
  return null;
}

export interface PastedImage {
  /** 工作区相对路径,即 composer 收到的 fileId。 */
  fileId: string;
}

/** 组装后的视觉块,直接转给 SDK prompt(options.images)。 */
export interface ImageContentBlock {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

export type LoadImagesResult =
  | { ok: true; blocks: ImageContentBlock[] }
  | { ok: false; message: string };

/**
 * 按 fileId 解析并读取粘贴图片,组装视觉块。任一文件非图片/读取失败都不阻断
 * 全部:能读的读,读不到的跳过;一个都读不到才算整体失败(调用方据此降级)。
 */
export async function loadPastedImages(
  workspacePath: string,
  images: PastedImage[],
): Promise<LoadImagesResult> {
  const blocks: ImageContentBlock[] = [];
  for (const image of images) {
    try {
      const resolved = await resolveId(image.fileId, workspacePath);
      if (!resolved.ok) continue; // 越界/未知 id,拿不到就不发该块
      const buffer = await readFile(resolved.realpath);
      const mimeType = sniffImageMimeType(buffer);
      if (!mimeType) continue; // 非图片,跳过(纯文本引用已在 composer 保留)
      blocks.push({ type: 'image', data: buffer.toString('base64'), mimeType });
    } catch {
      // 读盘失败:跳过该块,绝不阻断发送(与 driver 整体 fail-open 一致)
    }
  }
  if (blocks.length > 0) {
    return { ok: true, blocks };
  }
  return { ok: false, message: 'no image blocks loaded' };
}
