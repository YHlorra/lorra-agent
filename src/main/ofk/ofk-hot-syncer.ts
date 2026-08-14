import { syncSessionFile } from './session-writer';

/**
 * OFK 热路径增量(step 6):会话活动事件旁路,仿 hot-updater 防抖纪律。
 * 对同一会话文件做 ≥2s 防抖重清洗 → 写 OFK 概念(内容相同 diff-skip)。
 * fire-and-forget + fail-open:失败只 console.error,不进入会话交互热路径,
 * 不阻断事件链。
 */

export const OFK_HOT_DEBOUNCE_MS = 2_000;

export function createOfkHotSyncer(): {
  sync(sessionFile: string, workspaceFallback: string): void;
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    sync(sessionFile, workspaceFallback) {
      const existing = timers.get(sessionFile);
      if (existing) clearTimeout(existing);
      timers.set(
        sessionFile,
        setTimeout(() => {
          timers.delete(sessionFile);
          void (async () => {
            try {
              const result = await syncSessionFile(sessionFile, workspaceFallback);
              if (result.isErr()) {
                console.error('[ofk-hot] sync failed:', result.error);
              }
            } catch (cause) {
              console.error('[ofk-hot] sync failed:', cause);
            }
          })();
        }, OFK_HOT_DEBOUNCE_MS),
      );
    },
  };
}
