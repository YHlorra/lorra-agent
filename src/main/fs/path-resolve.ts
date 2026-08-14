import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveAndCheck } from '../pi-sdk-driver/tool-safety/path-check';

/**
 * Opaque ID ↔ absolute-path mapping for the file tree. Per the
 * renderer never sees absolute paths; this module owns the resolution and
 * delegates containment checks to the safety interceptor.
 */

const WORKSPACE_ID = 'ws-root';

function hashFor(p: string): string {
  return createHash('sha1').update(p).digest('hex').slice(0, 16);
}

export function workspaceRootId(): string {
  return WORKSPACE_ID;
}

export function nodeId(absPath: string): string {
  return hashFor(absPath);
}

const reverseMap = new Map<string, string>();

export function registerPath(absPath: string, id: string): void {
  reverseMap.set(id, absPath);
}

export function clearPathRegistry(): void {
  reverseMap.clear();
}

export type ResolvedPath =
  | { ok: true; realpath: string; absPath: string }
  | { ok: false; code: 'unknown-id' | 'path-out-of-workspace' };

export async function resolveId(id: string, workspacePath: string): Promise<ResolvedPath> {
  // hash id 优先; diff 卡「在中栏打开」传相对路径作 fileId——仅当
  // 目标真实存在时才按路径解析,否则维持 unknown-id(旧 hash id 语义)。
  let absPath = id === WORKSPACE_ID ? workspacePath : reverseMap.get(id);
  if (!absPath) {
    const candidate = path.isAbsolute(id) ? id : path.resolve(workspacePath, id);
    try {
      await stat(candidate);
      absPath = candidate;
    } catch {
      return { ok: false, code: 'unknown-id' };
    }
  }
  const check = await resolveAndCheck(workspacePath, absPath);
  if (!check.ok) return { ok: false, code: check.code };
  return { ok: true, realpath: check.realpath, absPath };
}

export interface TreeNode {
  id: string;
  name: string;
  type: 'file' | 'dir';
  hasChildren: boolean;
}

export async function readTree(directoryId: string, workspacePath: string): Promise<TreeNode[]> {
  const resolved = await resolveId(directoryId, workspacePath);
  if (!resolved.ok) throw new Error(`cannot list: ${resolved.code}`);
  const entries = await readdir(resolved.realpath, { withFileTypes: true });
  const nodes: TreeNode[] = [];
  for (const e of entries) {
    const abs = path.join(resolved.realpath, e.name);
    let hasChildren = false;
    if (e.isDirectory()) {
      try {
        const sub = await readdir(abs);
        hasChildren = sub.length > 0;
      } catch {
        // unreadable subdir: treat as leaf for the UI
      }
    }
    const id = nodeId(abs);
    registerPath(abs, id);
    nodes.push({
      id,
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      hasChildren,
    });
  }
  return nodes;
}

export async function readFileContent(
  fileId: string,
  workspacePath: string,
): Promise<{ content: string; mtime: number; size: number }> {
  const resolved = await resolveId(fileId, workspacePath);
  if (!resolved.ok) throw new Error(`cannot open: ${resolved.code}`);
  const [content, st] = await Promise.all([
    readFile(resolved.realpath, 'utf8'),
    stat(resolved.realpath),
  ]);
  return { content, mtime: st.mtimeMs, size: st.size };
}
