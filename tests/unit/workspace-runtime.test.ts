import { afterEach, describe, expect, it, vi } from 'vitest';

const createdDrivers: Array<{
  workspacePath: string;
  shutdown: ReturnType<typeof vi.fn>;
  attached: Array<{ id: number; isDestroyed: () => boolean }>;
  detachedIds: number[];
  nextId: number;
}> = [];

vi.mock('../../src/main/pi-sdk-driver', () => {
  class MockDriver {
    workspacePath: string;
    shutdown: () => Promise<void>;
    private readonly record: (typeof createdDrivers)[number];
    constructor(opts: { workspacePath: string }) {
      this.workspacePath = opts.workspacePath;
      const shutdown = vi.fn().mockResolvedValue(undefined);
      this.shutdown = () => shutdown();
      this.record = {
        workspacePath: opts.workspacePath,
        shutdown,
        attached: [],
        detachedIds: [],
        nextId: 0,
      };
      createdDrivers.push(this.record);
    }
    async shutdownAll(): Promise<void> {
      await this.shutdown();
    }
    getActiveSessionId(): string | null {
      return null;
    }
    emitToolBlocked(): void {}
    attachWebContents(wc: { isDestroyed: () => boolean }): () => void {
      const id = ++this.record.nextId;
      this.record.attached.push({ id, isDestroyed: () => wc.isDestroyed() });
      return () => {
        this.record.detachedIds.push(id);
        this.record.attached = this.record.attached.filter((entry) => entry.id !== id);
      };
    }
  }
  return { LorraDriver: MockDriver };
});

vi.mock('../../src/main/pi-sdk-driver/session-persistence', () => ({
  createSessionPersistence: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/main/pi-sdk-driver/lorra-config-dir', () => ({
  lorraConfigDir: () => '/tmp/test/.lorra',
}));

import { createWorkspaceRuntime } from '../../src/main/workspace/runtime';

afterEach(() => {
  createdDrivers.length = 0;
});

describe('workspace runtime', () => {
  it('starts with no active path and no driver', () => {
    const runtime = createWorkspaceRuntime();
    expect(runtime.getActivePath()).toBeNull();
    expect(runtime.getActiveDriver()).toBeNull();
  });

  it('activate() builds a driver bound to the workspace', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');

    expect(runtime.getActivePath()).toBe('/tmp/ws-1');
    expect(runtime.getActiveDriver()).not.toBeNull();
    expect(createdDrivers).toHaveLength(1);
    expect(createdDrivers[0]?.workspacePath).toBe('/tmp/ws-1');
  });

  it('activate() tears down the previous driver before swapping', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');
    await runtime.activate('/tmp/ws-2');

    expect(createdDrivers).toHaveLength(2);
    expect(createdDrivers[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.getActivePath()).toBe('/tmp/ws-2');
  });

  it('deactivate() shuts down and clears active state', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');
    await runtime.deactivate();

    expect(runtime.getActivePath()).toBeNull();
    expect(runtime.getActiveDriver()).toBeNull();
    expect(createdDrivers[0]?.shutdown).toHaveBeenCalledTimes(1);
  });

  it('onChange() fires on activate and deactivate', async () => {
    const runtime = createWorkspaceRuntime();
    const seen: Array<string | null> = [];
    const off = runtime.onChange((path) => seen.push(path));

    await runtime.activate('/tmp/ws-1');
    await runtime.activate('/tmp/ws-2');
    await runtime.deactivate();
    off();

    expect(seen).toEqual(['/tmp/ws-1', '/tmp/ws-2', null]);
  });

  // Regression for "input clears, conversation never starts": without an
  // attachWindow call the BrowserWindow's webContents never reaches the
  // driver's EventRouter, so agent events have zero subscribers.
  it('attachWindow() binds the wc to the active driver so its events flow', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');

    const wc = { isDestroyed: () => false };
    runtime.attachWindow(wc as never);

    expect(createdDrivers[0]?.attached).toHaveLength(1);
  });

  it('attachWindow() rebinds the wc after a workspace switch rebuilds the driver', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');

    const wc = { isDestroyed: () => false };
    runtime.attachWindow(wc as never);
    expect(createdDrivers[0]?.attached).toHaveLength(1);

    await runtime.activate('/tmp/ws-2');
    // Old driver should have detached; new driver should have re-attached.
    expect(createdDrivers[0]?.detachedIds).toHaveLength(1);
    expect(createdDrivers[1]?.attached).toHaveLength(1);
  });

  it('attachWindow() on a destroyed wc is a noop (no driver.attach call)', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');

    runtime.attachWindow({ isDestroyed: () => true } as never);
    expect(createdDrivers[0]?.attached).toHaveLength(0);
  });
});
