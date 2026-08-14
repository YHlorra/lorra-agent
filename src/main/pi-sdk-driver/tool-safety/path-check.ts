import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type PathCheckResult =
  | { ok: true; realpath: string }
  | { ok: false; code: 'path-out-of-workspace'; realpath?: string };

/** `~`/`~/...`/`~\...` → homedir;`~user` 不展开(不存在 → 硬拦,安全)。 */
function expandHome(p: string, homedir: string): string {
  if (p === '~') return homedir;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir, p.slice(2));
  return p;
}

export async function resolveAndCheck(
  workspaceRoot: string,
  candidatePath: string,
  homedir: string = os.homedir(),
): Promise<PathCheckResult> {
  const expanded = expandHome(candidatePath, homedir);
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(workspaceRoot, expanded);

  let rp: string;
  try {
    rp = await realpath(resolved);
  } catch {
    // Path doesn't exist or cannot resolve — treat as out-of-workspace
    // (default-deny per D6 / spec "Path outside workspace").
    return { ok: false, code: 'path-out-of-workspace' };
  }

  const wsRoot = await realpath(workspaceRoot);
  const wsRootPrefix = wsRoot.endsWith(path.sep) ? wsRoot : wsRoot + path.sep;

  if (rp !== wsRoot && !rp.startsWith(wsRootPrefix)) {
    // 路径存在但在工作区外:携带 realpath 供上层做可信路径判定。
    return { ok: false, code: 'path-out-of-workspace', realpath: rp };
  }

  return { ok: true, realpath: rp };
}
