import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Mock electron at module level so session-ipc.ts and this test share the same
// ipcMain.handle spy (vitest module mock is a singleton).
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { ipcMain } from 'electron';
import { registerSessionHandlers } from '../../src/main/ipc/session-ipc';

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;

function registeredHandlers(): Map<string, Handler> {
  const map = new Map<string, Handler>();
  for (const [channel, fn] of (ipcMain.handle as Mock).mock.calls as [string, Handler][]) {
    map.set(channel, fn);
  }
  return map;
}

// 斜杠命令(pi TUI)的 compact IPC 通道:注册 + 错误包装 + 结果透传。
describe('session-ipc compact 通道', () => {
  let handlers: Map<string, Handler>;
  let driver: { compact: Mock };
  let call: (payload?: unknown) => Promise<unknown>;

  beforeEach(() => {
    (ipcMain.handle as Mock).mockClear();
    driver = { compact: vi.fn() };
    registerSessionHandlers(() => driver as never);
    handlers = registeredHandlers();
    const compact = handlers.get('lorra.session.compact');
    if (!compact) throw new Error('lorra.session.compact not registered');
    call = (payload) => compact({}, payload);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Given driver 空闲接受 When compact 调用 Then 返回 accepted:true', async () => {
    driver.compact.mockResolvedValue({ accepted: true });
    await expect(call({ sessionId: 's1' })).resolves.toEqual({
      status: 'ok',
      value: { accepted: true },
    });
    expect(driver.compact).toHaveBeenCalledWith('s1');
  });

  it('Given driver 忙碌拒绝 When compact 调用 Then 透传 accepted:false', async () => {
    driver.compact.mockResolvedValue({ accepted: false });
    await expect(call({ sessionId: 's1' })).resolves.toEqual({
      status: 'ok',
      value: { accepted: false },
    });
  });

  it('Given driver 抛错 When compact 调用 Then 包装为 session-failed 错误', async () => {
    driver.compact.mockRejectedValue(new Error('Nothing to compact'));
    await expect(call({ sessionId: 's1' })).resolves.toEqual({
      status: 'error',
      error: { code: 'session-failed', message: 'Nothing to compact' },
    });
  });

  it('Given 无 driver When compact 调用 Then 返回 no-workspace', async () => {
    (ipcMain.handle as Mock).mockClear();
    registerSessionHandlers(() => null);
    handlers = registeredHandlers();
    const compact = handlers.get('lorra.session.compact');
    if (!compact) throw new Error('lorra.session.compact not registered');
    await expect(compact({}, { sessionId: 's1' })).resolves.toEqual({
      status: 'error',
      error: { code: 'no-workspace', message: 'workspace not set' },
    });
  });
});
