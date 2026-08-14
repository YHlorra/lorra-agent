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
 * 工作区文件名搜索(@ 引用候选):递归 readdir,跳过 node_modules/.git/.pi
 * 与所有 `.` 开头隐藏项;文件名小写包含 query 即命中;收集满 limit 或扫完停止。
 */
export async function searchWorkspaceFiles(
  ws: string,
  query: string,
  limit = 20,
): Promise<WorkspaceFileCandidate[]> {
  const q = query.toLowerCase();
  const results: WorkspaceFileCandidate[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= limit || depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录静默跳过(防御)
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const name = entry.name;
      if (name.startsWith('.')) continue; // .git/.pi/.env* 等隐藏项
      const abs = path.join(dir, name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(abs, depth + 1);
      } else if (entry.isFile() && name.toLowerCase().includes(q)) {
        const fileId = path.relative(ws, abs).replace(/\\/g, '/');
        results.push({ fileId, name });
      }
    }
  }

  await walk(ws, 0);
  return results;
}
