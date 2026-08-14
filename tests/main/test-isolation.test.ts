/**
 * 测试隔离守卫(根因修复的可执行契约)。
 *
 * 事故:内联诊断测试未隔离 os.homedir,把真实 ~/.claude/skills 下 25 个技能
 * rename 进测试临时目录并随收尾删除。根因修复 = tests/main/test-env-setup.ts
 * 在**测试文件加载前**强制 LORRA_E2E_USERDATA 指向一次性临时目录,使
 * lorraConfigDir/session-persistence/settings 全链路落盘到隔离目录。
 *
 * 本文件把「隔离成立」变成运行时可失败的断言:任何使该 env 丢失/指向真实
 * home 的改动,都会让这里变红。
 */
import { existsSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { lorraConfigDir } from '../../src/main/pi-sdk-driver/lorra-config-dir';

describe('测试隔离守卫(PROB-020)', () => {
  it('LORRA_E2E_USERDATA 在测试文件加载前已被强制指向临时目录', () => {
    const v = process.env.LORRA_E2E_USERDATA;
    expect(v).toBeDefined();
    expect(v).not.toBe('');
    // 一次性临时目录:位于系统 temp 下且确实已创建。
    expect(path.isAbsolute(v ?? '')).toBe(true);
    expect((v ?? '').toLowerCase().startsWith(tmpdir().toLowerCase())).toBe(true);
    expect(existsSync(v ?? '')).toBe(true);
  });

  it('lorraConfigDir 落隔离目录,与真实 home 分离', () => {
    const cfg = lorraConfigDir();
    const realHome = os.homedir();
    // 解析后仍落在隔离根下,且不指向真实 ~/.lorra。
    expect(cfg.toLowerCase().startsWith((process.env.LORRA_E2E_USERDATA ?? '').toLowerCase())).toBe(
      true,
    );
    expect(cfg.toLowerCase()).not.toBe(path.join(realHome, '.lorra').toLowerCase());
  });

  it('测试运行期间真实 home 不被触碰的哨兵:隔离根不落任何生产目录内', () => {
    // 契约:隔离根永不嵌套在 ~/.lorra / ~/.claude / ~/.agents 生产目录树下。
    const iso = (process.env.LORRA_E2E_USERDATA ?? '').toLowerCase();
    const home = os.homedir().toLowerCase();
    for (const d of ['.lorra', '.claude', '.agents']) {
      const prod = path.join(home, d).toLowerCase();
      expect(iso === prod || iso.startsWith(prod + path.sep)).toBe(false);
    }
  });
});
