import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEMORY_MAINTENANCE_SEED,
  MEMORY_MAINTENANCE_SKILL_FILENAME,
  MEMORY_MAINTENANCE_SKILL_NAME,
  MEMORY_MAINTENANCE_SKILL_RELATIVE,
  seedMemoryMaintenanceSkill,
} from '../../src/main/memory/memory-maintenance-seed';
import type { Result } from '../../src/shared/result';

// Requirement（/ design D4）: 记忆维护纪律技能文件,
// 应用启动/工作区激活时播种到 <workspace>/.lorra/skills/memory-maintenance.md
// —— 缺失才写内置原文;存在原样用（用户可改即时生效）;幂等。
// 内容必含五节: 何时写 / 何时 update（就地不新增）/ 何时 retire /
// 引用带 evidence 标注 / lint 自查指引（矛盾、陈旧、孤儿页、被提到缺页的概念）。

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lorra-mem-seed-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TARGET = () => path.join(dir, MEMORY_MAINTENANCE_SKILL_RELATIVE);

describe('memory-maintenance 技能播种', () => {
  it('缺失时写入内置原文, 返回读到的原文', () => {
    const result = expectOk(seedMemoryMaintenanceSkill(dir));

    expect(existsSync(TARGET())).toBe(true);
    expect(readFileSync(TARGET(), 'utf8')).toBe(MEMORY_MAINTENANCE_SEED);
    expect(result).toBe(MEMORY_MAINTENANCE_SEED);
  });

  it('目标路径 = <workspace>/.lorra/skills/memory-maintenance.md', () => {
    expectOk(seedMemoryMaintenanceSkill(dir));
    expect(TARGET()).toBe(path.join(dir, '.lorra', 'skills', MEMORY_MAINTENANCE_SKILL_FILENAME));
    expect(MEMORY_MAINTENANCE_SKILL_NAME).toBe('memory-maintenance');
  });

  it('存在时不覆盖: 用户自定义内容原样保留', () => {
    const custom = '# 我的记忆纪律\n用户自定内容';
    mkdirSync(path.dirname(TARGET()), { recursive: true });
    writeFileSync(TARGET(), custom, 'utf8');

    const result = expectOk(seedMemoryMaintenanceSkill(dir));

    expect(readFileSync(TARGET(), 'utf8')).toBe(custom);
    expect(result).toBe(custom);
  });

  it('幂等: 重复播种不覆写（内容始终为内置原文, 仅一次写入）', () => {
    const first = expectOk(seedMemoryMaintenanceSkill(dir));
    const second = expectOk(seedMemoryMaintenanceSkill(dir));
    const third = expectOk(seedMemoryMaintenanceSkill(dir));

    expect(first).toBe(MEMORY_MAINTENANCE_SEED);
    expect(second).toBe(MEMORY_MAINTENANCE_SEED);
    expect(third).toBe(MEMORY_MAINTENANCE_SEED);
    expect(readFileSync(TARGET(), 'utf8')).toBe(MEMORY_MAINTENANCE_SEED);
  });

  it('内容含八节（何时写 / update / retire / 引用 evidence / 好答案回填 / 知识摄入 / lint 自查 + audit 工具）', () => {
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
    // :知识摄入节 + 红线新措辞(知识库写入只能经 knowledge 工具)
    expect(MEMORY_MAINTENANCE_SEED).toContain('knowledge');
    expect(MEMORY_MAINTENANCE_SEED).toContain('路径白名单: references|projects|memory 下');
    expect(MEMORY_MAINTENANCE_SEED).toContain('仍禁止在工作区/用户目录自行创建文件体系');
    expect(MEMORY_MAINTENANCE_SEED).toContain('ofkRef');
    // lint 指引覆盖四类自查项(audit 工具落地后,自查项与 audit 发现对齐)
    for (const keyword of ['memory audit', '重复主题', '陈旧', '孤儿页', '被提到缺页的概念']) {
      expect(MEMORY_MAINTENANCE_SEED).toContain(keyword);
    }
    // query→page 指引要点
    for (const keyword of ['好答案', '回填', 'propose 补记']) {
      expect(MEMORY_MAINTENANCE_SEED).toContain(keyword);
    }
    // evidence 四态标注
    for (const label of ['你明说的', '观察', 'agent 推断', '未验证']) {
      expect(MEMORY_MAINTENANCE_SEED).toContain(label);
    }
  });

  it('播种失败（workspacePath 指向文件, 无法建目录）→ Err code memory-skill-seed-failed', () => {
    const filePath = path.join(dir, 'not-a-dir');
    writeFileSync(filePath, 'occupied', 'utf8');

    const result = seedMemoryMaintenanceSkill(filePath);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('memory-skill-seed-failed');
    }
  });
});
