import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHotMemoryExtractor,
  type HotMemoryExtractor,
  MEMORY_EXTRACTION_DEBOUNCE_MS,
} from '../../src/main/memory/hot-memory-extractor';
import { MemoryStore } from '../../src/main/memory/memory-store';
import type { ModelInvoke } from '../../src/main/memory/review-generator';
import type { ExtractorDeps } from '../../src/main/memory/session-memory-extractor';
import type { Result } from '../../src/shared/result';
import { err, ok } from '../../src/shared/result';

/**
 * 热会话记忆提取器测试（C1/C3b/H3 回归, TDD）。
 *
 * 互斥:同一会话同一时刻至多一个在飞提取;防抖触发时在飞 → 记补跑,完成后
 * 补跑一次。退避:失败指数退避(15s → 30s → … 480s 封顶),成功清零。
 * dispose:清空 pending 计时器与失败计数;在飞提取自然完成,其补跑被阻断。
 *
 * 用真 MemoryStore + 临时 jsonl:runExtraction 先 readFileSync(sessionFile),
 * 文件不存在会 Err 早于 invoke,计数断言必挂——每个用例先建文件。
 */

const storeRegistry: Array<{ close(): void }> = [];

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function messageLine(id: string, role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: Date.now(),
    message: { role, content: text },
  });
}

function writeSession(file: string, lines: string[]): void {
  writeFileSync(file, lines.join('\n'), 'utf8');
}

describe('hot-memory-extractor（互斥/退避/dispose）', () => {
  let dir: string;
  let store: MemoryStore;
  let invoke: ReturnType<typeof vi.fn<ModelInvoke>>;
  let extractor: HotMemoryExtractor;
  let sessionFile: string;

  function deps(): ExtractorDeps {
    return {
      invoke,
      getStore: () => store,
      emitRecorded: () => {},
      workspace: 'C:\\work\\quant',
      minUserTurnsBetweenExtractions: 1,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-hot-'));
    store = expectOk(MemoryStore.open(path.join(dir, 'memory.db')));
    storeRegistry.push(store);
    invoke = vi.fn<ModelInvoke>();
    // 每个用例先建临时 jsonl(缺文件时 runExtraction Err 早于 invoke)。
    sessionFile = path.join(dir, 'sess.jsonl');
    writeSession(sessionFile, [
      messageLine('m1', 'user', '记住: 这是第一条'),
      messageLine('m2', 'assistant', '已记录。'),
    ]);
    extractor = createHotMemoryExtractor('C:\\work\\quant', deps());
  });

  afterEach(() => {
    for (const s of storeRegistry.splice(0)) s.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('互斥: 防抖窗口内多次 trigger 只提取一次; 在飞期间触发 → 完成后补跑', async () => {
    let release: (value: Result<string>) => void = () => {};
    invoke.mockReturnValueOnce(
      new Promise<Result<string>>((resolve) => {
        release = resolve;
      }),
    );
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));

    extractor.trigger(sessionFile);
    extractor.trigger(sessionFile); // 防抖重置(同一窗口)
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS);
    expect(invoke).toHaveBeenCalledTimes(1); // 只启动一个提取

    // 在飞期间会话继续活动: 追加新行 + 防抖触发 → 记补跑
    appendFileSync(sessionFile, `\n${messageLine('m3', 'user', '第三条消息')}`);
    extractor.trigger(sessionFile);
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS);
    expect(invoke).toHaveBeenCalledTimes(1); // 互斥生效(不启动第二个提取)

    release(ok(JSON.stringify({ candidates: [] })));
    await vi.advanceTimersByTimeAsync(0); // 冲刷 finally 的补跑微任务
    expect(invoke).toHaveBeenCalledTimes(2); // 完成后补跑第二次, 提取新行
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(3);
  });

  it('退避: 失败后下一次延迟加倍(15s → 30s → 60s), 成功清零', async () => {
    invoke.mockResolvedValue(err({ code: 'model-unavailable', message: '模型不可用' }));

    extractor.trigger(sessionFile);
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS);
    expect(invoke).toHaveBeenCalledTimes(1); // 第一次:15s 触发, 失败

    extractor.trigger(sessionFile);
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS);
    expect(invoke).toHaveBeenCalledTimes(1); // 30s 前不触发(退避 2^1)

    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS);
    expect(invoke).toHaveBeenCalledTimes(2); // 30s 触发第二次(再失败, failCount=2)

    // 成功清零: 失败计数清空后回到 15s
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));
    extractor.trigger(sessionFile);
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS * 2);
    expect(invoke).toHaveBeenCalledTimes(2); // 60s(2^2)前不触发

    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS * 2);
    expect(invoke).toHaveBeenCalledTimes(3); // 60s 触发, 成功 → 清零

    await vi.advanceTimersByTimeAsync(0); // 等第三次 run 完成(成功清零生效)
    appendFileSync(sessionFile, `\n${messageLine('m3', 'user', '新活动')}`); // 给第 4 次提取留内容
    extractor.trigger(sessionFile);
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS);
    expect(invoke).toHaveBeenCalledTimes(4); // 清零后回到 15s
  });

  it('dispose: 清空 pending 计时器; 在飞提取完成后的补跑被阻断', async () => {
    // 1) 防抖窗口内 dispose → 计时器不触发
    extractor.trigger(sessionFile);
    extractor.dispose();
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS * 4);
    expect(invoke).not.toHaveBeenCalled();

    // 2) 在飞 + 补跑排队后 dispose → 补跑被阻断(不启动新提取)
    let release: (value: Result<string>) => void = () => {};
    invoke.mockReturnValueOnce(
      new Promise<Result<string>>((resolve) => {
        release = resolve;
      }),
    );
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));

    extractor.trigger(sessionFile);
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS);
    expect(invoke).toHaveBeenCalledTimes(1); // 在飞

    // 在飞期间有补跑需求(新行 + 防抖触发入队), 但 dispose 清空 rerunQueued
    appendFileSync(sessionFile, `\n${messageLine('m3', 'user', '补跑候选行')}`);
    extractor.trigger(sessionFile);
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS); // 触发 → rerunQueued
    extractor.dispose(); // 清空 rerunQueued(与在飞 finally 竞争, 谁先谁后都成立)

    release(ok(JSON.stringify({ candidates: [] })));
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACTION_DEBOUNCE_MS * 2);
    expect(invoke).toHaveBeenCalledTimes(1); // 补跑被 dispose 阻断(不启动新提取)
  });
});
