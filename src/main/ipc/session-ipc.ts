import { Result as ResultRuntime } from 'better-result';
import { ipcMain } from 'electron';
import type { SerializedResult } from '../../shared/result';
import { toSerialized } from '../../shared/result';
import type { LorraDriver } from '../pi-sdk-driver';

/**
 * Session IPC is registered once at app startup but reads the active driver
 * through a getter so the renderer's session calls hit the correct driver
 * even when the workspace has been switched at runtime.
 */
export function registerSessionHandlers(getDriver: () => LorraDriver | null): void {
  function withDriver<T>(fn: (driver: LorraDriver) => Promise<T>): Promise<SerializedResult<T>> {
    const driver = getDriver();
    if (!driver) {
      return Promise.resolve({
        status: 'error',
        error: { code: 'no-workspace', message: 'workspace not set' },
      });
    }
    return ResultRuntime.tryPromise({
      try: async () => fn(driver),
      catch: (cause) => ({
        code: 'session-failed',
        message: cause instanceof Error ? cause.message : 'Unknown error',
      }),
    }).then(toSerialized);
  }

  ipcMain.handle('lorra.session.list', async () =>
    withDriver(async (driver) => driver.listSessions()),
  );

  ipcMain.handle('lorra.session.open', async (_e, args: { sessionId: string }) =>
    withDriver(async (driver) => driver.openSession(args.sessionId)),
  );

  ipcMain.handle('lorra.session.continueRecent', async () =>
    withDriver(async (driver) => driver.continueRecent()),
  );

  ipcMain.handle('lorra.session.new', async () =>
    withDriver(async (driver) => driver.newSession()),
  );

  ipcMain.handle('lorra.session.send', async (_e, args: { sessionId: string; text: string }) =>
    withDriver(async (driver) => driver.send(args.sessionId, args.text)),
  );

  ipcMain.handle('lorra.session.abort', async (_e, args: { sessionId: string }) =>
    withDriver(async (driver) => {
      await driver.abort(args.sessionId);
      return true;
    }),
  );

  ipcMain.handle('lorra.session.compact', async (_e, args: { sessionId: string }) =>
    withDriver(async (driver) => driver.compact(args.sessionId)),
  );

  ipcMain.handle(
    'lorra.session.respondApproval',
    async (
      _e,
      args: {
        sessionId: string;
        approvalId: string;
        decision: 'allowOnce' | 'allowAlways' | 'deny';
      },
    ) =>
      withDriver(async (driver) => {
        await driver.respondApproval(args.sessionId, args.approvalId, args.decision);
        return true;
      }),
  );
}
