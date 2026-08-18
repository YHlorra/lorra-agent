import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** 深度限制:超过即不再深入(文件树同款常识,防止扫穿网盘)。 */
const MAX_DEPTH = 4;

/** 目录跳过清单:依赖/元数据/隐藏目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.pi']);

export interface WorkspaceFileCandidate {
  /** 相对工作区路径(/ 分隔),可直接作 lorra.fs.open 的 fileId。 */
  fileId: string;
  /** 文件名(展示用)。 */
  name: string;
}

/**
 * 工作区文件树遍历单源:递归 readdir,跳过 node_modules/.git/.pi 与所有
 * `.` 开头隐藏项;visit 返回 true 立即停止整棵遍历(搜索限流/精确命中共用)。
 */
async function walkWorkspaceFiles(
  ws: string,
  visit: (entry: { abs: string; fileId: string; name: string }) => boolean | void,
): Promise<void> {
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > MAX_DEPTH) return false;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false; // 不可读目录静默跳过(防御)
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue; // .git/.pi/.env* 等隐藏项
      const abs = path.join(dir, name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (await walk(abs, depth + 1)) return true;
      } else if (entry.isFile()) {
        const fileId = path.relative(ws, abs).replace(/\\/g, '/');
        if (visit({ abs, fileId, name })) return true;
      }
    }
    return false;
  }

  await walk(ws, 0);
}

/**
 * 工作区文件名搜索(@ 引用候选):文件名小写包含 query 即命中;收集满 limit 或扫完停止。
 */
export async function searchWorkspaceFiles(
  ws: string,
  query: string,
  limit = 20,
): Promise<WorkspaceFileCandidate[]> {
  const q = query.toLowerCase();
  const results: WorkspaceFileCandidate[] = [];
  await walkWorkspaceFiles(ws, ({ fileId, name }) => {
    if (!name.toLowerCase().includes(q)) return false;
    results.push({ fileId, name });
    return results.length >= limit;
  });
  return results;
}

/**
 * 双链导航目标解析(2026-08-17):按文件名(去 .md/.markdown/.mdx 后缀、忽略
 * 大小写)精确匹配工作区文件,返回第一个命中 fileId 或 null。深度/跳过规则同搜索。
 */
export async function resolveWikilinkFile(ws: string, name: string): Promise<string | null> {
  const stem = name
    .trim()
    .replace(/\.(md|markdown|mdx)$/i, '')
    .toLowerCase();
  let hit: string | null = null;
  await walkWorkspaceFiles(ws, ({ fileId, name: n }) => {
    const nStem = n.replace(/\.(md|markdown|mdx)$/i, '').toLowerCase();
    if (nStem !== stem) return false;
    hit = fileId;
    return true;
  });
  return hit;
}
