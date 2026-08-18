import type { EditRecord } from '../edit-records';

/**
 * 编辑执行机制接口(git | snapshot 两路径)。存储与执行分离:
 * EditRecordStore 负责记录持久化,EditMechanism 负责实际写盘/复原。
 */
export interface EditMechanism {
  readonly kind: 'git' | 'snapshot';

  /**
   * 记录保存后调用:git 路径 commit 并回填 hash;snapshot 路径 no-op。
   * 抛错 = 提交失败(调用方 best-effort 吞掉,不阻断 AI 操作)。
   */
  finalize(record: EditRecord): Promise<{ commit: string; parentCommit: string }>;

  /** 复原:git 路径 restore+commit;snapshot 路径原子写回 before。抛错 = 复原失败。 */
  revert(record: EditRecord): Promise<void>;

  /** 复原前守卫:返回非空字符串 = 拒绝原因(git: 有未提交改动/历史被改写;snapshot: 无守卫)。 */
  guardBeforeRevert(record: EditRecord): Promise<string>;
}
