import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadAnnotations,
  relPathOf,
  removeAnnotation,
  saveAnnotation,
} from '../../src/main/annotations/annotations-store';
import type { Annotation } from '../../src/shared/annotations';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-ann-store-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function ann(over: Partial<Annotation> & { id: string }): Annotation {
  return {
    relPath: 'docs/a.md',
    kind: 'md',
    text: '选中文本',
    anchor: { type: 'text', before: '前文', after: '后文' },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('annotations-store', () => {
  it('loadAnnotations: 文件不存在(ENOENT)返回空数组', async () => {
    expect(await loadAnnotations(ws)).toEqual([]);
  });

  it('saveAnnotation + loadAnnotations:追加新 id,按 id 替换旧条目', async () => {
    await saveAnnotation(ws, ann({ id: 'a1' }));
    await saveAnnotation(ws, ann({ id: 'a2', text: '第二条' }));
    await saveAnnotation(ws, ann({ id: 'a1', text: '已编辑' }));

    const all = await loadAnnotations(ws);
    expect(all).toHaveLength(2);
    expect(all.find((a) => a.id === 'a1')?.text).toBe('已编辑');
    expect(all.find((a) => a.id === 'a2')?.text).toBe('第二条');
  });

  it('saveAnnotation:目录与文件在写前被创建(.lorra/annotations.jsonl)', async () => {
    await saveAnnotation(ws, ann({ id: 'a1' }));
    const raw = await readFile(path.join(ws, '.lorra', 'annotations.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(raw)).toMatchObject({ id: 'a1', relPath: 'docs/a.md' });
  });

  it('removeAnnotation:按 id 删除后重写;id 不存在时静默成功', async () => {
    await saveAnnotation(ws, ann({ id: 'a1' }));
    await saveAnnotation(ws, ann({ id: 'a2' }));

    await removeAnnotation(ws, 'a1');
    expect((await loadAnnotations(ws)).map((a) => a.id)).toEqual(['a2']);

    await removeAnnotation(ws, 'nope');
    expect((await loadAnnotations(ws)).map((a) => a.id)).toEqual(['a2']);
  });

  it('removeAnnotation:文件不存在时静默成功(不抛错不创建)', async () => {
    await expect(removeAnnotation(ws, 'ghost')).resolves.toBeUndefined();
  });

  it('loadAnnotations:损坏行跳过,不抛错', async () => {
    await saveAnnotation(ws, ann({ id: 'good' }));
    const file = path.join(ws, '.lorra', 'annotations.jsonl');
    await appendFile(file, '{broken json\n{"id":"ok2","relPath":"b.md"}\n');

    const all = await loadAnnotations(ws);
    expect(all.map((a) => a.id)).toEqual(['good', 'ok2']);
  });

  it('relPathOf:绝对路径转正斜杠相对路径', () => {
    expect(relPathOf('C:\\ws', 'C:\\ws\\docs\\a.md')).toBe('docs/a.md');
    expect(relPathOf('/home/u/ws', '/home/u/ws/x/y.txt')).toBe('x/y.txt');
    expect(relPathOf('C:\\ws', 'C:\\ws\\a.md')).toBe('a.md');
  });
});
