import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LORRA_META_SKILL_SEED, seedLorraMetaSkill } from '../../src/main/skills/skill-meta-seed';
import { describeSeedSkillBehavior } from './seed-skill';

// 通用行为矩阵(loadOrSeedSkill 共享契约,2026-08-17 收敛):
describeSeedSkillBehavior('lorra-meta-skill', {
  name: 'lorra-meta-skill',
  seed: LORRA_META_SKILL_SEED,
});

// 包装层漂移保护: seedLorraMetaSkill 应直接转发到 loadOrSeedSkill,
// 不可中途改 code、改路径、改写入内容。
describe('seedLorraMetaSkill 包装层', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-meta-wrap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('happy-path: 写入并返回 LORRA_META_SKILL_SEED', () => {
    const r = seedLorraMetaSkill(dir);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe(LORRA_META_SKILL_SEED);
  });

  it('失败时仍返回 seed-skill-failed', () => {
    const filePath = path.join(dir, 'not-a-dir');
    writeFileSync(filePath, 'occupied', 'utf8');
    const r = seedLorraMetaSkill(filePath);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('seed-skill-failed');
  });
});

// 内容契约:lorra 元技能自身的字段保证(frontmatter、四段、品牌卫生、真源自描述);
// 与 loadOrSeedSkill 行为无关。
describe('LORRA_META_SKILL_SEED 内容契约', () => {
  it('frontmatter 合法: name = lorra-meta-skill, description 非空且 ≤1024', () => {
    expect(LORRA_META_SKILL_SEED.startsWith('---\nname: lorra-meta-skill\n')).toBe(true);
    const desc = LORRA_META_SKILL_SEED.match(/^description: (.*)$/m)?.[1] ?? '';
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
      expect(LORRA_META_SKILL_SEED, `缺节: ${heading}`).toContain(heading);
    }
    expect(LORRA_META_SKILL_SEED).toContain('gh auth login');
    expect(LORRA_META_SKILL_SEED).toContain('不代用户输入任何令牌');
  });

  it('品牌卫生: 种子不硬编码固定作者名/标语/赞赏链接/博客链接', () => {
    for (const brand of ['joeseesun', '赞赏二维码', '公众号二维码']) {
      expect(LORRA_META_SKILL_SEED).not.toContain(brand);
    }
    expect(LORRA_META_SKILL_SEED).toContain('homepage:');
    expect(LORRA_META_SKILL_SEED).toContain('donate:');
    expect(LORRA_META_SKILL_SEED).toContain('slogan:');
    expect(LORRA_META_SKILL_SEED).toContain('author:');
  });

  it('种子自描述: meta.yaml 真源在本技能自身文件夹, 发布时拷到目标技能', () => {
    expect(LORRA_META_SKILL_SEED).toContain('lorra-meta-skill/meta.yaml');
    expect(LORRA_META_SKILL_SEED).toContain('拷过去');
    expect(LORRA_META_SKILL_SEED).toContain('唯一真源');
    expect(LORRA_META_SKILL_SEED).not.toContain('目标技能文件夹里');
    expect(LORRA_META_SKILL_SEED).not.toContain('目标技能文件夹下的 meta.yaml');
  });

  it('种子描述里: meta.yaml 字段名(标语/作者/主页/赞赏)摘要出现在 description', () => {
    const desc = LORRA_META_SKILL_SEED.match(/^description: (.*)$/m)?.[1] ?? '';
    expect(desc).toContain('标语');
    expect(desc).toContain('作者');
    expect(desc).toContain('主页');
    expect(desc).toContain('赞赏');
  });
});
