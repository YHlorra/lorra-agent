import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSkillSourcePaths,
  SEED_FILE_SKILL_NAMES,
  type SkillScan,
  SYSTEM_MANAGED_SKILL_NAMES,
  scanSkills,
} from '../../src/main/skills/skills-store';
import type { Result } from '../../src/shared/result';
import type { SkillBudget, SkillInfo } from '../../src/shared/skills-api';
import {
  SKILL_BUDGET_GOOD_TOKENS,
  SKILL_BUDGET_WARN_TOKENS,
  SKILL_DESC_CHARS_MAX,
  SKILL_TOKEN_ESTIMATE_DIVISOR,
} from '../../src/shared/skills-api';

/**
 * 技能管理 V1-1/V1-2 服务层测试（TDD）：
 * - 四源路径（祖先 .agents/skills → ~/.lorra/skills → ~/.agents/skills → <ws>/.lorra/skills，
 * 顺序即去重优先级，对齐 SDK resolve 次序去掉 .pi 后）
 * - 发现语义对齐 pi SDK loadSkillsFromDirInternal：SKILL.md 根 / 平铺 .md / 递归 SKILL.md
 * - realpath 去重（junction 只列一条）+ 同名碰撞先到者胜
 * - 健康判定（缺描述 / 超长 / 类型错误 / 过大 / 缺失）
 * - 预算（剔除 disableModelInvocation / 系统种子 / disabledSkills；三级状态边界）
 *
 * homedir 注入走 opts（trusted-paths 同款）；~/.lorra 经 LORRA_E2E_USERDATA 指向 tempHome
 * （today-ipc.test.ts 的 stubEnv/unstubAllEnvs 模式），测试永不触达真实 home。
 */

function unwrapScan(res: Result<SkillScan>): SkillScan {
  if (res.isErr()) throw new Error(`scanSkills failed: ${res.error.message}`);
  return res.value;
}

/** 写一个技能文件（frontmatter 键值 → YAML 行；字符串值原样，布尔/数字按标量）。 */
function writeSkill(filePath: string, fm: Record<string, unknown>, body = 'body\n'): void {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'string') lines.push(`${k}: ${v}`);
    else if (typeof v === 'boolean') lines.push(`${k}: ${v ? 'true' : 'false'}`);
    else if (typeof v === 'number') lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', body);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join('\n'), 'utf8');
}

/** 断言技能存在并返回（缺失 → 带名报错，优于 undefined 解引用）。 */
function requireSkill(scan: SkillScan, name: string): SkillInfo {
  const s = scan.skills.find((x) => x.name === name);
  if (!s) throw new Error(`扫描结果缺少技能 ${name}`);
  return s;
}

const issueCodes = (s: SkillInfo): string[] => s.issues.map((i) => i.code);

describe('getSkillSourcePaths（六源顺序）', () => {
  let home: string;
  let cleanup: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-skills-home-'));
    cleanup = [];
    vi.stubEnv('LORRA_E2E_USERDATA', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const p of cleanup)
      rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('工作区为 git 根：六源 = [ws/.agents/skills, ~/.lorra/skills, ~/.agents/skills, ~/.claude/skills, ws/.lorra/skills]', () => {
    const ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });

    expect(getSkillSourcePaths(ws, { homedir: home })).toEqual([
      path.join(ws, '.agents', 'skills'),
      path.join(home, '.lorra', 'skills'),
      path.join(home, '.agents', 'skills'),
      path.join(home, '.claude', 'skills'),
      path.join(ws, '.lorra', 'skills'),
    ]);
  });

  it('祖先上溯至 git 根：ws/a/b 建 .agents/skills 在 a 层 → 逐级收集并在 git 根停止', () => {
    const gitRoot = path.join(home, 'git-root');
    const ws = path.join(gitRoot, 'a', 'b');
    mkdirSync(path.join(gitRoot, '.git'), { recursive: true });
    // 祖先层目录不需要真实存在（SDK collectAncestorAgentsSkillDirs 同款：收集路径集，加载时再判存在）。

    expect(getSkillSourcePaths(ws, { homedir: home })).toEqual([
      path.join(ws, '.agents', 'skills'),
      path.join(gitRoot, 'a', '.agents', 'skills'),
      path.join(gitRoot, '.agents', 'skills'),
      path.join(home, '.lorra', 'skills'),
      path.join(home, '.agents', 'skills'),
      path.join(home, '.claude', 'skills'),
      path.join(ws, '.lorra', 'skills'),
    ]);
  });

  it('非 git 工作区上溯至 fs 根兜底；~/.agents/skills 作为 user 源恰好出现一次（祖先列表排除自身）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lorra-skills-chain-'));
    cleanup.push(root);
    const ws = path.join(root, 'home', 'ws'); // home 在链上：root/home
    mkdirSync(ws, { recursive: true });

    const paths = getSkillSourcePaths(ws, { homedir: path.join(root, 'home') });

    // 祖先（最靠近 ws 在前，home/.agents/skills 被排除）：
    expect(paths[0]).toBe(path.join(ws, '.agents', 'skills'));
    expect(paths[1]).toBe(path.join(root, '.agents', 'skills'));
    // user 源恰好一次（位置 = 祖先之后、工作区之前）：
    const userDir = path.join(root, 'home', '.agents', 'skills');
    expect(paths.filter((p) => p === userDir)).toHaveLength(1);
    expect(paths.indexOf(userDir)).toBeGreaterThan(
      paths.indexOf(path.join(root, 'home', '.lorra', 'skills')),
    );
    expect(paths.indexOf(userDir)).toBeLessThan(paths.indexOf(path.join(ws, '.lorra', 'skills')));
  });

  it('五源(2026-08-13): 自定义收集根最前 + 与 user 源同路径去重(默认值)', () => {
    const ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    const customRoot = path.join(home, 'custom-skills');

    // 自定义收集根 → 列在首位。
    expect(getSkillSourcePaths(ws, { homedir: home, collectionRoot: customRoot })).toEqual([
      customRoot,
      path.join(ws, '.agents', 'skills'),
      path.join(home, '.lorra', 'skills'),
      path.join(home, '.agents', 'skills'),
      path.join(home, '.claude', 'skills'),
      path.join(ws, '.lorra', 'skills'),
    ]);

    // 默认收集根 = ~/.agents/skills → 与 user 源同路径去重(不重复出现)。
    const defaults = getSkillSourcePaths(ws, { homedir: home });
    const userDir = path.join(home, '.agents', 'skills');
    expect(defaults.filter((p) => p === userDir)).toHaveLength(1);
  });

  it('collection 源判定: realpath 前缀边界(2026-08-13) —— `<root>abc` 不匹配 `<root>`', async () => {
    // collectionRoot = <home>/user;工作区在 <home>/user2 下(前缀近似而非边界)。
    const collectionRoot = path.join(home, 'user');
    const nearWs = path.join(home, 'user2', 'work');
    mkdirSync(path.join(nearWs, '.git'), { recursive: true });
    writeSkill(path.join(collectionRoot, 'inside', 'SKILL.md'), {
      name: 'inside',
      description: 'x',
    });
    writeSkill(path.join(nearWs, '.agents', 'skills', 'near.md'), {
      name: 'near',
      description: '前缀近似目录里的技能',
    });

    const scan = unwrapScan(await scanSkills(nearWs, { homedir: home, collectionRoot }));
    const byName = new Map(scan.skills.map((s) => [s.name, s]));
    expect(byName.get('inside')?.source).toBe('collection');
    // `<root>abc`(user2)不匹配 `<root>`(user):前缀边界带分隔符,不误判为 collection。
    expect(byName.get('near')?.source).toBe('ancestor');
  });

  it('claude 源(2026-08-18): ~/.claude/skills 技能 → source=claude && scope=global', async () => {
    const ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    writeSkill(path.join(home, '.claude', 'skills', 'claude-test', 'SKILL.md'), {
      name: 'claude-test',
      description: '来自 Claude Code 的技能',
    });

    const scan = unwrapScan(await scanSkills(ws, { homedir: home }));
    const skill = requireSkill(scan, 'claude-test');
    expect(skill.source).toBe('claude');
    expect(skill.scope).toBe('global');
    // claude 源排在 lorra 全局 / user 之后、工作区之前(去重优先级)。
    const paths = getSkillSourcePaths(ws, { homedir: home });
    const claudeDir = path.join(home, '.claude', 'skills');
    expect(paths.indexOf(claudeDir)).toBeGreaterThan(
      paths.indexOf(path.join(home, '.agents', 'skills')),
    );
    expect(paths.indexOf(claudeDir)).toBeLessThan(paths.indexOf(path.join(ws, '.lorra', 'skills')));
  });
});

describe('scanSkills：发现与去重', () => {
  let home: string;
  let ws: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-skills-scan-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    vi.stubEnv('LORRA_E2E_USERDATA', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  const scan = async () => unwrapScan(await scanSkills(ws, { homedir: home }));

  it('目录含 SKILL.md → 技能根：不加载同目录平铺 .md、不递归子目录', async () => {
    writeSkill(path.join(home, '.agents', 'skills', 'skill-a', 'SKILL.md'), {
      name: 'skill-a',
      description: 'A 技能',
    });
    writeSkill(path.join(home, '.agents', 'skills', 'skill-a', 'extra.md'), {
      name: 'extra',
      description: '不应出现',
    });
    writeSkill(path.join(home, '.agents', 'skills', 'skill-a', 'sub', 'SKILL.md'), {
      name: 'nested',
      description: '不应出现（技能根不递归）',
    });

    expect((await scan()).skills.map((s) => s.name)).toEqual(['skill-a']);
  });

  it('根下无 SKILL.md → 平铺 .md 文件算技能', async () => {
    writeSkill(path.join(home, '.agents', 'skills', 'one.md'), {
      name: 'one',
      description: '一号',
    });
    writeSkill(path.join(home, '.agents', 'skills', 'two.md'), {
      name: 'two',
      description: '二号',
    });

    expect((await scan()).skills.map((s) => s.name).sort()).toEqual(['one', 'two']);
  });

  it('递归子目录找 SKILL.md；子目录内平铺 .md 不计（includeRootFiles=false 语义）', async () => {
    writeSkill(path.join(home, '.agents', 'skills', 'nested', 'skill-b', 'SKILL.md'), {
      name: 'skill-b',
      description: '子目录技能',
    });
    writeSkill(path.join(home, '.agents', 'skills', 'nested', 'flat.md'), {
      name: 'flat',
      description: '不应出现',
    });

    expect((await scan()).skills.map((s) => s.name)).toEqual(['skill-b']);
  });

  it('source 标记：祖先=ancestor / 全局=lorra-global / 收集根默认 ~/.agents/skills → collection / 工作区=workspace', async () => {
    writeSkill(path.join(home, 'work', '.agents', 'skills', 'anc.md'), {
      name: 'anc',
      description: 'x',
    });
    writeSkill(path.join(home, '.lorra', 'skills', 'glo.md'), { name: 'glo', description: 'x' });
    writeSkill(path.join(home, '.agents', 'skills', 'usr.md'), { name: 'usr', description: 'x' });
    writeSkill(path.join(ws, '.lorra', 'skills', 'wsp.md'), { name: 'wsp', description: 'x' });

    const byName = new Map((await scan()).skills.map((s) => [s.name, s]));
    expect(byName.get('anc')?.source).toBe('ancestor');
    expect(byName.get('glo')?.source).toBe('lorra-global');
    // 默认收集根 = ~/.agents/skills(与 user 源同路径去重) → 该路径技能归 collection。
    expect(byName.get('usr')?.source).toBe('collection');
    expect(byName.get('wsp')?.source).toBe('workspace');
    // scope 映射:collection/lorra-global → global;ancestor/workspace → project。
    expect(byName.get('usr')?.scope).toBe('global');
    expect(byName.get('glo')?.scope).toBe('global');
    expect(byName.get('anc')?.scope).toBe('project');
    expect(byName.get('wsp')?.scope).toBe('project');
  });

  it('同名技能两源（不同 realpath）：先到者胜 = 源顺序在前者，后者不出现', async () => {
    writeSkill(path.join(home, '.lorra', 'skills', 'dup', 'SKILL.md'), {
      name: 'dup',
      description: '全局',
    });
    writeSkill(path.join(home, '.agents', 'skills', 'dup', 'SKILL.md'), {
      name: 'dup',
      description: '用户',
    });

    const scan = unwrapScan(await scanSkills(ws, { homedir: home }));
    expect(scan.skills.filter((s) => s.name === 'dup')).toHaveLength(1);
    // lorra 全局在 user 之前 → 全局版本获胜。
    expect(scan.skills.find((s) => s.name === 'dup')?.source).toBe('lorra-global');
    expect(scan.skills.find((s) => s.name === 'dup')?.description).toBe('全局');
  });

  it('realpath 去重：工作区 junction 指向 user 源已发现技能 → 只列一条，filePath 为源顺序在前者', async () => {
    const realDir = path.join(home, '.agents', 'skills', 'jn');
    writeSkill(path.join(realDir, 'SKILL.md'), { name: 'jn', description: '真实文件' });
    // junction 指向同一技能目录（不同路径、同 inode）。
    const jn = path.join(ws, '.lorra', 'skills', 'jn');
    mkdirSync(path.dirname(jn), { recursive: true });
    symlinkSync(realDir, jn, 'junction');

    const scan = unwrapScan(await scanSkills(ws, { homedir: home }));
    expect(scan.skills.filter((s) => s.name === 'jn')).toHaveLength(1);
    const skill = requireSkill(scan, 'jn');
    expect(skill.source).toBe('collection');
    expect(skill.filePath).toBe(path.join(realDir, 'SKILL.md'));
    expect(skill.realPath).toBe(path.join(realDir, 'SKILL.md'));
  });

  it('isDuplicate：同名技能跨工作区源与其它源（realpath 不同）→ 幸存条目标副本', async () => {
    writeSkill(path.join(home, '.agents', 'skills', 'dup2', 'SKILL.md'), {
      name: 'dup2',
      description: '用户',
    });
    writeSkill(path.join(ws, '.lorra', 'skills', 'dup2', 'SKILL.md'), {
      name: 'dup2',
      description: '工作区',
    });

    const scan = unwrapScan(await scanSkills(ws, { homedir: home }));
    const winner = requireSkill(scan, 'dup2');
    expect(winner.source).toBe('collection'); // 收集根(默认 ~/.agents/skills)最前 → 用户版本获胜
    expect(winner.isDuplicate).toBe(true);
    // 工作区副本未单独列出（碰撞 loser 被去重）。
    expect(scan.skills.filter((s) => s.name === 'dup2')).toHaveLength(1);
  });

  it('同名技能仅存在于非工作区两源（realpath 不同）→ 先到者胜且不标副本', async () => {
    writeSkill(path.join(home, '.lorra', 'skills', 'dup3', 'SKILL.md'), {
      name: 'dup3',
      description: '全局',
    });
    writeSkill(path.join(home, '.agents', 'skills', 'dup3', 'SKILL.md'), {
      name: 'dup3',
      description: '用户',
    });

    const scan = unwrapScan(await scanSkills(ws, { homedir: home }));
    const winner = requireSkill(scan, 'dup3');
    expect(winner.source).toBe('lorra-global'); // lorra 全局在 user(收集根)之前
    expect(winner.isDuplicate).toBe(false);
  });

  it('rootDir：目录形技能 = SKILL.md 所在目录；平铺 = 源根（realpath）', async () => {
    writeSkill(path.join(home, '.agents', 'skills', 'dir-skill', 'SKILL.md'), {
      name: 'dir-skill',
      description: 'x',
    });
    writeSkill(path.join(home, '.agents', 'skills', 'flat-skill.md'), {
      name: 'flat-skill',
      description: 'x',
    });

    const scan = unwrapScan(await scanSkills(ws, { homedir: home }));
    expect(requireSkill(scan, 'dir-skill').rootDir).toBe(
      path.join(home, '.agents', 'skills', 'dir-skill'),
    );
    expect(requireSkill(scan, 'flat-skill').rootDir).toBe(path.join(home, '.agents', 'skills'));
  });

  it('循环链不卡死（visited-realpath 守卫）：cyc/loop → cyc，内部子技能仍被发现', async () => {
    const cyc = path.join(ws, '.lorra', 'skills', 'cyc');
    mkdirSync(cyc, { recursive: true });
    writeSkill(path.join(cyc, 'inner', 'SKILL.md'), {
      name: 'inner',
      description: '循环目录里的技能',
    });
    symlinkSync(cyc, path.join(cyc, 'loop'), 'junction');

    const scan = unwrapScan(await scanSkills(ws, { homedir: home }));
    expect(scan.skills.map((s) => s.name)).toEqual(['inner']);
  });
});

describe('scanSkills：健康判定', () => {
  let home: string;
  let ws: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-skills-health-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    vi.stubEnv('LORRA_E2E_USERDATA', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  const scan = async () => unwrapScan(await scanSkills(ws, { homedir: home }));

  it('缺 description → missing-description（技能仍列出，不计预算字符）', async () => {
    writeSkill(path.join(home, '.agents', 'skills', 'nodesc', 'SKILL.md'), { name: 'nodesc' });

    const skill = requireSkill(await scan(), 'nodesc');
    expect(issueCodes(skill)).toEqual(['missing-description']);
    expect(skill.description).toBe('');
    expect(skill.descriptionChars).toBe(0);
    expect(skill.enabled).toBe(true);
  });

  it('description >1024 → description-too-long（仍全量注入，预算按全量字符）', async () => {
    const longDesc = 'd'.repeat(SKILL_DESC_CHARS_MAX + 1);
    writeSkill(path.join(home, '.agents', 'skills', 'long', 'SKILL.md'), {
      name: 'long',
      description: longDesc,
    });

    const skill = requireSkill(await scan(), 'long');
    expect(issueCodes(skill)).toEqual(['description-too-long']);
    expect(skill.descriptionChars).toBe(SKILL_DESC_CHARS_MAX + 1);
    // 预算按全量：
    const budget = (await scan()).budget;
    expect(budget.charSum).toBe(SKILL_DESC_CHARS_MAX + 1);
  });

  it('name: 123 → frontmatter-type-error（健康项而非静默丢弃；name 回退父目录名）', async () => {
    writeSkill(path.join(home, '.agents', 'skills', 'typed', 'SKILL.md'), {
      name: 123,
      description: '正常描述',
    });

    const skill = requireSkill(await scan(), 'typed');
    expect(issueCodes(skill)).toEqual(['frontmatter-type-error']);
    expect(skill.name).toBe('typed');
  });

  it('>1MB 文件 → too-large（跳过加载，description 为空）', async () => {
    const huge = path.join(home, '.agents', 'skills', 'huge.md');
    mkdirSync(path.dirname(huge), { recursive: true });
    // 超过 1MB 的 .md（writeFileSync 确定性创建，stat size = 1MB+1）。
    writeFileSync(huge, 'x'.repeat(1024 * 1024 + 1), 'utf8');

    const skill = requireSkill(await scan(), 'huge');
    expect(issueCodes(skill)).toEqual(['too-large']);
    expect(skill.description).toBe('');
    expect(skill.descriptionChars).toBe(0);
  });

  it('缺失文件（broken junction）→ missing-file', async () => {
    const ghost = path.join(home, '.agents', 'skills', 'ghost.md');
    mkdirSync(path.dirname(ghost), { recursive: true });
    let ok = true;
    try {
      symlinkSync(path.join(home, '.agents', 'skills', 'no-such-dir'), ghost, 'junction');
    } catch {
      ok = false;
    }

    if (!ok) return; // 平台不支持断链创建 → 跳过（本机 junction 支持，正常会跑到）。

    const skill = requireSkill(await scan(), 'ghost');
    expect(issueCodes(skill)).toEqual(['missing-file']);
  });
});

describe('scanSkills：预算', () => {
  let home: string;
  let ws: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-skills-budget-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    vi.stubEnv('LORRA_E2E_USERDATA', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('charSum = Σ 启用技能 description 字符数：剔除 disableModelInvocation / 系统种子 / disabledSkills；token = round(charSum/3.5)', async () => {
    writeSkill(path.join(home, '.agents', 'skills', 'a', 'SKILL.md'), {
      name: 'a-skill',
      description: 'a'.repeat(300),
    });
    // disableModelInvocation（SDK 不注入）：
    writeSkill(path.join(home, '.agents', 'skills', 'b', 'SKILL.md'), {
      name: 'b-skill',
      description: 'b'.repeat(100),
      'disable-model-invocation': true,
    });
    // 系统剔除种子（per-workspace 播种链路专属,灰标「内部·未注入」）：
    writeSkill(path.join(home, '.agents', 'skills', 'c', 'SKILL.md'), {
      name: 'memory-maintenance',
      description: 'c'.repeat(200),
    });
    // 用户禁用名单：
    writeSkill(path.join(home, '.agents', 'skills', 'd', 'SKILL.md'), {
      name: 'd-skill',
      description: 'd'.repeat(150),
    });
    // 描述过长但全量注入：
    writeSkill(path.join(home, '.agents', 'skills', 'e', 'SKILL.md'), {
      name: 'e-skill',
      description: 'e'.repeat(SKILL_DESC_CHARS_MAX + 50),
    });
    // 缺描述（0 字符，仍属启用集）：
    writeSkill(path.join(home, '.agents', 'skills', 'f', 'SKILL.md'), { name: 'f-skill' });

    const scan = unwrapScan(await scanSkills(ws, { homedir: home, disabledSkills: ['d-skill'] }));
    const budget: SkillBudget = scan.budget;

    // 300 (a) + (1024+50) (e) = 1374；b/daily-review/d-skill 被剔除；f 计 0。
    expect(budget.charSum).toBe(300 + SKILL_DESC_CHARS_MAX + 50);
    expect(budget.estimatedTokens).toBe(
      Math.round((300 + SKILL_DESC_CHARS_MAX + 50) / SKILL_TOKEN_ESTIMATE_DIVISOR),
    );
    expect(budget.status).toBe('good');
    expect(budget.enabledCount).toBe(3); // a-skill, e-skill, f-skill
    expect(budget.goodLine).toBe(SKILL_BUDGET_GOOD_TOKENS);
    expect(budget.warnLine).toBe(SKILL_BUDGET_WARN_TOKENS);

    // 逐技能标记：
    expect(requireSkill(scan, 'a-skill').enabled).toBe(true);
    expect(requireSkill(scan, 'b-skill').disableModelInvocation).toBe(true);
    expect(requireSkill(scan, 'memory-maintenance').systemManaged).toBe(true);
    expect(requireSkill(scan, 'memory-maintenance').enabled).toBe(false);
    expect(requireSkill(scan, 'd-skill').enabled).toBe(false);
    expect(requireSkill(scan, 'd-skill').issues).toEqual([]);
  });

  it('系统管理种子 = memory-maintenance / ofk-digest; daily/deep-review 已是普通技能', async () => {
    expect(SYSTEM_MANAGED_SKILL_NAMES).toEqual(['memory-maintenance', 'ofk-digest']);
    // 种子文件集合 = SYSTEM_MANAGED ∪ 复盘种子(收集器按它跳过,UI 灰标只认前者)。
    expect(SEED_FILE_SKILL_NAMES).toEqual([
      'memory-maintenance',
      'ofk-digest',
      'daily-review',
      'deep-review',
    ]);

    for (const name of SYSTEM_MANAGED_SKILL_NAMES) {
      writeSkill(path.join(home, '.agents', 'skills', name, 'SKILL.md'), {
        name,
        description: `${name} 描述`,
      });
    }
    // 复盘种子(2026-08-18 迁全局路径后)以普通技能身份出现:无灰标、可启用。
    for (const name of ['daily-review', 'deep-review']) {
      writeSkill(path.join(home, '.agents', 'skills', name, 'SKILL.md'), {
        name,
        description: `${name} 描述`,
      });
    }
    const scan = unwrapScan(await scanSkills(ws, { homedir: home }));
    for (const name of SYSTEM_MANAGED_SKILL_NAMES) {
      expect(requireSkill(scan, name).systemManaged).toBe(true);
      expect(requireSkill(scan, name).enabled).toBe(false);
    }
    for (const name of ['daily-review', 'deep-review']) {
      expect(requireSkill(scan, name).systemManaged).toBe(false);
      expect(requireSkill(scan, name).enabled).toBe(true);
    }
    // 系统种子不进预算;复盘种子计入(普通技能语义)。
    expect(scan.budget.enabledCount).toBe(2);
    expect(scan.budget.charSum).toBeGreaterThan(0);
  });

  it('三级状态边界：≤2000 good / ≤4000 warn / >4000 over', async () => {
    // 精确到 token 级：charSum = tokens × 3.5。
    const cases: Array<{ descLen: number; expectedTokens: number; expectedStatus: string }> = [
      {
        descLen: SKILL_BUDGET_GOOD_TOKENS * SKILL_TOKEN_ESTIMATE_DIVISOR,
        expectedTokens: SKILL_BUDGET_GOOD_TOKENS,
        expectedStatus: 'good',
      },
      {
        descLen: SKILL_BUDGET_WARN_TOKENS * SKILL_TOKEN_ESTIMATE_DIVISOR,
        expectedTokens: SKILL_BUDGET_WARN_TOKENS,
        expectedStatus: 'warn',
      },
      {
        descLen: 14200,
        expectedTokens: Math.round(14200 / SKILL_TOKEN_ESTIMATE_DIVISOR),
        expectedStatus: 'over',
      },
    ];

    const descFile = path.join(home, '.agents', 'skills', 'boundary.md');
    mkdirSync(path.dirname(descFile), { recursive: true });

    for (const c of cases) {
      writeSkill(descFile, { name: 'boundary', description: 'b'.repeat(c.descLen) });
      const budget = unwrapScan(await scanSkills(ws, { homedir: home })).budget;
      expect(budget.charSum).toBe(c.descLen);
      expect(budget.estimatedTokens).toBe(c.expectedTokens);
      expect(budget.status).toBe(c.expectedStatus);
    }
  });
});
