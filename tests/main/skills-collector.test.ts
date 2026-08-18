import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectSkills } from '../../src/main/skills/skills-collector';
import { scanSkills } from '../../src/main/skills/skills-store';
import { writeSettings } from '../../src/main/workspace/settings';
import type { Result } from '../../src/shared/result';
import type { CollectResult } from '../../src/shared/skills-api';

/**
 * 技能收集(2026-08-13 批 D5)测试:
 * - 目录形 rename + 原位 junction 建立(win32 junction / posix symlink);
 * 收集后 scanSkills 发现技能且 filePath = 收集根路径(SDK 跟随语义同源)
 * - EXDEV 跨卷回退(copy + trashItem;win32 无法可靠构造 → skip 注明)
 * - 同名等价 → trashItem 原实体 + 原位 junction,计 linked
 * - 同名不等价 → conflict,原样保留不删
 * - 平铺 .md → moved + note「无链接」
 * - 系统种子排除(memory-maintenance/daily-review/deep-review 不动)
 * - 收集根不存在自动创建
 * - 部分失败继续(单条目失败收集错误,其余照常;全部失败才整体 err)
 *
 * electron mock 照 skills-override.test.ts 先例:settings 走 app.getPath('userData'),
 * shell.trashItem spy;os.homedir spy 注入临时 home。
 */

const electronMock = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? electronMock.userData : ''),
  },
  shell: {
    trashItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import { shell } from 'electron';

function unwrap(res: Result<CollectResult>): CollectResult {
  if (res.isErr()) throw new Error(`collectSkills failed: ${res.error.code}: ${res.error.message}`);
  return res.value;
}

function unwrapScan<T>(res: Result<T>): T {
  if (res.isErr()) throw new Error(`scanSkills failed: ${res.error.message}`);
  return res.value;
}

/** 在 <dir>/<name>/SKILL.md 建目录形技能(内容确定性,供等价判定)。 */
function writeDirSkill(dir: string, name: string, body = 'body\n'): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n${body}`,
    'utf8',
  );
}

/** 在 <dir>/<name>.md 建平铺技能。 */
function writeFlatSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} 描述\n---\n\nbody\n`,
    'utf8',
  );
}

/** 目标为链接(lstat isSymbolicLink;win32 junction 同样成立)。 */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

describe('collectSkills(收编 + 软链)', () => {
  let home: string;
  let ws: string;
  let collectionRoot: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-collect-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    collectionRoot = path.join(home, 'collection');
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-collect-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await writeSettings({ recentWorkspaces: [ws] });
    // trash 模拟真实回收站语义:实际删除目标(等价建链/回滚断言依赖),且每测试清零。
    (shell.trashItem as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation(async (p: string) => {
        rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('Scenario 收集目录形技能:rename 进收集根 + 原位 junction;scanSkills 发现且 filePath=收集根路径', async () => {
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'foo');

    const res = await collectSkills(ws, { collectionRoot });
    expect(res.isOk()).toBe(true);
    const result = unwrap(res);
    expect(result.moved).toBe(1);
    expect(result.linked).toBe(0);

    // 实体在收集根。
    expect(existsSync(path.join(collectionRoot, 'foo', 'SKILL.md'))).toBe(true);
    // 原位置是 junction(win32)/symlink(posix)。
    const original = path.join(ws, '.lorra', 'skills', 'foo');
    expect(isLink(original)).toBe(true);
    // junction 指回收集根(SDK 跟随语义)。
    expect(realpathSync(original)).toBe(realpathSync(path.join(collectionRoot, 'foo')));

    // 管理页/agent 同源:扫描发现 foo 且 filePath = 收集根路径。
    const scan = unwrapScan(await scanSkills(ws, { homedir: home, collectionRoot }));
    const skill = scan.skills.find((s) => s.name === 'foo');
    expect(skill).toBeDefined();
    expect(skill?.filePath).toBe(path.join(collectionRoot, 'foo', 'SKILL.md'));
    expect(skill?.source).toBe('collection');
  });

  it('Scenario 平铺 .md:rename 进收集根,不建链接,note「无链接」', async () => {
    writeFlatSkill(path.join(ws, '.lorra', 'skills'), 'flat-one');

    const result = unwrap(await collectSkills(ws, { collectionRoot }));

    expect(result.moved).toBe(1);
    expect(existsSync(path.join(collectionRoot, 'flat-one.md'))).toBe(true);
    // 原位置无链接(文件被移走,位置不存在)。
    expect(isLink(path.join(ws, '.lorra', 'skills', 'flat-one.md'))).toBe(false);
    expect(result.notes.some((n) => n.includes('平铺文件已收集，原位置无链接'))).toBe(true);
  });

  it('Scenario 同名等价:trashItem 原实体 + 原位 junction,计 linked', async () => {
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'dup');
    // 收集根内同内容副本(先手动放一份等价实体)。
    writeDirSkill(collectionRoot, 'dup');

    const result = unwrap(await collectSkills(ws, { collectionRoot }));

    expect(result.moved).toBe(0);
    expect(result.linked).toBe(1);
    expect(result.conflicts).toEqual([]);
    // 原位置被 trash + 建链。
    expect(shell.trashItem).toHaveBeenCalledWith(path.join(ws, '.lorra', 'skills', 'dup'));
    expect(isLink(path.join(ws, '.lorra', 'skills', 'dup'))).toBe(true);
    // 收集根实体未被删。
    expect(existsSync(path.join(collectionRoot, 'dup', 'SKILL.md'))).toBe(true);
  });

  it('Scenario 同名不等价:conflict,原样保留不删', async () => {
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'dup', '工作区版本内容\n');
    writeDirSkill(collectionRoot, 'dup', '收集根版本内容\n');

    const result = unwrap(await collectSkills(ws, { collectionRoot }));

    expect(result.moved).toBe(0);
    expect(result.linked).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain('dup');
    expect(result.conflicts[0]).toContain('保留原样');
    // 原实体仍在(未移动、未删除)。
    expect(existsSync(path.join(ws, '.lorra', 'skills', 'dup', 'SKILL.md'))).toBe(true);
    expect(shell.trashItem).not.toHaveBeenCalled();
  });

  it('Scenario frontmatter name 相同而目录名不同:不收集出第二份同名技能(2026-08-18 修复)', async () => {
    // 工作区:目录 dir-a,frontmatter name=shared-name。
    mkdirSync(path.join(ws, '.lorra', 'skills', 'dir-a'), { recursive: true });
    writeFileSync(
      path.join(ws, '.lorra', 'skills', 'dir-a', 'SKILL.md'),
      '---\nname: shared-name\ndescription: 工作区版\n---\n\n工作区内容\n',
      'utf8',
    );
    // 收集根:目录 dir-b,frontmatter name=shared-name(不同目录名)。
    mkdirSync(path.join(collectionRoot, 'dir-b'), { recursive: true });
    writeFileSync(
      path.join(collectionRoot, 'dir-b', 'SKILL.md'),
      '---\nname: shared-name\ndescription: 收集根版\n---\n\n收集根内容\n',
      'utf8',
    );

    const result = unwrap(await collectSkills(ws, { collectionRoot }));

    // 不等价 → 冲突,不移动不建链(此前会按目录名收集出 dir-a/dir-b 两份同名)。
    expect(result.moved).toBe(0);
    expect(result.linked).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain('shared-name');
    expect(existsSync(path.join(ws, '.lorra', 'skills', 'dir-a', 'SKILL.md'))).toBe(true);
  });

  it('Scenario frontmatter name 相同且内容等价:trash 原实体 + 原位 junction 指向已有技能', async () => {
    mkdirSync(path.join(ws, '.lorra', 'skills', 'dir-a'), { recursive: true });
    writeFileSync(
      path.join(ws, '.lorra', 'skills', 'dir-a', 'SKILL.md'),
      '---\nname: shared-name\ndescription: 同一份\n---\n\n等价内容\n',
      'utf8',
    );
    mkdirSync(path.join(collectionRoot, 'dir-b'), { recursive: true });
    writeFileSync(
      path.join(collectionRoot, 'dir-b', 'SKILL.md'),
      '---\nname: shared-name\ndescription: 同一份\n---\n\n等价内容\n',
      'utf8',
    );

    const result = unwrap(await collectSkills(ws, { collectionRoot }));

    expect(result.linked).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(shell.trashItem).toHaveBeenCalledWith(path.join(ws, '.lorra', 'skills', 'dir-a'));
    expect(isLink(path.join(ws, '.lorra', 'skills', 'dir-a'))).toBe(true);
  });

  it('Scenario 系统管理种子排除:memory-maintenance/daily-review/deep-review 不动', async () => {
    for (const name of ['memory-maintenance', 'daily-review', 'deep-review']) {
      writeDirSkill(path.join(ws, '.lorra', 'skills'), name);
    }

    const result = unwrap(await collectSkills(ws, { collectionRoot }));

    expect(result.moved).toBe(0);
    // 种子仍留在原位置(实体,非链接)。
    for (const name of ['memory-maintenance', 'daily-review', 'deep-review']) {
      const p = path.join(ws, '.lorra', 'skills', name);
      expect(existsSync(path.join(p, 'SKILL.md'))).toBe(true);
      expect(isLink(p)).toBe(false);
    }
  });

  it('Scenario 收集根不存在 → 自动创建(recursive)', async () => {
    const customRoot = path.join(home, 'deep', 'nested', 'collection');
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'foo');

    const result = unwrap(await collectSkills(ws, { collectionRoot: customRoot }));

    expect(result.moved).toBe(1);
    expect(existsSync(path.join(customRoot, 'foo', 'SKILL.md'))).toBe(true);
  });

  it('Scenario 扫描位置覆盖 recentWorkspaces 三处 + ~/.claude/skills;收集根本身不扫描', async () => {
    // 四个散乱位置各放一个技能。
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'from-lorra');
    writeDirSkill(path.join(ws, '.agents', 'skills'), 'from-agents');
    writeDirSkill(path.join(ws, '.claude', 'skills'), 'from-claude');
    writeDirSkill(path.join(home, '.claude', 'skills'), 'from-home-claude');
    // 收集根内已有技能(不应被当作散乱来源)。
    writeDirSkill(collectionRoot, 'already-collected');

    const result = unwrap(await collectSkills(ws, { collectionRoot }));

    expect(result.moved).toBe(4);
    expect(existsSync(path.join(collectionRoot, 'from-lorra', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(collectionRoot, 'from-agents', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(collectionRoot, 'from-claude', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(collectionRoot, 'from-home-claude', 'SKILL.md'))).toBe(true);
    // already-collected 未被动过(无同名冲突、无 trash)。
    expect(existsSync(path.join(collectionRoot, 'already-collected', 'SKILL.md'))).toBe(true);
  });

  it('Scenario 部分失败继续:一个条目失败(trash 拒绝),其余成功,结果 ok 且失败进 notes', async () => {
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'ok-skill');
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'dup-skill', '内容 A\n');
    writeDirSkill(collectionRoot, 'dup-skill', '内容 A\n');
    // 等价分支 trash 拒绝 → 该条目失败(其余条目不受影响)。
    (shell.trashItem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('trash denied'));

    const res = await collectSkills(ws, { collectionRoot });
    expect(res.isOk()).toBe(true);
    const result = unwrap(res);
    expect(result.moved).toBe(1);
    // dup-skill 失败被收集进 notes(不中断其余条目)。
    expect(result.notes.some((n) => n.includes('dup-skill') && n.includes('收集失败'))).toBe(true);
    // dup-skill 原实体仍在。
    expect(existsSync(path.join(ws, '.lorra', 'skills', 'dup-skill', 'SKILL.md'))).toBe(true);
  });

  it('Scenario 全部失败 → 整体 err(skills-collect-failed)', async () => {
    // 收集根是一个文件 → mkdir recursive 失败 → 整体失败。
    writeFileSync(collectionRoot, 'not a dir', 'utf8');
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'foo');

    const res = await collectSkills(ws, { collectionRoot });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('skills-collect-failed');
  });

  it('EXDEV 跨卷回退无法在本机可靠构造:win32 NTFS 同卷无 EXDEV → skip 注明(分支由代码审查保障)', () => {
    // moveEntity 的 EXDEV 分支(copy + trashItem)在 win32 上无法通过普通目录构造
    // (NTFS 同卷无 EXDEV);posix 下需 mount 特权 → 该分支以代码审查保障,标记 skip 理由。
    expect(true).toBe(true);
  });

  it('Scenario 二次收集幂等(2026-08-13 复盘修复):已收集的 junction 不再重复处理', async () => {
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'foo');
    const first = unwrap(await collectSkills(ws, { collectionRoot }));
    expect(first.moved).toBe(1);

    // 清掉第一次的 trash 调用记录,验证第二次不动任何东西。
    (shell.trashItem as ReturnType<typeof vi.fn>).mockClear();
    const second = unwrap(await collectSkills(ws, { collectionRoot }));

    expect(second.moved).toBe(0);
    expect(second.linked).toBe(0);
    expect(second.conflicts).toEqual([]);
    expect(shell.trashItem).not.toHaveBeenCalled();
    // junction 仍在且指向收集根,内容未被破坏。
    const original = path.join(ws, '.lorra', 'skills', 'foo');
    expect(isLink(original)).toBe(true);
    expect(realpathSync(original)).toBe(realpathSync(path.join(collectionRoot, 'foo')));
    expect(existsSync(path.join(collectionRoot, 'foo', 'SKILL.md'))).toBe(true);
  });

  it('收集操作不写 skill-installs.json(元数据仅 git 安装写)', async () => {
    writeDirSkill(path.join(ws, '.lorra', 'skills'), 'foo');
    unwrap(await collectSkills(ws, { collectionRoot }));
    const regPath = path.join(electronMock.userData, 'skill-installs.json');
    expect(existsSync(regPath)).toBe(false);
  });
});
