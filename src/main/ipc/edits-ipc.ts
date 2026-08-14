import { Result as ResultRuntime } from 'better-result';
import { ipcMain } from 'electron';
import type { SerializedResult } from '../../shared/result';
import { err, toSerialized } from '../../shared/result';
import type { LorraDriver } from '../pi-sdk-driver';

/**
 * 编辑历史 IPC:复原/接受/列表。与 session-ipc 同款 getter 模式——
 * handler 注册一次,driver 经 getter 实时解析(工作区切换后仍命中)。
 *
 * revert/accept 透传 driver 侧 better-result(具体错误码 file-dirty /
 * edit-not-found / edit-already-reverted / revert-failed),渲染端据码展示文案;
 * list 的存储 IO 异常由 tryPromise 兜底。
 */
export function registerEditsHandlers(getDriver: () => LorraDriver | null): void {
  const noWorkspace = (): SerializedResult<never> =>
    toSerialized(err({ code: 'no-workspace', message: 'workspace not set' }));

  ipcMain.handle('lorra.edits.revert', async (_e, args: { editId: string }) => {
    const driver = getDriver();
    if (!driver) return noWorkspace();
    return toSerialized(await driver.revertEdit(args.editId));
  });

  ipcMain.handle('lorra.edits.accept', async (_e, args: { editId: string }) => {
    const driver = getDriver();
    if (!driver) return noWorkspace();
    return toSerialized(await driver.acceptEdit(args.editId));
  });

  ipcMain.handle('lorra.edits.list', async (_e, args: { sessionId?: string }) => {
    const driver = getDriver();
    if (!driver) return noWorkspace();
    return ResultRuntime.tryPromise({
      try: async () => driver.listEdits(args.sessionId),
      catch: (cause) => ({
        code: 'edits-failed',
        message: cause instanceof Error ? cause.message : 'Unknown error',
      }),
    }).then(toSerialized);
  });
}
