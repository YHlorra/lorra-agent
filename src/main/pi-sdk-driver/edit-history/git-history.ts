import type { EditRecord } from '../edit-records';
import { runGit } from './git-run';
import type { EditMechanism } from './mechanism';

/**
 * git 主路径:lorra 自管的仓库(工厂确认启动时非用户仓库后才启用)。
 * 每次 AI 编辑一个 commit,复原 = restore 到该次编辑的父提交并再提交一次
 * (revert 也留痕,对话卡片与 git log 可互证)。
 *
 * 只对启动时非 git 仓库的工作区启用;用户已有仓库一律降级快照,绝不碰用户历史。
 */
export class GitEditHistory implements EditMechanism {
  readonly kind = 'git' as const;

  constructor(private readonly workspace: string) {}

  async finalize(record: EditRecord): Promise<{ commit: string; parentCommit: string }> {
    const add = await runGit(this.workspace, ['add', '--', record.fileId]);
    if (!add.ok) throw new Error(`git add failed: ${add.message}`);
    const commit = await runGit(this.workspace, [
      'commit',
      '-m',
      `lorra: ${record.toolName} ${record.fileId}`,
    ]);
    if (!commit.ok) throw new Error(`git commit failed: ${commit.message}`);
    const head = await runGit(this.workspace, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(`git rev-parse HEAD failed: ${head.message}`);
    const parent = await runGit(this.workspace, ['rev-parse', 'HEAD^']);
    if (!parent.ok) throw new Error(`git rev-parse HEAD^ failed: ${parent.message}`);
    return { commit: head.stdout, parentCommit: parent.stdout };
  }

  async revert(record: EditRecord): Promise<void> {
    const source = record.parentCommit;
    if (!source) throw new Error('missing parentCommit');
    const restore = await runGit(this.workspace, [
      'restore',
      '--source',
      source,
      '--staged',
      '--worktree',
      '--',
      record.fileId,
    ]);
    if (!restore.ok) throw new Error(`git restore failed: ${restore.message}`);
    const add = await runGit(this.workspace, ['add', '--', record.fileId]);
    if (!add.ok) throw new Error(`git add failed: ${add.message}`);
    const commit = await runGit(this.workspace, ['commit', '-m', `lorra: revert ${record.fileId}`]);
    if (!commit.ok) throw new Error(`git commit failed: ${commit.message}`);
  }

  async guardBeforeRevert(record: EditRecord): Promise<string> {
    const source = record.parentCommit;
    if (!source) return '编辑记录缺少父提交信息，无法复原';
    // rev-parse --verify 只验语法不验对象存在(40 位 hex 恒通过);cat-file -e 才查库。
    const verify = await runGit(this.workspace, ['cat-file', '-e', `${source}^{commit}`]);
    if (!verify.ok) return '编辑记录对应的提交已不存在（历史被改写）';
    const status = await runGit(this.workspace, ['status', '--porcelain', '--', record.fileId]);
    if (!status.ok) return `git status 失败:${status.message}`;
    if (status.stdout.length > 0) return '文件已被手动修改，无法复原';
    return '';
  }
}
