import { describe, expect, it } from 'vitest';

import {
  SKILL_BUDGET_GOOD_TOKENS,
  SKILL_BUDGET_WARN_TOKENS,
  SKILL_DESC_CHARS_MAX,
  SKILL_FILE_BYTES_MAX,
  SKILL_STATS_JSONL_BYTES_MAX,
  SKILL_STATS_WINDOW_DAYS,
  SKILL_TOKEN_ESTIMATE_DIVISOR,
  SKILLS_IPC,
} from '../../src/shared/skills-api';

/**
 * skills-api 契约锁（V1-1）：通道名与预算常量是 UI/IPC/统计的共享事实源，
 * 任何一侧改动都会静默破坏对端 —— 常量即行为契约。
 */

describe('skills-api 通道常量', () => {
  it('IPC 通道名与 preload/主进程注册一致', () => {
    expect(SKILLS_IPC).toEqual({
      xray: 'lorra.skills.xray',
      setEnabled: 'lorra.skills.setEnabled',
      cleanDangling: 'lorra.skills.cleanDangling',
      collect: 'lorra.skills.collect',
      checkUpdates: 'lorra.skills.checkUpdates',
      updateAll: 'lorra.skills.updateAll',
      setWsEnabled: 'lorra.skills.setWsEnabled',
      read: 'lorra.skills.read',
    });
    // 只读契约对象（防止意外被改）。
    expect(Object.isFrozen(SKILLS_IPC)).toBe(true);
  });
});

describe('skills-api 预算/健康常量', () => {
  it('token 预算分级参考线（PM 拍板：良好 2000 = Claude Code skillListingBudgetFraction 1%×200k；超限 4000 取整）', () => {
    expect(SKILL_BUDGET_GOOD_TOKENS).toBe(2000);
    expect(SKILL_BUDGET_WARN_TOKENS).toBe(4000);
    // 分级不变量：good < warn。
    expect(SKILL_BUDGET_GOOD_TOKENS).toBeLessThan(SKILL_BUDGET_WARN_TOKENS);
  });

  it('估算系数与 SDK 对齐常量', () => {
    expect(SKILL_TOKEN_ESTIMATE_DIVISOR).toBe(3.5); // 中英混合口径 3.5 字符/token
    expect(SKILL_DESC_CHARS_MAX).toBe(1024); // pi SDK MAX_DESCRIPTION_LENGTH
    expect(SKILL_FILE_BYTES_MAX).toBe(1024 * 1024); // >1MB 跳过加载
    expect(SKILL_STATS_JSONL_BYTES_MAX).toBe(64 * 1024 * 1024); // jsonl >64MB 跳过
    expect(SKILL_STATS_WINDOW_DAYS).toBe(45); // 45 天触发窗口
  });
});
