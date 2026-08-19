import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lorraConfigDir } from '../../src/main/pi-sdk-driver/lorra-config-dir';
import {
  BUILTIN_SKILL_NAMES,
  getBuiltinSkillSeed,
  seedBuiltinSkills,
} from '../../src/main/skills/builtin-skill-seeder';

/**
 * 内置技能目录注册表（2026-08-18 批）行为契约：
 * - glob 动态枚举:BUILTIN_SKILL_NAMES 与 builtin-skill-seeds/*.md 一一对应(新增 .md 自动入列)。
 * - getBuiltinSkillSeed:严格 name 匹配;未注册 → undefined。
 * - seedBuiltinSkills:落地 <lorraConfigDir>/skills/<name>.md,write-if-missing(用户编辑不覆写)、
 * 幂等、单文件失败静默不抛(console.warn)。
 * - ?raw 保真:seed 内容与磁盘 .md 字节一致(CRLF 原样,不得被 Vite 归一化)。
 * LORRA_E2E_USERDATA 由 tests/main/test-env-setup.ts 强制为一次性临时目录 →
 * lorraConfigDir 落在隔离路径,不触碰真实 ~/.lorra。
 */

/** 本测试文件共享同一 LORRA_E2E_USERDATA,清空全局技能目录防用例间泄漏。 */
function resetGlobalSkills(): void {
  rmSync(path.join(lorraConfigDir(), 'skills'), { recursive: true, force: true });
}

const SEEDS = path.resolve('src/main/skills/builtin-skill-seeds');

function seedFile(name: string): string {
  return path.join(SEEDS, `${name}.md`);
}

describe('BUILTIN_SKILL_NAMES / getBuiltinSkillSeed（注册表）', () => {
  it('名单 = seeds 目录全部 .md（daily-review / deep-review / lorra-meta-skill）', () => {
    expect([...BUILTIN_SKILL_NAMES].sort()).toEqual([
      'daily-review',
      'deep-review',
      'lorra-meta-skill',
    ]);
  });

  it('getBuiltinSkillSeed: 已注册名返回内容, 且与磁盘 .md 字节一致（?raw 保真 CRLF）', () => {
    for (const name of BUILTIN_SKILL_NAMES) {
      const seed = getBuiltinSkillSeed(name);
      expect(seed, `缺种子: ${name}`).toBeDefined();
      expect(seed).toBe(readFileSync(seedFile(name), 'utf8'));
    }
  });

  it('getBuiltinSkillSeed: 未注册名 → undefined', () => {
    expect(getBuiltinSkillSeed('no-such-skill')).toBeUndefined();
    expect(getBuiltinSkillSeed('')).toBeUndefined();
  });
});

describe('seedBuiltinSkills（写全局路径, write-if-missing）', () => {
  beforeEach(resetGlobalSkills);
  afterEach(resetGlobalSkills);

  const TARGET = (name: string) => path.join(lorraConfigDir(), 'skills', `${name}.md`);

  it('首次播种: 三个内置技能全部落盘, 内容 = 内置原文', () => {
    seedBuiltinSkills();
    for (const name of BUILTIN_SKILL_NAMES) {
      expect(existsSync(TARGET(name)), `缺文件: ${TARGET(name)}`).toBe(true);
      expect(readFileSync(TARGET(name), 'utf8')).toBe(getBuiltinSkillSeed(name));
    }
  });

  it('已存在不覆盖: 用户自定义内容原样保留', () => {
    mkdirSync(path.join(lorraConfigDir(), 'skills'), { recursive: true });
    const custom = '# 自定义 daily-review\n用户内容';
    writeFileSync(TARGET('daily-review'), custom, 'utf8');

    seedBuiltinSkills();

    expect(readFileSync(TARGET('daily-review'), 'utf8')).toBe(custom);
    // 其余两个缺失的仍被补种。
    for (const name of ['deep-review', 'lorra-meta-skill']) {
      expect(existsSync(TARGET(name))).toBe(true);
    }
  });

  it('幂等: 重复播种不覆写、不报错', () => {
    seedBuiltinSkills();
    seedBuiltinSkills();
    seedBuiltinSkills();
    for (const name of BUILTIN_SKILL_NAMES) {
      expect(readFileSync(TARGET(name), 'utf8')).toBe(getBuiltinSkillSeed(name));
    }
  });

  it('失败静默收敛: skills 路径被文件占用 → 不抛, 不落任何文件', () => {
    // <lorraConfigDir>/skills 以普通文件形式存在 → mkdirSync(recursive) 失败。
    mkdirSync(lorraConfigDir(), { recursive: true });
    writeFileSync(path.join(lorraConfigDir(), 'skills'), 'occupied', 'utf8');

    expect(() => seedBuiltinSkills()).not.toThrow();
    for (const name of BUILTIN_SKILL_NAMES) {
      expect(existsSync(TARGET(name))).toBe(false);
    }
  });
});

// 内容契约: lorra 元技能自身的字段保证(frontmatter、四段、品牌卫生、真源自描述)。
// 由旧 tests/main/skill-meta-seed.test.ts 迁移而来(2026-08-18 内置技能批)。
describe('lorra-meta-skill 种子内容契约', () => {
  const SEED = getBuiltinSkillSeed('lorra-meta-skill') ?? '';

  it('frontmatter 合法: name = lorra-meta-skill, description 非空且 ≤1024', () => {
    expect(SEED.startsWith('---\nname: lorra-meta-skill\n')).toBe(true);
    const desc = SEED.match(/^description: (.*)$/m)?.[1] ?? '';
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(1024);
  });

  it('内容含四段: 生成 / 品牌 yaml / 发布(gh CLI) / 自我进化', () => {
    const sections = [
      '## 一、生成一个新技能（create）',
      '## 二、品牌 yaml（schema，位于本技能自身文件夹，全局唯一真源）',
      '## 三、发布到 GitHub（可选，文档级 + gh CLI）',
      '## 四、自我进化（evolve，用真实会话回放）',
    ];
    for (const heading of sections) {
      expect(SEED, `缺节: ${heading}`).toContain(heading);
    }
    expect(SEED).toContain('gh auth login');
    expect(SEED).toContain('不代用户输入任何令牌');
  });

  it('品牌卫生: 种子不硬编码固定作者名/标语/赞赏链接/博客链接', () => {
    for (const brand of ['joeseesun', '赞赏二维码', '公众号二维码']) {
      expect(SEED).not.toContain(brand);
    }
    expect(SEED).toContain('homepage:');
    expect(SEED).toContain('donate:');
    expect(SEED).toContain('slogan:');
    expect(SEED).toContain('author:');
  });

  it('种子自描述: meta.yaml 真源在本技能自身文件夹, 发布时拷到目标技能', () => {
    expect(SEED).toContain('lorra-meta-skill/meta.yaml');
    expect(SEED).toContain('拷过去');
    expect(SEED).toContain('唯一真源');
    expect(SEED).not.toContain('目标技能文件夹里');
    expect(SEED).not.toContain('目标技能文件夹下的 meta.yaml');
  });

  it('种子描述里: meta.yaml 字段名(标语/作者/主页/赞赏)摘要出现在 description', () => {
    const desc = SEED.match(/^description: (.*)$/m)?.[1] ?? '';
    expect(desc).toContain('标语');
    expect(desc).toContain('作者');
    expect(desc).toContain('主页');
    expect(desc).toContain('赞赏');
  });
});
