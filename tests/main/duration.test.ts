import { describe, expect, it } from 'vitest';
import { computeActiveMs, IDLE_GAP_MS } from '../../src/main/memory/duration';

// Requirement: 使用时长口径 — active_ms 按消息活跃窗口并集计算；
// 相邻间隔 ≤5 分钟同一窗口，>5 分钟计中断。该口径是 timeline 块高与复盘统计的唯一依据。

describe('duration', () => {
  it('IDLE_GAP_MS is exactly 5 minutes', () => {
    expect(IDLE_GAP_MS).toBe(5 * 60 * 1000);
  });

  it('连续对话计为单一窗口: gaps within 5 minutes, activeMs = last - first', () => {
    const t0 = 1_700_000_000_000;
    const ts = [t0, t0 + 35_000, t0 + 65_000, t0 + 95_000];
    expect(computeActiveMs(ts)).toBe(95_000);
  });

  it('间隔恰好等于 5 分钟仍计为同一窗口（“不超过 5 分钟”含边界）', () => {
    const t0 = 1_700_000_000_000;
    const ts = [t0, t0 + IDLE_GAP_MS];
    expect(computeActiveMs(ts)).toBe(IDLE_GAP_MS);
  });

  it('长空闲中断: 30 分钟间隔不计入, activeMs = 两个窗口之和', () => {
    const t0 = 1_700_000_000_000;
    const gap = 30 * 60 * 1000;
    const ts = [t0, t0 + 60_000, t0 + 60_000 + gap, t0 + 60_000 + gap + 30_000];
    // 窗口1: 60s；窗口2: 30s；中间 30 分钟空闲不计。
    expect(computeActiveMs(ts)).toBe(90_000);
  });

  it('退化: 空数组 -> 0', () => {
    expect(computeActiveMs([])).toBe(0);
  });

  it('退化: 单条消息 -> 0（无时间跨度）', () => {
    expect(computeActiveMs([1_700_000_000_000])).toBe(0);
  });

  it('退化: 全部时间戳相同 -> 0', () => {
    expect(computeActiveMs([1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000])).toBe(0);
  });

  it('三个活跃窗口（两个长中断）之和', () => {
    const t0 = 1_700_000_000_000;
    const gap = 20 * 60 * 1000;
    const ts = [
      t0, // 窗口1 起点
      t0 + 10_000, // 窗口1 终点 (10s)
      t0 + 10_000 + gap, // 窗口2 起点
      t0 + 10_000 + gap + 5_000, // 窗口2 终点 (5s)
      t0 + 10_000 + gap + 5_000 + gap, // 窗口3 起点
      t0 + 10_000 + gap + 5_000 + gap + 20_000, // 窗口3 终点 (20s)
    ];
    expect(computeActiveMs(ts)).toBe(35_000);
  });
});
