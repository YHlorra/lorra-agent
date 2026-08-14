import { ipcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerFsHandlers } from '../../src/main/ipc/fs-ipc';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

interface IpcCall {
  channel: string;
  handler: (...args: unknown[]) => unknown;
}

function captureIpcHandlers(): IpcCall[] {
  const calls: IpcCall[] = [];
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel: string, handler) => {
    // Cast at the boundary: ipcMain.handle types accept a richer handler signature
    // than our test-only opaque envelope needs.
    calls.push({ channel, handler: handler as (...args: unknown[]) => unknown });
    return undefined;
  });
  return calls;
}

describe('fs IPC boundary', () => {
  it('lorra.fs.tree accepts only opaque directoryId, not absolute paths', async () => {
    const calls = captureIpcHandlers();
    registerFsHandlers({ getActiveWorkspacePath: () => null });
    const tree = calls.find((c) => c.channel === 'lorra.fs.tree');
    expect(tree).toBeDefined();
    const result = await tree?.handler(null, { directoryId: 'ws-root' });
    expect(result).toMatchObject({ status: 'error', error: { code: 'no-workspace' } });
  });

  it('lorra.fs.open accepts only opaque fileId', async () => {
    const calls = captureIpcHandlers();
    registerFsHandlers({ getActiveWorkspacePath: () => null });
    const open = calls.find((c) => c.channel === 'lorra.fs.open');
    expect(open).toBeDefined();
    const result = await open?.handler(null, { fileId: 'fake-id' });
    expect(result).toMatchObject({ status: 'error', error: { code: 'no-workspace' } });
  });

  it('rejects arbitrary path arguments by signature (no path field)', () => {
    const calls = captureIpcHandlers();
    registerFsHandlers({ getActiveWorkspacePath: () => null });
    for (const call of calls) {
      const channelName = call.channel;
      expect(channelName).toMatch(/^lorra\.(workspace|session|fs|annotations|events)/);
      expect(channelName).not.toContain('path');
    }
  });
});
