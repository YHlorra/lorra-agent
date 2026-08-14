import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { GitEditHistory } from './git-history';
import { runGit } from './git-run';
import type { EditMechanism } from './mechanism';
import { SnapshotEditHistory } from './snapshot-history';

/**
 * 按工作区状态选择执行机制:
 * 1. git 二进制缺失(ENOENT) → snapshot
 * 2. 已是 git 仓库 → snapshot(绝不 commit 用户仓库)
 * 3. 非仓库且 git 可用 → git init + baseline commit → git;任一失败降级 snapshot
 */
export async function createEditMechanism(workspace: string): Promise<EditMechanism> {
  const snapshot = () => new SnapshotEditHistory(workspace);

  const probe = await runGit(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (!probe.ok) {
    // 二进制缺失 → 快照;非仓库(rev-parse 退出码 128) → 尝试自管仓库。
    if (probe.code === 'ENOENT') return snapshot();
    return initSelfManagedRepo(workspace);
  }
  // stdout 'true' = 已在仓库内(含子目录):降级,用户历史神圣不可侵犯。
  return snapshot();
}

async function initSelfManagedRepo(workspace: string): Promise<EditMechanism> {
  const init = await runGit(workspace, ['init']);
  if (!init.ok) return new SnapshotEditHistory(workspace);

  // .git/info/exclude 是仓库私有文件(lorra 不写用户的 .gitignore)。
  // lorra 临时文件前缀进 exclude,避免 status --porcelain 被无关文件污染。
  const excludePath = path.join(workspace, '.git', 'info', 'exclude');
  try {
    await appendFile(excludePath, '\n.lorra-tmp\n', 'utf8');
  } catch {
    // best-effort:exclude 写失败不影响主流程
  }

  const add = await runGit(workspace, ['add', '-A']);
  if (!add.ok) return new SnapshotEditHistory(workspace);

  const commit = await runGit(workspace, ['commit', '-m', 'lorra: baseline']);
  if (!commit.ok) return new SnapshotEditHistory(workspace);

  return new GitEditHistory(workspace);
}
