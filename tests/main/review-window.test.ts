import { rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  assembleReviewPayload,
  type ReviewPayload,
  weeklyWindow,
} from '../../src/main/memory/review-assembler';
import type { Result } from '../../src/shared/result';
import { freshUserData, seedConcept, seedDigest } from './ofk-test-fixtures';

// workspace → slug(pi-sdk 编码):C:\work\demo → C--work-demo
const SLUG_A = 'C--work-demo';

// 复审 #N1:周窗口时区偏移 —— review-ipc 用 new Date(weeklyWindowStart(dateISO))/
// new Date(dateISO) 解析 ISO 字符串（UTC 零点语义），负 UTC 偏移时区周复盘缺当天。
// 裁定修复方向:窗口计算改本地构造 new Date(y, m-1, d-6)..new Date(y, m-1, d)，
// 并抽成可测函数 weeklyWindow(dateISO): { startISO, days }（本地日键数组,恰 7 天,
// 末位=dateISO 当天）。review-ipc 取数必须消费同一窗口函数（单源一致）。

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 本地日键 +delta 天（本地构造,与修复方向同款）。 */
function addDays(dateISO: string, delta: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  return localDayKey(new Date(y, m - 1, d + delta));
}

function expectOk(result: Result<ReviewPayload>): ReviewPayload {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

describe('weeklyWindow', () => {
  it('days 恰 7 天, 末位=dateISO, startISO=dateISO-6', () => {
    const w = weeklyWindow('2026-08-08');
    expect(w.days).toHaveLength(7);
    expect(w.days[6]).toBe('2026-08-08');
    expect(w.startISO).toBe('2026-08-02');
    expect(w.days[0]).toBe(w.startISO);
  });

  it('days 为连续本地日键（逐日 +1）', () => {
    const w = weeklyWindow('2026-08-08');
    for (let i = 0; i < w.days.length - 1; i++) {
      expect(w.days[i + 1]).toBe(addDays(w.days[i], 1));
    }
  });

  it('跨月窗口: 2026-03-03 -> startISO 2026-02-25（Feb 28 天）', () => {
    const w = weeklyWindow('2026-03-03');
    expect(w.startISO).toBe('2026-02-25');
    expect(w.days[0]).toBe('2026-02-25');
    expect(w.days[6]).toBe('2026-03-03');
    expect(w.days).toHaveLength(7);
  });

  it('跨年窗口: 2026-01-03 -> startISO 2025-12-28', () => {
    const w = weeklyWindow('2026-01-03');
    expect(w.startISO).toBe('2025-12-28');
    expect(w.days[0]).toBe('2025-12-28');
    expect(w.days[6]).toBe('2026-01-03');
  });

  it('负 UTC 偏移时区不丢当天: 强制 TZ=Etc/GMT+5 下 days 末位仍为 dateISO', () => {
    // 复现 review-ipc 缺陷场景:new Date('YYYY-MM-DD') 按 UTC 零点解析,
    // 在 UTC-5 下 localDateString 落到前一天;本地构造则不受影响。
    const prev = process.env.TZ;
    process.env.TZ = 'Etc/GMT+5';
    try {
      const w = weeklyWindow('2026-08-08');
      expect(w.days[6]).toBe('2026-08-08');
      expect(w.days[0]).toBe('2026-08-02');
      expect(w.days).toHaveLength(7);
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it('同源: assembler 周过滤与 weeklyWindow 一致（review-ipc 取数须消费同一窗口函数）', async () => {
    const dateISO = '2026-08-08';
    const w = weeklyWindow(dateISO);
    const userdata = freshUserData();
    try {
      for (const day of w.days) {
        await seedConcept({
          day,
          workspace: 'C:\\work\\demo',
          sessionRef: `day-${day}`,
          title: `会话 ${day}`,
          activeMs: 60_000,
        });
        // 预置新鲜日摘要 → ensureDayCompiled 不触发真实模型调用(与
        // review-assembler.test.ts 同款纪律;本测试只关心窗口过滤,不关心编译)。
        await seedDigest(SLUG_A, day, `${day} 摘要`);
      }
      // 窗口前/后各一天的概念必须被排除。
      await seedConcept({
        day: '2026-08-01',
        workspace: 'C:\\work\\demo',
        sessionRef: 'before-window',
        title: 'before',
      });
      await seedConcept({
        day: '2026-08-09',
        workspace: 'C:\\work\\demo',
        sessionRef: 'after-window',
        title: 'after',
      });

      const payload = expectOk(await assembleReviewPayload('weekly', dateISO));
      expect(payload.globalStats.totalConversations).toBe(7);
      // 每日分布键与窗口 days 完全一致 —— 单源:ipc 的周窗口取数应直接消费 weeklyWindow。
      expect(Object.keys(payload.globalStats.timeAllocation).sort()).toEqual([...w.days].sort());
    } finally {
      vi.unstubAllEnvs();
      rmSync(userdata, { recursive: true, force: true });
    }
  });
});
