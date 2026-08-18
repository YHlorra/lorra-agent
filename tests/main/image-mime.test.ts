/**
 * 粘贴图片 → SDK 视觉内容块(image-mime,2026-08-15 半程重构补测试)。
 *
 * 契约(对齐 image-mime.ts 注释与 driver.send fail-open 语义):
 * - sniffImageMimeType:png/jpeg/gif/webp → 对应 mime;动画 png / 非图片 /
 * 坏字节 → null(只收 SDK 支持的既定静态格式)。
 * - loadPastedImages:按 fileId(工作区相对路径)解析 → 读盘 → 嗅探 mime →
 * 组装 { type:'image', data:base64, mimeType } 块。越界/未知 id、非图片、
 * 读盘失败 → 该块跳过(能读的读、读不到的跳);一个都读不到 → { ok:false }。
 *
 * 环境:node(真实 fs + 临时工作区);遵守 红线——所有文件读写落在
 * mkdtemp 临时目录内,不触碰真实 ~/.lorra / 用户目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPastedImages, sniffImageMimeType } from '../../src/main/pi-sdk-driver/image-mime';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
// 带 acTL 块的动画 PNG(非静态,应被 sniff 拒绝)。
const ANIMATED_PNG = Buffer.concat([
  PNG,
  Buffer.from([0x00, 0x00, 0x00, 0x08, 0x61, 0x63, 0x54, 0x4c, 0x00, 0x00, 0x00, 0x01]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);

describe('sniffImageMimeType', () => {
  it('png 签名 → image/png', () => {
    expect(sniffImageMimeType(PNG)).toBe('image/png');
  });
  it('jpeg 签名 → image/jpeg', () => {
    expect(sniffImageMimeType(JPEG)).toBe('image/jpeg');
  });
  it('gif 签名 → image/gif', () => {
    expect(sniffImageMimeType(GIF)).toBe('image/gif');
  });
  it('webp 签名 → image/webp', () => {
    expect(sniffImageMimeType(WEBP)).toBe('image/webp');
  });
  it('动画 png(acTL)→ null(不收动画)', () => {
    expect(sniffImageMimeType(ANIMATED_PNG)).toBeNull();
  });
  it('非图片字节 → null', () => {
    expect(sniffImageMimeType(Buffer.from('hello world'))).toBeNull();
  });
  it('空 buffer → null', () => {
    expect(sniffImageMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('loadPastedImages', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), 'lorra-img-'));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  function write(rel: string, bytes: Buffer): string {
    const abs = path.join(ws, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    return rel;
  }

  it('正常路径:fileId(相对路径)→ 组装出 base64 视觉块', async () => {
    const rel = write('.lorra/attachments/paste-1.png', PNG);
    const result = await loadPastedImages(ws, [{ fileId: rel }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({
      type: 'image',
      data: PNG.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('多个图片:各组装一块,顺序保持', async () => {
    const a = write('a.png', PNG);
    const b = write('b.jpg', JPEG);
    const result = await loadPastedImages(ws, [{ fileId: a }, { fileId: b }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks.map((x) => x.mimeType)).toEqual(['image/png', 'image/jpeg']);
  });

  it('越界/未知 fileId → 跳过,不阻断其余块', async () => {
    const good = write('good.png', PNG);
    const result = await loadPastedImages(ws, [
      { fileId: '.lorra/attachments/missing.png' },
      { fileId: good },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].mimeType).toBe('image/png');
  });

  it('非图片字节 → 跳过该块', async () => {
    const txt = write('note.png', Buffer.from('not really an image'));
    const good = write('real.png', PNG);
    const result = await loadPastedImages(ws, [{ fileId: txt }, { fileId: good }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks).toHaveLength(1);
  });

  it('全部读不到 / 全部非图片 → 整体失败 { ok:false }', async () => {
    const result = await loadPastedImages(ws, [{ fileId: 'nope.png' }]);
    expect(result).toEqual({ ok: false, message: 'no image blocks loaded' });
  });
});
