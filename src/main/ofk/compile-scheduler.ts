import type { Result } from '../../shared/result';

/**
 * 后台编译调度(plan S6/D5):今日页查询 stale 判定后异步编译,页面不等待。
 *
 * 状态机(按 dateISO 独立):
 * schedule:重置防抖 timer;编译中 schedule → 置 rerun=true 并更新 notify
 * (编译完成后补跑一次)。
 * fire: compileDay(dateISO) → 编译中;rerun → 立即补跑;否则
 * result.isOk → notify?.;无论结果清理该 date 条目。
 * fire 整体 try/catch:抛错 → console.error + 清理,不 notify(fail-open)。
 *
 * 关键纪律:不在热同步/冷同步路径调度编译——热同步每 2s 推高概念
 * generatedAt,若调度编译会形成「活动期间无限 LLM 编译循环」,且编译与活跃
 * 会话抢模型。编译只从今日页入口与既有 review-assembler 入口触发。
 */
export const COMPILE_DEBOUNCE_MS = 5_000;

export interface CompileScheduler {
  /** 按 dateISO 防抖;notify 最新一次覆盖;编译成功才回调。 */
  schedule(dateISO: string, notify?: () => void): void;
  /** 清全部 timer(应用退出/窗口关闭时调用)。 */
  dispose(): void;
}

interface PendingEntry {
  timer: ReturnType<typeof setTimeout> | null;
  compiling: boolean;
  rerun: boolean;
  notify?: () => void;
}

export function createCompileScheduler(deps: {
  compileDay: (dateISO: string) => Promise<Result<void>>;
  /** 防抖毫秒;缺省 COMPILE_DEBOUNCE_MS(测试注入小值)。 */
  debounceMs?: number;
}): CompileScheduler {
  const { compileDay, debounceMs = COMPILE_DEBOUNCE_MS } = deps;
  const pending = new Map<string, PendingEntry>();

  function schedule(dateISO: string, notify?: () => void): void {
    const entry = pending.get(dateISO) ?? { timer: null, compiling: false, rerun: false };
    entry.notify = notify; // 最新一次覆盖
    if (entry.compiling) {
      entry.rerun = true; // 编译完成后补跑
      pending.set(dateISO, entry);
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void fire(dateISO), debounceMs);
    pending.set(dateISO, entry);
  }

  async function fire(dateISO: string): Promise<void> {
    const entry = pending.get(dateISO);
    if (!entry) return;
    entry.timer = null;
    while (entry) {
      entry.compiling = true;
      entry.rerun = false;
      let result: Result<void>;
      try {
        result = await compileDay(dateISO);
      } catch (cause) {
        console.error('[compile-scheduler] compile threw:', cause);
        break; // fail-open:不 notify,清理条目
      }
      entry.compiling = false;
      if (entry.rerun) {
        // 编译期间又有 schedule → 立即补跑(不重置防抖)
        continue;
      }
      if (result.isOk()) entry.notify?.();
      break;
    }
    // 清理该 date 条目;期间又被 schedule(新 timer)→ 保留等新 timer 触发
    const latest = pending.get(dateISO);
    if (latest && latest.timer === null && !latest.compiling) {
      pending.delete(dateISO);
    }
  }

  return {
    schedule,
    dispose() {
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      pending.clear();
    },
  };
}
