import { IDLE_GAP_MS } from '../../shared/gap';

/**
 * 使用时长口径(agent-memory-today-timeline D6):
 * active_ms = 消息活跃窗口并集,相邻消息间隔不超过 IDLE_GAP_MS 计为同一
 * 活跃窗口,超过则计为中断。该口径是 timeline 块高度与复盘统计的唯一依据。
 *
 * IDLE_GAP_MS 定义在 src/shared/gap.ts(前端 lane 共用同一常量)。
 */
export { IDLE_GAP_MS };

/**
 * 计算活跃窗口并集。
 * - 空/单条时间戳 → 0
 * - 全部间隔 ≤ IDLE_GAP_MS → 首末时间差
 * - 存在长空闲 → 各窗口时长之和(空闲段不计入)
 */
export function computeActiveMs(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  let windowStart = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > IDLE_GAP_MS) {
      total += sorted[i - 1] - windowStart;
      windowStart = sorted[i];
    }
  }
  total += sorted[sorted.length - 1] - windowStart;
  return total;
}
