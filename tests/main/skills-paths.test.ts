import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAdditionalSkillPaths } from '../../src/main/pi-sdk-driver/session-persistence';

/**
 * additionalSkillPaths 门控（2026-08-18 内置技能批）:
 * - base = [<ws>/.lorra/skills, ~/.agents/skills] 恒在
 * - ~/.claude/skills（三路径兼容新增）:路径存在才入 —— 未装 Claude Code 的用户不受影响
 * - 自定义收集根:存在且不与 base 重复才入;默认根(= ~/.agents/skills)天然去重
 * - agent-plugin 技能根恒在最后
 * os.homedir 经 spy 指向临时目录,不触碰真实用户目录。
 */

describe('buildAdditionalSkillPaths（~/.claude/skills 存在才入）', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-paths-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('~/.claude/skills 存在 → 进入 additionalSkillPaths（base 之后、插件根之前）', () => {
    const ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const claudeSkills = path.join(home, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });

    const paths = buildAdditionalSkillPaths({
      wsRealpath: ws,
      collectionRoot: path.join(home, '.agents', 'skills'), // 默认根(尚不存在)
      claudeSkills,
      agentPluginSkillRoots: ['P:/plugins/skills'],
    });

    expect(paths).toEqual([
      path.join(ws, '.lorra', 'skills'),
      path.join(home, '.agents', 'skills'),
      claudeSkills,
      'P:/plugins/skills',
    ]);
  });

  it('~/.claude/skills 不存在 → 跳过（未装 Claude Code 不受影响）', () => {
    const ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });

    const paths = buildAdditionalSkillPaths({
      wsRealpath: ws,
      collectionRoot: path.join(home, '.agents', 'skills'),
      claudeSkills: path.join(home, '.claude', 'skills'),
      agentPluginSkillRoots: [],
    });

    expect(paths).toEqual([
      path.join(ws, '.lorra', 'skills'),
      path.join(home, '.agents', 'skills'),
    ]);
  });

  it('自定义收集根存在 → 加入（base 之后、claude 之前）', () => {
    const ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const collectionRoot = path.join(home, 'custom-skills');
    mkdirSync(collectionRoot, { recursive: true });
    const claudeSkills = path.join(home, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });

    const paths = buildAdditionalSkillPaths({
      wsRealpath: ws,
      collectionRoot,
      claudeSkills,
      agentPluginSkillRoots: [],
    });

    expect(paths).toEqual([
      path.join(ws, '.lorra', 'skills'),
      path.join(home, '.agents', 'skills'),
      collectionRoot,
      claudeSkills,
    ]);
  });

  it('收集根与 base 同路径(默认值) → 不重复加入;插件根恒在最后', () => {
    const ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const collectionRoot = path.join(home, '.agents', 'skills');
    mkdirSync(collectionRoot, { recursive: true }); // 存在但同 base → 去重

    const paths = buildAdditionalSkillPaths({
      wsRealpath: ws,
      collectionRoot,
      claudeSkills: path.join(home, '.claude', 'skills'), // 不存在
      agentPluginSkillRoots: ['P:/a/skills', 'P:/b/skills'],
    });

    expect(paths).toEqual([
      path.join(ws, '.lorra', 'skills'),
      path.join(home, '.agents', 'skills'),
      'P:/a/skills',
      'P:/b/skills',
    ]);
  });
});
