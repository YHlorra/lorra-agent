import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Annotation } from '../../shared/annotations';
import { atomicWrite } from '../pi-sdk-driver/tool-safety/atomic-write';

/**
 * 标注存储:工作区 `.lorra/annotations.jsonl`(与 `.pi` 同级,文件树照常显示)。
 * 行式 JSON;损坏行跳过;文件不存在视为空集。MVP 单用户,同进程内串行读写,不做锁(最后写赢可接受)。
 */

const ANNOTATIONS_DIR = '.lorra';
const ANNOTATIONS_FILE = 'annotations.jsonl';

function annotationsFile(wsPath: string): string {
  return path.join(wsPath, ANNOTATIONS_DIR, ANNOTATIONS_FILE);
}

/** 绝对路径 → 工作区相对路径(正斜杠,跨平台)。 */
export function relPathOf(wsPath: string, absPath: string): string {
  return path.relative(wsPath, absPath).split(path.sep).join('/');
}

/** 读全量标注;ENOENT → [];损坏行跳过(不抛错);文件不存在时不创建目录。 */
export async function loadAnnotations(wsPath: string): Promise<Annotation[]> {
  let raw: string;
  try {
    raw = await readFile(annotationsFile(wsPath), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const annotations: Annotation[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      annotations.push(JSON.parse(trimmed) as Annotation);
    } catch {
      // 损坏行跳过,不抛错
    }
  }
  return annotations;
}

/** 按 id 替换或追加后整文件重写;写前确保目录存在,原子写。 */
export async function saveAnnotation(wsPath: string, ann: Annotation): Promise<void> {
  const all = await loadAnnotations(wsPath);
  const idx = all.findIndex((a) => a.id === ann.id);
  if (idx >= 0) all[idx] = ann;
  else all.push(ann);
  const file = annotationsFile(wsPath);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${all.map((a) => JSON.stringify(a)).join('\n')}\n`);
}

/** 按 id 过滤后重写;文件不存在或 id 不存在时静默成功。 */
export async function removeAnnotation(wsPath: string, id: string): Promise<void> {
  const all = await loadAnnotations(wsPath);
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return;
  const file = annotationsFile(wsPath);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${next.map((a) => JSON.stringify(a)).join('\n')}\n`);
}
