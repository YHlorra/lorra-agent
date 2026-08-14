import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getGitStatuses, installSkill, updateAll } from '../../src/main/skills/skills-git';
import type { Result } from '../../src/shared/result';
import type { InstallResult } from '../../src/shared/skills-api';

/**
 * 技能 Git 操作层(2026-08-13 批 D6)测试,全部本地 fixture,零外部网络:
 * - 本地 bare 仓库 ×2 + GIT_CONFIG_GLOBAL `insteadOf` 重写:installSkill 收到
 * https URL(通过生产校验),git clone 实际命中本地 bare 仓库(每远端独立推进,
 * 互不污染——共享裸仓库会让多技能 behind 判定耦合)。
 * - clone 成功注册元数据(frontmatter name 优先 / 目录名回退 / 原子写)
 * - URL 非法(file://、git@、非 https、无 host)→ invalid-git-url
 * - 目标已存在 → skill-exists;非技能仓库 → trash 回滚 + not-a-skill
 * - behind/dirty 判定(远端推进 + fetch → behind;改文件 → dirty)
 * - updateAll:ff-only pull 成功 / dirty 跳过(「本地已修改，跳过」)
 * - 网络失败(127.0.0.1 拒连端口)→ clone-failed
 * - skill-installs.json 损坏回退 {};无 *.tmp 残留(原子写)
 *
 * electron mock:app.getPath('userData') 定位 skill-installs.json。
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

/** child_process 可切换 mock：git-unavailable 测试注入 ENOENT，其余测试直通真实 execFile。 */
const childProcMock = vi.hoisted(() => ({ failWith: null as null | 'enoent' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      opts: unknown,
      cb?: (err: unknown, stdout?: unknown, stderr?: unknown) => void,
    ) => {
      if (childProcMock.failWith === 'enoent') {
        const e = new Error('spawn git ENOENT');
        (e as NodeJS.ErrnoException).code = 'ENOENT';
        if (cb) cb(e);
        return undefined;
      }
      // 真实 execFile 的 custom promisify resolve {stdout, stderr};通用 promisify
      // 只透传首个值——这里打包成同形状,保住生产代码的 `const { stdout }` 解构。
      return (
        actual.execFile as (
          c: string,
          a: string[],
          o: unknown,
          f?: (err: unknown, stdout?: string, stderr?: string) => void,
        ) => unknown
      )(cmd, args, opts, (err, stdout, stderr) => {
        cb?.(err, { stdout, stderr });
      });
    },
  };
});

import { shell } from 'electron';

/** git 直调(测试夹具用;生产代码走 execFile 收敛为 Result)。 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const COMMIT_IDENTITY = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

function unwrap<T>(res: Result<T>): T {
  if (res.isErr()) throw new Error(`unexpected err: ${res.error.code}: ${res.error.message}`);
  return res.value;
}

/** SKILL.md(可指定 frontmatter name,验证 name 口径)。 */
function writeSkillMd(dir: string, fmName?: string, body = 'body\n'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${fmName ? `name: ${fmName}\n` : ''}description: 测试技能\n---\n\n${body}`,
    'utf8',
  );
}

describe('skills-git(install / statuses / updateAll)', () => {
  let home: string;
  let collectionRoot: string;
  /** 本地 remotes 目录:insteadOf 基地址(https://github.com/lorra-test/ → 本地)。 */
  let remotesDir: string;
  /** 假 GitHub 基地址(经 insteadOf 重写 → remotesDir)。 */
  const FAKE_BASE = 'https://github.com/lorra-test/';

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-git-'));
    collectionRoot = path.join(home, 'collection');
    mkdirSync(collectionRoot, { recursive: true });
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-git-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    // 本地 remotes 目录 + GIT_CONFIG_GLOBAL insteadOf:
    // https://github.com/lorra-test/<ns>/<repo>.git → <remotesDir>/<ns>/<repo>.git
    // (insteadOf 是前缀替换,基地址必须以 / 结尾才能拼接 repo 名)。
    remotesDir = path.join(home, 'remotes');
    mkdirSync(remotesDir, { recursive: true });
    const globalCfg = path.join(home, 'gitconfig');
    writeFileSync(
      globalCfg,
      `[url "${remotesDir.replace(/\\/g, '/')}/"]\n\tinsteadOf = ${FAKE_BASE}\n`,
      'utf8',
    );
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalCfg);
    // trash 模拟真实回收站语义:实际删除目标(回滚/清理断言依赖它)。
    (shell.trashItem as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
      rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    childProcMock.failWith = null;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  /** 建一个本地 bare 远端(remotes/<ns>/<repo>.git)。 */
  function makeBare(ns: string, repo: string): string {
    const bare = path.join(remotesDir, ns, `${repo}.git`);
    git(['init', '--bare', '-q', bare], remotesDir);
    return bare;
  }

  /** 向 bare 远端播种一次提交(SKILL.md 内容 body)。 */
  function seedRemote(bare: string, dirName: string, body = 'v1\n', fmName?: string): void {
    const work = path.join(home, `seed-${dirName}`);
    git(['clone', '-q', bare, work], home);
    writeSkillMd(work, fmName, body);
    git(['add', '-A'], work);
    git([...COMMIT_IDENTITY, 'commit', '-q', '-m', 'seed'], work);
    git(['push', '-q', 'origin', 'HEAD'], work);
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }

  /** 在 bare 远端追加一次提交(推进 HEAD,供 behind 判定)。 */
  function advanceRemote(bare: string, body: string): void {
    const work = path.join(home, `advance-${path.basename(bare)}`);
    git(['clone', '-q', bare, work], home);
    writeFileSync(path.join(work, 'SKILL.md'), body, 'utf8');
    git(['add', '-A'], work);
    git([...COMMIT_IDENTITY, 'commit', '-q', '-m', 'advance'], work);
    git(['push', '-q', 'origin', 'HEAD'], work);
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }

  const fakeUrl = (ns: string, dirName: string): string => `${FAKE_BASE}${ns}/${dirName}.git`;

  // ---------------------------------------------------------------------
  // installSkill
  // ---------------------------------------------------------------------

  it('Scenario 安装成功:clone --depth 1 + 元数据注册(frontmatter name 优先)+ 原子写', async () => {
    const bare = makeBare('a', 'my-skill');
    seedRemote(bare, 'my-skill', 'v1\n', 'custom-name');

    const res = await installSkill(fakeUrl('a', 'my-skill'), collectionRoot);
    expect(res.isOk()).toBe(true);
    const result = unwrap(res) as InstallResult;
    // name = frontmatter name(非目录名);path = 收集根下目录。
    expect(result.name).toBe('custom-name');
    expect(result.path).toBe(path.join(collectionRoot, 'my-skill'));
    expect(existsSync(path.join(collectionRoot, 'my-skill', 'SKILL.md'))).toBe(true);

    // skill-installs.json 注册(name → { gitUrl, installedAt })。
    const reg = JSON.parse(
      await readFile(path.join(electronMock.userData, 'skill-installs.json'), 'utf8'),
    ) as Record<string, { gitUrl: string; installedAt: number }>;
    expect(reg['custom-name'].gitUrl).toBe(fakeUrl('a', 'my-skill'));
    expect(typeof reg['custom-name'].installedAt).toBe('number');
    // 原子写:无 *.tmp 残留。
    const leftovers = readdirSync(electronMock.userData).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('Scenario name 回退:无 frontmatter name → 目录名', async () => {
    const bare = makeBare('a', 'no-name-skill');
    seedRemote(bare, 'no-name-skill');
    const result = unwrap(await installSkill(fakeUrl('a', 'no-name-skill'), collectionRoot));
    expect(result.name).toBe('no-name-skill');
  });
  it('Scenario URL 非法:file://、git@、非 https、无 host → invalid-git-url', async () => {
    for (const bad of [
      `file://${path.join(remotesDir, 'x.git').replace(/\\/g, '/')}`,
      'git@github.com:x/y.git',
      'ftp://github.com/x/y.git',
      'https://',
      'not-a-url',
      // 规格契约「不含 file:」:https 前缀下的 file: 子串混入同样拒绝。
      'https://example.com/file:evil',
    ]) {
      const res = await installSkill(bad, collectionRoot);
      expect(res.isErr()).toBe(true);
      if (res.isErr()) {
        expect(res.error.code).toBe('invalid-git-url');
        expect(res.error.message).toContain('https');
      }
    }
  });

  it('Scenario 目标已存在 → skill-exists「同名技能已存在」', async () => {
    const bare = makeBare('a', 'my-skill');
    seedRemote(bare, 'my-skill');
    unwrap(await installSkill(fakeUrl('a', 'my-skill'), collectionRoot));

    const res = await installSkill(fakeUrl('a', 'my-skill'), collectionRoot);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('skill-exists');
      expect(res.error.message).toContain('同名技能已存在');
    }
  });

  it('Scenario 非技能仓库:trash 回滚 + not-a-skill「缺少 SKILL.md」', async () => {
    // bare 里放一个无任何技能内容的仓库(无 SKILL.md、根下也无 .md——README.md
    // 会被发现语义当作平铺技能,故用 .txt 构造「真非技能」)。
    const bare = makeBare('a', 'not-skill');
    const work = path.join(home, 'seed-notskill');
    git(['clone', '-q', bare, work], home);
    writeFileSync(path.join(work, 'notes.txt'), 'not a skill\n', 'utf8');
    git(['add', '-A'], work);
    git([...COMMIT_IDENTITY, 'commit', '-q', '-m', 'readme'], work);
    git(['push', '-q', 'origin', 'HEAD'], work);
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });

    const res = await installSkill(fakeUrl('a', 'not-skill'), collectionRoot);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('not-a-skill');
      expect(res.error.message).toContain('缺少 SKILL.md');
    }
    // 回滚:克隆产物已进回收站,收集根干净。
    expect(shell.trashItem).toHaveBeenCalledWith(path.join(collectionRoot, 'not-skill'));
    expect(existsSync(path.join(collectionRoot, 'not-skill'))).toBe(false);
  });

  it('Scenario 网络失败(拒连)→ clone-failed「安装失败」', async () => {
    const res = await installSkill('https://127.0.0.1:1/no-such.git', collectionRoot);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('clone-failed');
      expect(res.error.message).toContain('安装失败');
    }
  });

  it('Scenario skill-installs.json 损坏 → 回退空表,安装后重写为合法 JSON', async () => {
    const bare = makeBare('a', 'my-skill');
    seedRemote(bare, 'my-skill');
    writeFileSync(path.join(electronMock.userData, 'skill-installs.json'), '{corrupt!!', 'utf8');

    const res = await installSkill(fakeUrl('a', 'my-skill'), collectionRoot);
    expect(res.isOk()).toBe(true);
    const reg = JSON.parse(
      await readFile(path.join(electronMock.userData, 'skill-installs.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(reg['my-skill']).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // getGitStatuses(behind / dirty)
  // ---------------------------------------------------------------------

  it('Scenario behind/dirty 判定:远端推进+fetch → behind=true;改文件 → dirty=true', async () => {
    const bare = makeBare('a', 'git-skill');
    seedRemote(bare, 'git-skill', 'v1\n');
    unwrap(await installSkill(fakeUrl('a', 'git-skill'), collectionRoot));
    const dir = path.join(collectionRoot, 'git-skill');

    // 初始:clean + 不 behind;gitUrl = remote.origin.url(重写后的本地路径)。
    let statuses = unwrap(await getGitStatuses(collectionRoot));
    expect(statuses['git-skill']?.gitUrl).toContain('git-skill.git');
    expect(statuses['git-skill']?.behind).toBe(false);
    expect(statuses['git-skill']?.dirty).toBe(false);

    // 本地改文件 → dirty。
    writeFileSync(path.join(dir, 'SKILL.md'), 'dirty edit\n', 'utf8');
    statuses = unwrap(await getGitStatuses(collectionRoot));
    expect(statuses['git-skill']?.dirty).toBe(true);

    // 还原 + 远端推进 → behind(本地缓存引用 HEAD..@{u} 经 fetch 更新)。
    git(['checkout', '--', '.'], dir);
    advanceRemote(bare, 'v2\n');
    statuses = unwrap(await getGitStatuses(collectionRoot));
    expect(statuses['git-skill']?.behind).toBe(true);
    expect(statuses['git-skill']?.dirty).toBe(false);
  }, 60000);

  it('Scenario 无 git 技能 → 空状态表', async () => {
    expect(unwrap(await getGitStatuses(collectionRoot))).toEqual({});
  });

  // ---------------------------------------------------------------------
  // updateAll(ff-only pull / dirty 跳过)
  // ---------------------------------------------------------------------

  it('Scenario updateAll:dirty 跳过「本地已修改」,非 dirty → pull --ff-only 成功且工作树含新 commit', async () => {
    const bareA = makeBare('a', 'up-a');
    const bareB = makeBare('b', 'up-b');
    seedRemote(bareA, 'up-a', 'v1\n');
    seedRemote(bareB, 'up-b', 'v1\n');
    unwrap(await installSkill(fakeUrl('a', 'up-a'), collectionRoot));
    unwrap(await installSkill(fakeUrl('b', 'up-b'), collectionRoot));
    // 两个远端各自推进。
    advanceRemote(bareA, 'v2-up-a\n');
    advanceRemote(bareB, 'v2-up-b\n');

    // up-b 本地改脏 → 跳过。
    writeFileSync(path.join(collectionRoot, 'up-b', 'SKILL.md'), 'local edit\n', 'utf8');

    const result = unwrap(await updateAll(collectionRoot));
    expect(result.updated).toEqual(['up-a']);
    expect(result.skipped.some((s) => s.includes('up-b') && s.includes('本地已修改'))).toBe(true);

    // 工作树含新 commit 内容。
    expect(
      (await readFile(path.join(collectionRoot, 'up-a', 'SKILL.md'), 'utf8')).includes('v2-up-a'),
    ).toBe(true);
    // 更新后 behind 清空。
    const statuses = unwrap(await getGitStatuses(collectionRoot));
    expect(statuses['up-a']?.behind).toBe(false);
  }, 60000);

  it('Scenario 无 git 技能 → 空更新结果', async () => {
    const result = unwrap(await updateAll(collectionRoot));
    expect(result).toEqual({ updated: [], skipped: [] });
  });

  // ---------------------------------------------------------------------
  // git CLI 缺失降级(R5:不崩、页面隐藏 git 列)
  // ---------------------------------------------------------------------

  it('Scenario git CLI 缺失(ENOENT)→ install git-unavailable;checkUpdates 空表降级;updateAll 直通', async () => {
    childProcMock.failWith = 'enoent';

    // installSkill → git-unavailable(PM 语域文案)。
    const inst = await installSkill(fakeUrl('a', 'git-skill'), collectionRoot);
    expect(inst.isErr()).toBe(true);
    if (inst.isErr()) {
      expect(inst.error.code).toBe('git-unavailable');
      expect(inst.error.message).toContain('未检测到 git');
    }

    // checkUpdates 底层 getGitStatuses → 空表降级(页面 git 列整体隐藏)。
    const statuses = unwrap(await getGitStatuses(collectionRoot));
    expect(statuses).toEqual({});

    // updateAll → git-unavailable 直通。
    const up = await updateAll(collectionRoot);
    expect(up.isErr()).toBe(true);
    if (up.isErr()) {
      expect(up.error.code).toBe('git-unavailable');
    }
  });
});
