import type { ExtractorDeps } from './session-memory-extractor';
import { runExtraction } from './session-memory-extractor';

/**
 * 热会话记忆提取:会话活动事件旁路。应用层在 pi-sdk-driver
 * 事件订阅处收到活动事件后调用 trigger;对同一会话文件做 ≥15s 防抖,防抖
 * 窗口结束后对增量段跑一次记忆提取(session-memory-extractor),写入第五
 * 通道 session-extraction。fire-and-forget + fail-open:提取/写入失败只
 * 记录(console.error),不进入会话交互热路径,不阻断事件链。
 *
 * 并发与生命周期(C1/C3b/H3):
 * - per-session 互斥:同一会话同一时刻至多一个在飞提取;防抖触发时若在飞,
 * 记 rerunQueued 并在完成后补跑一次——防「最后一条消息触发的提取被并发
 * 丢弃后永远不提取」。
 * - 失败退避:连续失败指数退避(15s → 480s 封顶),防模型超时/坏 JSON 时
 * 每次活动都重试同一大段;成功清零。
 * - dispose:工作区退出/切换时清空全部 pending 计时器与失败计数;在飞提取
 * 不中断、让其自然完成(写入与水位由 runExtraction 保证原子性),其 finally
 * 中的补跑检查因 rerunQueued 已清空而返回 false → 不启动新提取。
 *
 * 水位推进由 runExtraction 内部保证(全成才推;失败下次防抖窗口补提)。
 */

/** 会话活动 → 记忆提取的防抖窗口（唯一定义处；Step 5/6 共用此值）。 */
export const MEMORY_EXTRACTION_DEBOUNCE_MS = 15_000;

/** 失败退避封顶指数(延迟 = DEBOUNCE × 2^min(failCount, 5) → 480s)。 */
const MAX_FAIL_BACKOFF = 5;

export interface HotMemoryExtractor {
  /** 会话活动事件入口（防抖后触发提取）。 */
  trigger(sessionFile: string): void;
  /** 工作区退出/切换时调用：清空全部 pending 计时器与失败计数（在飞提取不中断）。 */
  dispose(): void;
}

export function createHotMemoryExtractor(
  workspace: string,
  deps: ExtractorDeps,
): HotMemoryExtractor {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Set<string>();
  const rerunQueued = new Set<string>();
  const failCounts = new Map<string, number>();

  async function run(sessionFile: string): Promise<void> {
    inflight.add(sessionFile);
    try {
      const result = await runExtraction(sessionFile, {
        ...deps,
        workspace,
      });
      if (result.isErr()) {
        failCounts.set(
          sessionFile,
          Math.min((failCounts.get(sessionFile) ?? 0) + 1, MAX_FAIL_BACKOFF),
        );
        console.error('[memory-extract] extraction failed:', result.error);
      } else {
        failCounts.delete(sessionFile);
      }
    } catch (cause) {
      failCounts.set(
        sessionFile,
        Math.min((failCounts.get(sessionFile) ?? 0) + 1, MAX_FAIL_BACKOFF),
      );
      console.error('[memory-extract] extraction failed:', cause);
    } finally {
      inflight.delete(sessionFile);
      // dispose 已清空 rerunQueued → delete 返回 false → 不补跑,杜绝
      // dispose 后启动新提取。
      if (rerunQueued.delete(sessionFile)) {
        void run(sessionFile);
      }
    }
  }

  return {
    trigger(sessionFile) {
      const existing = timers.get(sessionFile);
      if (existing) clearTimeout(existing);
      timers.set(
        sessionFile,
        setTimeout(
          () => {
            timers.delete(sessionFile);
            if (inflight.has(sessionFile)) {
              rerunQueued.add(sessionFile);
              return;
            }
            void run(sessionFile);
          },
          MEMORY_EXTRACTION_DEBOUNCE_MS *
            2 ** Math.min(failCounts.get(sessionFile) ?? 0, MAX_FAIL_BACKOFF),
        ),
      );
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      failCounts.clear();
      inflight.clear();
      rerunQueued.clear();
    },
  };
}
