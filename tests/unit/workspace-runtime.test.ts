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

// D4 池化:extractor 随工作区条目存活,disposeAll 时才统一清。mock 以便验证 dispose。
const disposedExtractors: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
vi.mock('../../src/main/memory/hot-memory-extractor', () => ({
  createHotMemoryExtractor: vi.fn(() => {
    const record = { dispose: vi.fn() };
    disposedExtractors.push(record);
    return record;
  }),
}));

import { createWorkspaceRuntime } from '../../src/main/workspace/runtime';

afterEach(() => {
  createdDrivers.length = 0;
  disposedExtractors.length = 0;
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

  // D4:切工作区不销毁旧 driver,池内后台会话继续运行。
  it('activate() keeps the previous driver alive in the pool when switching', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');
    await runtime.activate('/tmp/ws-2');

    expect(createdDrivers).toHaveLength(2);
    expect(createdDrivers[0]?.shutdown).not.toHaveBeenCalled();
    expect(runtime.getActivePath()).toBe('/tmp/ws-2');
  });

  // D4:再次 activate 同一工作区 → 复用池内 driver,不二次新建。
  it('activate() reuses the pooled driver when re-activating a workspace', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');
    const firstDriver = runtime.getActiveDriver(); // 首次激活的 ws-1 driver
    await runtime.activate('/tmp/ws-2');
    await runtime.activate('/tmp/ws-1');

    expect(createdDrivers).toHaveLength(2); // 未重建第三个 driver
    expect(runtime.getActivePath()).toBe('/tmp/ws-1');
    // 复用即同一实例:切走再切回不重建 driver。
    expect(runtime.getActiveDriver()).toBe(firstDriver);
  });

  // D4:deactivate 仅清 active 指针,不销毁池内 driver。
  it('deactivate() clears active state without shutting down the pooled driver', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');
    await runtime.deactivate();

    expect(runtime.getActivePath()).toBeNull();
    expect(runtime.getActiveDriver()).toBeNull();
    expect(createdDrivers[0]?.shutdown).not.toHaveBeenCalled();
  });

  // D4:disposeAll 统一收尾——池内全 driver shutdown + extractor dispose。
  it('disposeAll() shuts down every pooled driver and disposes extractors', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');
    await runtime.activate('/tmp/ws-2');
    await runtime.disposeAll();

    expect(createdDrivers).toHaveLength(2);
    for (const record of createdDrivers) {
      expect(record.shutdown).toHaveBeenCalledTimes(1);
    }
    expect(disposedExtractors).toHaveLength(2);
    for (const record of disposedExtractors) {
      expect(record.dispose).toHaveBeenCalledTimes(1);
    }
    expect(runtime.getActivePath()).toBeNull();
    expect(runtime.getActiveDriver()).toBeNull();
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

  it('attachWindow() rebinds the wc after a workspace switch', async () => {
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

  // D4:切回原工作区 → wc 重新绑定回池内原 driver(后台会话事件恢复推送)。
  it('attachWindow() rebinds the wc back to the original driver when switching back', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');

    const wc = { isDestroyed: () => false };
    runtime.attachWindow(wc as never);

    await runtime.activate('/tmp/ws-2');
    await runtime.activate('/tmp/ws-1');

    expect(createdDrivers[0]?.attached).toHaveLength(1);
    expect(createdDrivers[1]?.attached).toHaveLength(0);
  });

  it('attachWindow() on a destroyed wc is a noop (no driver.attach call)', async () => {
    const runtime = createWorkspaceRuntime();
    await runtime.activate('/tmp/ws-1');

    runtime.attachWindow({ isDestroyed: () => true } as never);
    expect(createdDrivers[0]?.attached).toHaveLength(0);
  });
});
