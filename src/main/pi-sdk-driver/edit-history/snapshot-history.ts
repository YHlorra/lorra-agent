import path from 'node:path';
import type { EditRecord } from '../edit-records';
import { atomicWrite } from '../tool-safety/atomic-write';
import type { EditMechanism } from './mechanism';

/**
 * 快照降级路径:已 git 仓库/无 git 二进制/init 失败的工作区走这里。
 * finalize no-op(执行即落盘,无需额外提交);复原 = 原子写回执行前内容。
 * v1 无复原守卫(Assumptions 4:快照路径主要服务已 git 仓库的工作区)。
 */
export class SnapshotEditHistory implements EditMechanism {
  readonly kind = 'snapshot' as const;

  constructor(private readonly workspace: string) {}

  async finalize(_record: EditRecord): Promise<{ commit: string; parentCommit: string }> {
    return { commit: '', parentCommit: '' };
  }

  async revert(record: EditRecord): Promise<void> {
    await atomicWrite(path.join(this.workspace, record.fileId), record.before);
  }

  async guardBeforeRevert(_record: EditRecord): Promise<string> {
    return '';
  }
}
