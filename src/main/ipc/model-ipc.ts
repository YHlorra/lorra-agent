import { Result as ResultRuntime } from 'better-result';
import { ipcMain } from 'electron';
import type { LorraError, Result, SerializedResult } from '../../shared/result';
import { err, toLorraError, toSerialized } from '../../shared/result';
import type { ModelConfigAdapter } from '../pi-sdk-driver/model-config';

function redactString(value: string): string {
  // 纵深防御：先脱 sk-* / Bearer * 值片段，再脱 key=value / key: value 凭据片段
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)\S+/gi, '$1$2***');
}

function redactResult<T>(result: Result<T>): Result<T> {
  // 纵深防御：adapter 已不主动泄凭据，此处在 IPC 边界再扫一遍 error message。
  return result.isOk()
    ? result
    : err({ code: result.error.code, message: redactString(result.error.message) });
}

/** 兜底捕获 adapter 意外 throw，统一 code 并在 IPC 边界脱敏。 */
function unexpected(cause: unknown): LorraError {
  const le = toLorraError(cause, 'model-ipc-failed');
  return { code: le.code, message: redactString(le.message) };
}

/** 包装「已返回 Result」的 adapter 调用：透传其 err（边界脱敏），兜底捕获意外 throw。 */
async function invoke<T>(
  operation: () => Result<T> | Promise<Result<T>>,
): Promise<SerializedResult<T>> {
  const result = await ResultRuntime.tryPromise({
    try: async () => await operation(),
    catch: unexpected,
  });
  return toSerialized(redactResult(ResultRuntime.flatten(result)));
}

/** 包装「返回原始数据」的 adapter 调用：成功包成 ok，异常兜底捕获。 */
function invokeData<T>(operation: () => T | Promise<T>): Promise<SerializedResult<T>> {
  return ResultRuntime.tryPromise({
    try: async () => await operation(),
    catch: unexpected,
  }).then(toSerialized);
}

export function registerModelHandlers(adapter: ModelConfigAdapter): void {
  ipcMain.handle('lorra.providers.catalog', () => invokeData(() => adapter.catalog()));
  ipcMain.handle('lorra.providers.list', () => invokeData(() => adapter.listConnected()));
  ipcMain.handle('lorra.providers.connect', (_e, args: { providerId: string; material?: string }) =>
    invoke(() => adapter.connect(args.providerId, args.material)),
  );
  ipcMain.handle('lorra.providers.disconnect', (_e, args: { providerId: string }) =>
    invoke(() => adapter.disconnect(args.providerId)),
  );
  // : per-provider auth-status query so the ConnectView can show the
  // env-var-detected hint without putting env-detected providers into the
  // "已连接" sidebar (which leaks developer's terminal env into lorra).
  ipcMain.handle('lorra.providers.getAuthStatus', (_e, args: { providerId: string }) =>
    invokeData(() => adapter.getAuthStatus(args.providerId)),
  );
  // 真实连接校验（OQ-7 / D12 / spec 5.2）：补全此前漏接的通道——适配器有此方法，
  // 但 IPC/preload 此前未暴露，导致 UI「测试连接」按钮调到 undefined。
  ipcMain.handle('lorra.providers.testConnection', (_e, args: { providerId: string }) =>
    invoke(() => adapter.testConnection(args.providerId)),
  );
  ipcMain.handle('lorra.providers.custom.add', (_e, input) =>
    invoke(() => adapter.customAdd(input)),
  );
  ipcMain.handle('lorra.providers.custom.remove', (_e, args: { providerId: string }) =>
    invoke(() => adapter.customRemove(args.providerId)),
  );
  ipcMain.handle('lorra.models.list', (_e, args: { providerId?: string }) =>
    invokeData(() => adapter.listModels(args.providerId)),
  );
  ipcMain.handle('lorra.models.getDefault', () => invokeData(() => adapter.getDefault()));
  ipcMain.handle('lorra.models.setDefault', (_e, args: { providerId: string; modelId: string }) =>
    invoke(() => adapter.setDefault(args.providerId, args.modelId)),
  );
  ipcMain.handle(
    'lorra.models.toggle',
    (_e, args: { providerId: string; modelId: string; enabled: boolean }) =>
      invoke(() => adapter.toggleModel(args.providerId, args.modelId, args.enabled)),
  );
  ipcMain.handle('lorra.models.getAvailable', () => invokeData(() => adapter.getAvailable()));
}
