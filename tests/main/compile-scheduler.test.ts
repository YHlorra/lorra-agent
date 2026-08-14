import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  COMPILE_DEBOUNCE_MS,
  createCompileScheduler,
  type CompileScheduler,
} from '../../src/main/ofk/compile-scheduler';
import { err, ok, type Result } from '../../src/shared/result';

// Requirement(plan S6/D5):后台编译调度——按 dateISO 防抖合并;编译中 schedule
// → 完成后补跑;compileDay Err/throw → 不 notify(fail-open);ok → notify;
// dispose 清 timer。编译只在今日页/复盘入口触发,不在热同步/冷同步路径。

describe('compile-scheduler', () => {
  let compileDay: Mock<(dateISO: string) => Promise<Result<void>>>;
  let scheduler: CompileScheduler | null;

  beforeEach(() => {
    vi.useFakeTimers();
    compileDay = vi.fn<(dateISO: string) => Promise<Result<void>>>();
    scheduler = null;
  });

  afterEach(() => {
    scheduler?.dispose();
    vi.useRealTimers();
  });

  it('防抖合并:5s 内多次 schedule → 一次编译', async () => {
    compileDay.mockResolvedValue(ok());
    scheduler = createCompileScheduler({ compileDay });
    scheduler.schedule('2026-08-08', vi.fn());
    vi.advanceTimersByTime(3_000);
    scheduler.schedule('2026-08-08', vi.fn()); // 重置防抖
    vi.advanceTimersByTime(4_000);
    expect(compileDay).not.toHaveBeenCalled(); // 3s 处重置 → 8s 才触发
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compileDay).toHaveBeenCalledTimes(1);
    expect(compileDay).toHaveBeenCalledWith('2026-08-08');
  });

  it('不同 dateISO 各自独立防抖,各自 notify', async () => {
    compileDay.mockResolvedValue(ok());
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    scheduler = createCompileScheduler({ compileDay });
    scheduler.schedule('2026-08-08', notifyA);
    scheduler.schedule('2026-08-09', notifyB);
    vi.advanceTimersByTime(4_000);
    expect(compileDay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compileDay).toHaveBeenCalledTimes(2);
    expect(notifyA).toHaveBeenCalledTimes(1);
    expect(notifyB).toHaveBeenCalledTimes(1);
  });

  it('编译中 schedule → 完成后补跑一次,notify 只来自末次成功', async () => {
    const pending: Array<(r: Result<void>) => void> = [];
    compileDay.mockImplementation(
      () => new Promise<Result<void>>((resolve) => pending.push(resolve)),
    );
    const notify = vi.fn();
    scheduler = createCompileScheduler({ compileDay });
    scheduler.schedule('2026-08-08', notify);
    await vi.advanceTimersByTimeAsync(COMPILE_DEBOUNCE_MS); // 触发编译(挂起中)
    expect(compileDay).toHaveBeenCalledTimes(1);

    scheduler.schedule('2026-08-08', notify); // 编译中 → 置 rerun
    pending.shift()!(ok()); // 首次编译成功(应被 rerun 吞掉,不 notify)
    await vi.advanceTimersByTimeAsync(0);
    expect(compileDay).toHaveBeenCalledTimes(2); // 立即补跑
    expect(notify).not.toHaveBeenCalled(); // 首次成功不 notify

    pending.shift()!(ok()); // 补跑成功
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('compileDay Err → 不 notify,条目清理后可再调度', async () => {
    compileDay.mockResolvedValue(err({ code: 'model-error', message: 'boom' }));
    const notify = vi.fn();
    scheduler = createCompileScheduler({ compileDay });
    scheduler.schedule('2026-08-08', notify);
    await vi.advanceTimersByTimeAsync(COMPILE_DEBOUNCE_MS);
    expect(compileDay).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();

    // 条目已清理:再调度仍可编译
    compileDay.mockResolvedValue(ok());
    scheduler.schedule('2026-08-08', notify);
    await vi.advanceTimersByTimeAsync(COMPILE_DEBOUNCE_MS);
    expect(compileDay).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('compileDay throw → console.error,不 notify,不悬空', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    compileDay.mockRejectedValue(new Error('compile crashed'));
    const notify = vi.fn();
    scheduler = createCompileScheduler({ compileDay });
    scheduler.schedule('2026-08-08', notify);
    await vi.advanceTimersByTimeAsync(COMPILE_DEBOUNCE_MS);
    expect(notify).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('dispose 清 timer:调度后立即 dispose → 永不编译', async () => {
    compileDay.mockResolvedValue(ok());
    scheduler = createCompileScheduler({ compileDay });
    scheduler.schedule('2026-08-08', vi.fn());
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(compileDay).not.toHaveBeenCalled();
  });

  it('notify 最新一次覆盖:编译中再 schedule 传新 notify → 末次 notify 被调', async () => {
    const pending: Array<(r: Result<void>) => void> = [];
    compileDay.mockImplementation(
      () => new Promise<Result<void>>((resolve) => pending.push(resolve)),
    );
    const notifyOld = vi.fn();
    const notifyNew = vi.fn();
    scheduler = createCompileScheduler({ compileDay });
    scheduler.schedule('2026-08-08', notifyOld);
    await vi.advanceTimersByTimeAsync(COMPILE_DEBOUNCE_MS);
    scheduler.schedule('2026-08-08', notifyNew); // 编译中,更新 notify
    pending.shift()!(ok());
    await vi.advanceTimersByTimeAsync(0);
    pending.shift()!(ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyOld).not.toHaveBeenCalled();
    expect(notifyNew).toHaveBeenCalledTimes(1);
  });
});
