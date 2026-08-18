import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEMORY_MAINTENANCE_SEED,
  seedMemoryMaintenanceSkill,
} from '../../src/main/memory/memory-maintenance-seed';
import { describeSeedSkillBehavior } from './seed-skill';

// 通用行为矩阵(loadOrSeedSkill 共享契约,2026-08-17 收敛):
describeSeedSkillBehavior('memory-maintenance', {
  name: 'memory-maintenance',
  seed: MEMORY_MAINTENANCE_SEED,
});

// 包装层漂移保护: seedMemoryMaintenanceSkill 应直接转发到 loadOrSeedSkill,
// 不可中途改 code、改路径、改写入内容。此处独立建临时工作区断言 happy-path
// 与失败 code,确保 wrapper 没有悄悄加料。
describe('seedMemoryMaintenanceSkill 包装层', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-mem-wrap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('happy-path: 写入并返回 MEMORY_MAINTENANCE_SEED', () => {
    const r = seedMemoryMaintenanceSkill(dir);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe(MEMORY_MAINTENANCE_SEED);
  });

  it('失败时仍返回 seed-skill-failed', () => {
    const filePath = path.join(dir, 'not-a-dir');
    writeFileSync(filePath, 'occupied', 'utf8');
    const r = seedMemoryMaintenanceSkill(filePath);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('seed-skill-failed');
  });
});

// 内容契约:记忆维护纪律种子(/ design D4)自身的字段保证;
// 与 loadOrSeedSkill 行为无关,即便更换加载函数也要守住。
describe('MEMORY_MAINTENANCE_SEED 内容契约', () => {
  it('内容含关键维护节, 并覆盖 knowledge / OKF / case-skill 纪律', () => {
    const sections = [
      '## 何时写（propose）',
      '## 何时 update（就地更新，不新增）',
      '## 何时 retire',
      '## 引用时带 evidence 标注',
      '## 好答案回填成知识页（query→page, ）',
      '## 知识摄入（knowledge 工具）',
      '## lint 自查指引',
    ];
    for (const heading of sections) {
      expect(MEMORY_MAINTENANCE_SEED, `缺节: ${heading}`).toContain(heading);
    }
    expect(MEMORY_MAINTENANCE_SEED).toContain('knowledge');
    expect(MEMORY_MAINTENANCE_SEED).toContain('路径白名单: references|projects|memory 下');
    expect(MEMORY_MAINTENANCE_SEED).toContain('仍禁止在工作区/用户目录自行创建文件体系');
    expect(MEMORY_MAINTENANCE_SEED).toContain('ofkRef');
    for (const keyword of ['memory audit', '重复主题', '陈旧', '孤儿页', '被提到缺页的概念']) {
      expect(MEMORY_MAINTENANCE_SEED).toContain(keyword);
    }
    for (const keyword of ['好答案', '回填', 'propose 补记']) {
      expect(MEMORY_MAINTENANCE_SEED).toContain(keyword);
    }
    for (const label of ['你明说的', '观察', 'agent 推断', '未验证']) {
      expect(MEMORY_MAINTENANCE_SEED).toContain(label);
    }
    for (const keyword of [
      'OKF 最小纪律',
      '`type`',
      '`sources`',
      '`generated`',
      '`verified`',
      'freshness',
      'lifecycle',
      'generated skill',
      'procedural_experience',
      '来源 case / entry id',
    ]) {
      expect(MEMORY_MAINTENANCE_SEED).toContain(keyword);
    }
  });
});
