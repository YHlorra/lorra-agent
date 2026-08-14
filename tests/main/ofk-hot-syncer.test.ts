import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfkHotSyncer, OFK_HOT_DEBOUNCE_MS } from '../../src/main/ofk/ofk-hot-syncer';
import { err, ok } from '../../src/shared/result';

/**
 * OFK 热同步(step 6):≥2s 防抖 + 失败 fail-open + fire-and-forget。
 * 用 fake timers 钉死防抖窗口与调用次数;用 mock syncSessionFile 钉死
 * 失败只 console.error、不 throw(热路径不炸)。
 */

vi.mock('../../src/main/ofk/session-writer', () => ({
  syncSessionFile: vi.fn(),
}));

import { syncSessionFile } from '../../src/main/ofk/session-writer';

const mockSync = vi.mocked(syncSessionFile);

describe('ofk-hot-syncer', () => {
  afterEach(() => {
    vi.useRealTimers();
    mockSync.mockReset();
  });

  it('2s 防抖:同文件快速连触发只同步一次(最后一次生效)', () => {
    vi.useFakeTimers();
    mockSync.mockResolvedValue(ok(undefined as never));
    const syncer = createOfkHotSyncer();

    syncer.sync('/sessions/a.jsonl', 'W1');
    vi.advanceTimersByTime(500);
    syncer.sync('/sessions/a.jsonl', 'W1'); // 重置计时
    vi.advanceTimersByTime(500);
    expect(mockSync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OFK_HOT_DEBOUNCE_MS);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith('/sessions/a.jsonl', 'W1');
  });

  it('不同文件独立计时,各自触发一次', () => {
    vi.useFakeTimers();
    mockSync.mockResolvedValue(ok(undefined as never));
    const syncer = createOfkHotSyncer();

    syncer.sync('/sessions/a.jsonl', 'W1');
    vi.advanceTimersByTime(OFK_HOT_DEBOUNCE_MS + 100);
    syncer.sync('/sessions/b.jsonl', 'W2');
    vi.advanceTimersByTime(OFK_HOT_DEBOUNCE_MS + 100);
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSync.mock.calls.map((c) => c[0])).toEqual([
      '/sessions/a.jsonl',
      '/sessions/b.jsonl',
    ]);
  });

  it('失败 fail-open:Err 只 console.error,不 throw,后续同步不受影响', async () => {
    vi.useFakeTimers();
    mockSync.mockResolvedValueOnce(err({ code: 'session-file-unreadable', message: 'gone' }));
    mockSync.mockResolvedValueOnce(ok(undefined as never));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncer = createOfkHotSyncer();

    syncer.sync('/sessions/a.jsonl', 'W1');
    await vi.advanceTimersByTimeAsync(OFK_HOT_DEBOUNCE_MS);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ofk-hot] sync failed:'),
      expect.any(Object),
    );
    // 第二次同步正常触发
    syncer.sync('/sessions/a.jsonl', 'W1');
    await vi.advanceTimersByTimeAsync(OFK_HOT_DEBOUNCE_MS);
    expect(mockSync).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
