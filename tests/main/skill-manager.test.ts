import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanDangling,
  getSkillXray,
  isDanglingLink,
  resolveWorkspacePath,
  scanDanglingLinks,
  setSkillEnabled,
  setWorkspaceEnabled,
  unlinkDangling,
} from '../../src/main/skills/skill-manager';
import { SYSTEM_MANAGED_SKILL_NAMES, scanSkills } from '../../src/main/skills/skills-store';
import { readSettings, writeSettings } from '../../src/main/workspace/settings';
import type { Result } from '../../src/shared/result';
import { SKILL_TOKEN_ESTIMATE_DIVISOR } from '../../src/shared/skills-api';

/**
 * 技能管理 V1-4 服务层测试（TDD）：
 * - setSkillEnabled：加入/移除 disabledSkills + writeSettings 持久化往返 / 不存在 name
 * / 系统种子拒绝（三种子逐个）/ 幂等 / 非法 name
 * - scanDanglingLinks：真实悬空 junction（lstat 判定，目标 stat ENOENT）/ 正常链接与
 * 实体目录不计 / 深层嵌套 + 循环链 fixture 不卡死（visited 集合拦下）
 * - cleanDangling：清 N 个返回 cleaned=N + 文件系统确认链接已删 / 实体目录保留
 * / 无悬空返回 0 / 部分失败（posix 只读目录模拟；win32 平台不支持 → skip guard）
 * - resolveWorkspacePath：存在路径返回 realpath / 不存在报错 / 未传时回退
 * recentWorkspaces 首个（参照 workspace/ipc.ts 的当前工作区口径）
 *
 * electron mock 照 skills-override.test.ts 先例：settings.ts 走 app.getPath('userData')
 * 定位 settings.json，userData 每测试指向临时目录；os.homedir 用 spy 注入临时 home
 * （skill-manager 内部 scanSkills(ws) 不传 homedir，靠 spy 兜住；~/.lorra 经
 * LORRA_E2E_USERDATA 指向临时目录，测试永不触达真实 home）。
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

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function unwrap<T>(res: Result<T>): T {
  if (res.isErr()) throw new Error(`unexpected err: ${res.error.code}: ${res.error.message}`);
  return res.value;
}

/** 在 <ws>/.lorra/skills/<name>/SKILL.md 建一个可被发现的技能。 */
function writeWorkspaceSkill(ws: string, name: string, description: string): void {
  const dir = path.join(ws, '.lorra', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    'utf8',
  );
}

/** 写任意技能文件（frontmatter 键值 → YAML 行；字符串值原样，布尔/数字按标量）。 */
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

/**
 * 建悬空链接（win32 junction / posix symlink，target 可不存在）。
 * 平台不支持 → 返回 false（调用方 skip guard，照 skills-store.test.ts 断链先例）。
 */
function makeDanglingLink(parent: string, name: string, target: string): boolean {
  mkdirSync(parent, { recursive: true });
  try {
    if (process.platform === 'win32') symlinkSync(target, path.join(parent, name), 'junction');
    else symlinkSync(target, path.join(parent, name));
    return true;
  } catch {
    return false;
  }
}

/** 断言路径已不存在（链接已删：lstat 抛 ENOENT 且 existsSync 为 false）。 */
function expectPathGone(p: string): void {
  expect(existsSync(p)).toBe(false);
  expect(() => lstatSync(p)).toThrow();
}

// ---------------------------------------------------------------------------
// resolveWorkspacePath
// ---------------------------------------------------------------------------

describe('resolveWorkspacePath（realpath 校验 + 当前工作区回退）', () => {
  let home: string;
  let ws: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-ws-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('存在路径 → ok(realpath)', async () => {
    const res = await resolveWorkspacePath(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toBe(realpathSync(ws));
  });

  it('不存在路径 → err invalid-workspace-path（PM 语域文案）', async () => {
    const res = await resolveWorkspacePath(path.join(home, 'no-such-ws'));
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('invalid-workspace-path');
      expect(res.error.message).toContain('工作区路径无效');
    }
  });

  it('未传 wsPath 且 recentWorkspaces 为空 → err no-active-workspace', async () => {
    const res = await resolveWorkspacePath();
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('no-active-workspace');
      expect(res.error.message).toContain('工作区');
    }
  });

  it('未传 wsPath → 回退 recentWorkspaces 首个（workspace/ipc.ts 同口径）', async () => {
    await writeSettings({ recentWorkspaces: [ws] });
    const res = await resolveWorkspacePath();
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toBe(realpathSync(ws));
  });
});

// ---------------------------------------------------------------------------
// setSkillEnabled
// ---------------------------------------------------------------------------

describe('setSkillEnabled（全局启停 / 软禁用名单持久化）', () => {
  let home: string;
  let ws: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-enable-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-enable-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await writeSettings({ recentWorkspaces: [ws] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('disable → disabledSkills 加入该 name，writeSettings 持久化往返（重启读回）', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');

    const res = await setSkillEnabled('alpha', false);
    expect(res.isOk()).toBe(true);

    // 持久化往返：readSettings 每次从磁盘全量重读，等价「重启读回」。
    expect((await readSettings()).disabledSkills).toEqual(['alpha']);
    // 落盘实锤：直接读 settings.json 原文（AppSettings.disabledSkills 键）。
    const raw = JSON.parse(
      await readFile(path.join(electronMock.userData, 'settings.json'), 'utf8'),
    ) as { disabledSkills?: string[] };
    expect(raw.disabledSkills).toEqual(['alpha']);
    // 技能仍属发现集合（本次启停的 name 校验来自发现集合）。
    const scan = unwrap(await scanSkills(ws, { homedir: home }));
    expect(scan.skills.map((s) => s.name)).toContain('alpha');
  });

  it('enable → 从 disabledSkills 移除，重新生效', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');
    unwrap(await setSkillEnabled('alpha', false));
    expect((await readSettings()).disabledSkills).toEqual(['alpha']);

    const res = await setSkillEnabled('alpha', true);
    expect(res.isOk()).toBe(true);
    expect((await readSettings()).disabledSkills).toEqual([]);
    const scan = unwrap(await scanSkills(ws, { homedir: home }));
    expect(scan.skills.find((s) => s.name === 'alpha')?.enabled).toBe(true);
  });

  it('name 不在本次发现集合 → err skill-not-found，名单不变', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');

    const res = await setSkillEnabled('no-such-skill', false);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('skill-not-found');
      expect(res.error.message).toContain('技能不存在');
    }
    expect((await readSettings()).disabledSkills ?? []).toEqual([]);
  });

  it('系统管理种子逐个拒绝（memory-maintenance / daily-review / deep-review）', async () => {
    for (const name of SYSTEM_MANAGED_SKILL_NAMES) {
      const res = await setSkillEnabled(name, false);
      expect(res.isErr()).toBe(true);
      if (res.isErr()) {
        expect(res.error.code).toBe('system-managed-skill');
        expect(res.error.message).toContain('系统管理');
      }
    }
    expect((await readSettings()).disabledSkills ?? []).toEqual([]);
  });

  it('幂等：重复 disable 不重复入列', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');

    unwrap(await setSkillEnabled('alpha', false, { wsPath: ws }));
    unwrap(await setSkillEnabled('alpha', false, { wsPath: ws }));

    const disabled = (await readSettings()).disabledSkills ?? [];
    expect(disabled).toEqual(['alpha']);
    expect(disabled.filter((n) => n === 'alpha')).toHaveLength(1);
  });

  it('非法 name（空串）→ err invalid-skill-name', async () => {
    const res = await setSkillEnabled('', false);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('invalid-skill-name');
  });
});

// ---------------------------------------------------------------------------
// scanDanglingLinks
// ---------------------------------------------------------------------------

describe('scanDanglingLinks（lstat 判定，不跟随）', () => {
  let home: string;
  let ws: string;
  let skillsDir: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-scan-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    skillsDir = path.join(ws, '.lorra', 'skills');
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('实体目录、实体文件、正常链接（目标存在）都不计 → 空清单', async () => {
    mkdirSync(path.join(skillsDir, 'real-dir'), { recursive: true });
    writeFileSync(path.join(skillsDir, 'real-dir', 'note.md'), 'x', 'utf8');
    writeFileSync(path.join(skillsDir, 'flat.md'), 'y', 'utf8');
    // 指向真实目录的 junction（激活态技能）→ 正常链接，不计。
    symlinkSync(path.join(skillsDir, 'real-dir'), path.join(skillsDir, 'valid-jn'), 'junction');

    const res = await scanDanglingLinks(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toEqual([]);
  });

  it('真实悬空 junction → 记入悬空清单（相对路径）', async () => {
    const ok = makeDanglingLink(skillsDir, 'ghost', path.join(home, 'gone-target'));
    if (!ok) return; // 平台不支持断链创建 → 跳过（本机 junction 支持，正常会跑到）。

    const res = await scanDanglingLinks(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toEqual(['ghost']);
  });

  it('深层嵌套悬空被找到；指向自身的有效循环 junction 不卡死、不计入', async () => {
    const nested = path.join(skillsDir, 'a', 'b', 'c');
    const ok = makeDanglingLink(nested, 'ghost', path.join(home, 'gone-target'));
    if (!ok) return;
    // 有效循环：skills/loop → skills（目标存在；不跟随 → 不递归、不卡死）。
    symlinkSync(skillsDir, path.join(skillsDir, 'loop'), 'junction');

    const res = await scanDanglingLinks(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      // 相对路径统一 / 分隔符（win32 反斜杠归一）。
      expect(res.value).toEqual(['a/b/c/ghost']);
    }
  });

  it('断链 symlink 环 a→b→a：visited 集合拦下，不卡死（核心契约 = 遍历终止）', async () => {
    const a = path.join(skillsDir, 'a');
    const b = path.join(skillsDir, 'b');
    mkdirSync(skillsDir, { recursive: true });
    let ok = true;
    try {
      if (process.platform === 'win32') {
        symlinkSync(b, a, 'junction');
        symlinkSync(a, b, 'junction');
      } else {
        symlinkSync('b', a);
        symlinkSync('a', b);
      }
    } catch {
      ok = false;
    }
    if (!ok) return; // 平台不支持 → 跳过。

    // 环内链接 stat 失败为 ELOOP（win32 junction 环实测）而非 ENOENT → 不判悬空；
    // 扫描不跟随链接，visited/深度只是双保险。断言 = 遍历正常终止（超时即失败）。
    const res = await scanDanglingLinks(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      expect(res.value.every((p) => p === 'a' || p === 'b')).toBe(true);
    }
  });

  it('.lorra/skills 目录不存在 → 空清单', async () => {
    const res = await scanDanglingLinks(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cleanDangling
// ---------------------------------------------------------------------------

describe('cleanDangling（只 unlink 悬空链接，不删实体）', () => {
  let home: string;
  let ws: string;
  let skillsDir: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-clean-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    skillsDir = path.join(ws, '.lorra', 'skills');
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('清 2 个悬空 → cleaned=2，文件系统确认链接已删', async () => {
    const ok1 = makeDanglingLink(skillsDir, 'g1', path.join(home, 'gone-1'));
    const ok2 = makeDanglingLink(skillsDir, 'g2', path.join(home, 'gone-2'));
    if (!ok1 || !ok2) return;

    const res = await cleanDangling(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toEqual({ cleaned: 2 });
    expectPathGone(path.join(skillsDir, 'g1'));
    expectPathGone(path.join(skillsDir, 'g2'));
  });

  it('实体目录与实体文件在清单外，永不被删', async () => {
    mkdirSync(path.join(skillsDir, 'real-dir'), { recursive: true });
    writeFileSync(path.join(skillsDir, 'real-dir', 'note.md'), 'keep', 'utf8');
    writeFileSync(path.join(skillsDir, 'flat.md'), 'keep', 'utf8');
    const ok = makeDanglingLink(skillsDir, 'ghost', path.join(home, 'gone-target'));
    if (!ok) return;

    const res = await cleanDangling(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toEqual({ cleaned: 1 });
    expect(existsSync(path.join(skillsDir, 'real-dir'))).toBe(true);
    expect(existsSync(path.join(skillsDir, 'real-dir', 'note.md'))).toBe(true);
    expect(existsSync(path.join(skillsDir, 'flat.md'))).toBe(true);
    expectPathGone(path.join(skillsDir, 'ghost'));
  });

  it('无悬空 → cleaned=0', async () => {
    mkdirSync(path.join(skillsDir, 'real-dir'), { recursive: true });
    const res = await cleanDangling(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toEqual({ cleaned: 0 });
    expect(existsSync(path.join(skillsDir, 'real-dir'))).toBe(true);
  });
});

/** 会话条目（扁平 cwd 字段，skill-stats.test.ts 同款实证形状）。 */
function sessionLine(cwd: string): string {
  return JSON.stringify({ type: 'session', version: 3, id: 'sess', cwd });
}

/** read 工具块（toolCall 当前形状）。 */
function readToolBlock(target: string): Record<string, unknown> {
  return { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: target } };
}

/** assistant message 条目（含触发时刻 timestamp）。 */
function msgLine(id: string, tsMs: number, blocks: Record<string, unknown>[]): string {
  return JSON.stringify({
    type: 'message',
    id,
    timestamp: new Date(tsMs).toISOString(),
    message: { role: 'assistant', content: blocks },
  });
}

/** 写 <userData>/.lorra/sessions/<relDir>/<file>.jsonl（sessions 在 lorraConfigDir 下）。 */
function writeSession(userData: string, relDir: string, file: string, content: string): void {
  const dir = path.join(userData, '.lorra', 'sessions', relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), `${content}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// getSkillXray（xray 组装：skills + stats + budget + dangling + workspacePath）
// ---------------------------------------------------------------------------

describe('getSkillXray（一次拉全量）', () => {
  let home: string;
  let ws: string;
  let wsReal: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-xray-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    wsReal = realpathSync(ws);
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-xray-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('全链路组装：skills/stats 命中/budget/dangling/workspacePath 一次拉全', async () => {
    // 三源技能：工作区（目录形）+ 用户源（平铺）。
    writeWorkspaceSkill(ws, 'ws-skill', '工作区技能描述');
    writeSkill(path.join(home, '.agents', 'skills', 'user-skill.md'), {
      name: 'user-skill',
      description: '用户技能描述',
    });
    // 悬空 junction（当前工作区作用域）。
    const okDang = makeDanglingLink(
      path.join(ws, '.lorra', 'skills'),
      'ghost',
      path.join(home, 'gone'),
    );
    expect(okDang).toBe(true);
    // 会话 jsonl：read 命中 ws-skill（触发时刻在 45 天窗口内）。
    const hitAt = Date.now() - 60_000;
    writeSession(
      home,
      'xray',
      's1.jsonl',
      [
        sessionLine(wsReal),
        msgLine('m1', hitAt, [
          readToolBlock(path.join(wsReal, '.lorra', 'skills', 'ws-skill', 'SKILL.md')),
        ]),
      ].join('\n'),
    );

    const res = await getSkillXray(ws);
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) throw new Error(`getSkillXray failed: ${res.error.message}`);

    const xray = res.value;
    // workspacePath = realpath。
    expect(xray.workspacePath).toBe(wsReal);
    // skills 数组（两源各一条，无同名碰撞）。
    expect(xray.skills.map((s) => s.name).sort()).toEqual(['user-skill', 'ws-skill']);
    // stats：ws-skill 命中 1 次（会话 cwd 归桶）；user-skill 从未使用。
    expect(xray.stats['ws-skill']).toEqual({
      totalCount: 1,
      recentCount: 1,
      lastUsedAt: hitAt,
      byWorkspace: { [wsReal]: 1 },
    });
    expect(xray.stats['user-skill']).toEqual({
      totalCount: 0,
      recentCount: 0,
      lastUsedAt: null,
      byWorkspace: {},
    });
    // dangling：悬空 junction 在清单（当前工作区作用域）。
    expect(xray.dangling).toEqual(['ghost']);
    // budget：两技能均启用（小描述 → good 档）。
    expect(xray.budget.enabledCount).toBe(2);
    expect(xray.budget.status).toBe('good');
    expect(xray.budget.estimatedTokens).toBe(
      Math.round(('工作区技能描述'.length + '用户技能描述'.length) / SKILL_TOKEN_ESTIMATE_DIVISOR),
    );
  });

  it('预算三级边界：≤2000 good / ≤4000 warn / >4000 over（description 字符 ÷3.5 换算）', async () => {
    const descFile = path.join(home, '.agents', 'skills', 'boundary.md');
    mkdirSync(path.dirname(descFile), { recursive: true });
    // 2,000 tokens = 7,000 字符；2,001 = 7,004 字符（round 边界）；4,001 = 14,004 字符。
    const cases: Array<{ chars: number; expectedTokens: number; expectedStatus: string }> = [
      { chars: 7000, expectedTokens: 2000, expectedStatus: 'good' },
      { chars: 7004, expectedTokens: 2001, expectedStatus: 'warn' },
      { chars: 14004, expectedTokens: 4001, expectedStatus: 'over' },
    ];
    for (const c of cases) {
      writeSkill(descFile, { name: 'boundary', description: 'b'.repeat(c.chars) });
      const xray = unwrap(await getSkillXray(ws));
      expect(xray.budget.charSum).toBe(c.chars);
      expect(xray.budget.estimatedTokens).toBe(c.expectedTokens);
      expect(xray.budget.status).toBe(c.expectedStatus);
    }
  });

  it('系统管理种子：灰标「内部·未注入」，不进预算（enabledCount/charSum 排除）', async () => {
    writeWorkspaceSkill(ws, 'ws-skill', '工作区技能描述');
    writeSkill(path.join(home, '.agents', 'skills', 'memory-maintenance', 'SKILL.md'), {
      name: 'memory-maintenance',
      description: 'm'.repeat(100),
    });

    const xray = unwrap(await getSkillXray(ws));
    const seed = xray.skills.find((s) => s.name === 'memory-maintenance');
    expect(seed).toBeDefined();
    expect(seed?.systemManaged).toBe(true);
    expect(seed?.enabled).toBe(false);
    // 预算只算启用且非 systemManaged：仅 ws-skill。
    expect(xray.budget.enabledCount).toBe(1);
    expect(xray.budget.charSum).toBe('工作区技能描述'.length);
  });

  it('disabledSkills 剔除：enabled=false 且不进预算（名单来自 readSettings）', async () => {
    writeWorkspaceSkill(ws, 'ws-skill', '工作区技能描述');
    writeSkill(path.join(home, '.agents', 'skills', 'user-skill.md'), {
      name: 'user-skill',
      description: 'u'.repeat(300),
    });
    // 先落盘禁用名单，getSkillXray 从 readSettings 读取。
    await writeSettings({ recentWorkspaces: [ws], disabledSkills: ['user-skill'] });

    const xray = unwrap(await getSkillXray(ws));
    const user = xray.skills.find((s) => s.name === 'user-skill');
    expect(user?.enabled).toBe(false);
    expect(xray.skills.find((s) => s.name === 'ws-skill')?.enabled).toBe(true);
    expect(xray.budget.enabledCount).toBe(1);
    expect(xray.budget.charSum).toBe('工作区技能描述'.length);
  });
});

// ---------------------------------------------------------------------------
// setWorkspaceEnabled(2026-08-13 批:按工作区停用,newmax 式)
// ---------------------------------------------------------------------------

describe('setWorkspaceEnabled(按工作区停用名单)', () => {
  let home: string;
  let ws: string;
  let wsReal: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-wsen-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    wsReal = realpathSync(ws);
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-wsen-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await writeSettings({ recentWorkspaces: [ws] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('停用 → workspaceSkillOverrides[wsRealpath] 加入该 name,持久化往返(重启读回)', async () => {
    const res = await setWorkspaceEnabled('alpha', false);
    expect(res.isOk()).toBe(true);
    const settings = await readSettings();
    expect(settings.workspaceSkillOverrides?.[wsReal]).toEqual(['alpha']);
    // 落盘实锤:直接读 settings.json 原文。
    const raw = JSON.parse(
      await readFile(path.join(electronMock.userData, 'settings.json'), 'utf8'),
    ) as { workspaceSkillOverrides?: Record<string, string[]> };
    expect(raw.workspaceSkillOverrides?.[wsReal]).toEqual(['alpha']);
  });

  it('启用 → 从名单移除;不存在时为空操作成功', async () => {
    unwrap(await setWorkspaceEnabled('alpha', false, ws));
    const res = await setWorkspaceEnabled('alpha', true, ws);
    expect(res.isOk()).toBe(true);
    expect((await readSettings()).workspaceSkillOverrides?.[wsReal]).toEqual([]);

    // 不在名单 → 空操作成功。
    const noop = await setWorkspaceEnabled('never-in-list', true, ws);
    expect(noop.isOk()).toBe(true);
  });

  it('系统管理种子逐个拒绝(system-managed-skill),名单不变', async () => {
    for (const name of SYSTEM_MANAGED_SKILL_NAMES) {
      const res = await setWorkspaceEnabled(name, false, ws);
      expect(res.isErr()).toBe(true);
      if (res.isErr()) {
        expect(res.error.code).toBe('system-managed-skill');
        expect(res.error.message).toContain('系统管理');
      }
    }
    expect((await readSettings()).workspaceSkillOverrides ?? {}).toEqual({});
  });

  it('非法 name(空串)→ invalid-skill-name;非法 wsPath → invalid-workspace-path', async () => {
    const badName = await setWorkspaceEnabled('', false, ws);
    expect(badName.isErr()).toBe(true);
    if (badName.isErr()) expect(badName.error.code).toBe('invalid-skill-name');
    const badWs = await setWorkspaceEnabled('alpha', false, path.join(home, 'no-such'));
    expect(badWs.isErr()).toBe(true);
    if (badWs.isErr()) expect(badWs.error.code).toBe('invalid-workspace-path');
  });
});

// ---------------------------------------------------------------------------
// getSkillXray 扩展(2026-08-13 批:disabledInWs/globallyHidden/gitStatus/collectionRoot)
// ---------------------------------------------------------------------------

describe('getSkillXray 扩展(按工作区停用 / 全局隐藏 / git 状态 / 收集根)', () => {
  let home: string;
  let ws: string;
  let wsReal: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-xray2-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    wsReal = realpathSync(ws);
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-xray2-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('disabledInWs/globallyHidden 真值刷入 + 预算排除 ws 停用技能 + collectionRoot 透出', async () => {
    writeWorkspaceSkill(ws, 'ws-skill', '工作区技能描述');
    writeSkill(path.join(home, '.agents', 'skills', 'user-skill.md'), {
      name: 'user-skill',
      description: 'u'.repeat(300),
    });
    await writeSettings({
      recentWorkspaces: [ws],
      disabledSkills: ['user-skill'],
      workspaceSkillOverrides: { [wsReal]: ['ws-skill'] },
    });

    const xray = unwrap(await getSkillXray(ws));
    const wsSkill = xray.skills.find((s) => s.name === 'ws-skill');
    const userSkill = xray.skills.find((s) => s.name === 'user-skill');
    // 真值刷入:disabledInWs(本工作区停用)/ globallyHidden(全局隐藏名单)。
    expect(wsSkill?.disabledInWs).toBe(true);
    expect(wsSkill?.globallyHidden).toBe(false);
    expect(userSkill?.disabledInWs).toBe(false);
    expect(userSkill?.globallyHidden).toBe(true);
    // 预算排除 = disabledSkills ∪ ws 停用名单 → 两者都不计。
    expect(xray.budget.enabledCount).toBe(0);
    expect(xray.budget.charSum).toBe(0);
    // 默认收集根透出。
    expect(xray.collectionRoot).toBe(path.join(home, '.agents', 'skills'));
    expect(xray.gitStatus).toEqual({});
  });

  it('gitStatus:收集根内真实 git 技能 → 条目存在;dirty 判定走本地 .git 状态', async () => {
    const root = path.join(home, '.agents', 'skills', 'git-skill');
    writeSkill(path.join(root, 'SKILL.md'), { name: 'git-skill', description: 'git 技能' });
    const git = (args: string[], cwd: string): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    };
    git(['init', '-q'], root);
    git(['add', '-A'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], root);

    const clean = unwrap(await getSkillXray(ws));
    expect(clean.gitStatus['git-skill']).toEqual({ gitUrl: '', behind: false, dirty: false });

    // 改文件不提交 → dirty=true。
    writeFileSync(path.join(root, 'SKILL.md'), 'changed\n', 'utf8');
    const dirty = unwrap(await getSkillXray(ws));
    expect(dirty.gitStatus['git-skill']?.dirty).toBe(true);
  });
});

describe('cleanDangling 部分失败（只读目录模拟）', () => {
  let home: string;
  let ws: string;
  let skillsDir: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-mgr-clean-part-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    skillsDir = path.join(ws, '.lorra', 'skills');
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('部分失败：可删的已清、不可删的保留，返回「已清理 X 个，失败 Y 个」', async () => {
    // 只读目录模拟 unlink 失败（目录无写权限 → EACCES）。win32 的目录只读属性
    // 不阻止删除（NTFS ACL 语义），chmod 模拟不可靠 → win32 跳过并在报告说明。
    if (process.platform === 'win32') return;

    const blocked = path.join(skillsDir, 'blocked');
    const ok1 = makeDanglingLink(blocked, 'ghost', path.join(home, 'gone-target'));
    const ok2 = makeDanglingLink(skillsDir, 'ok-ghost', path.join(home, 'gone-target'));
    if (!ok1 || !ok2) return;
    chmodSync(blocked, 0o555);

    const res = await cleanDangling(ws);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('clean-dangling-partial');
      expect(res.error.message).toContain('已清理 1 个悬空链接，失败 1 个');
    }
    // 可删的已删；不可删的保留。
    expectPathGone(path.join(skillsDir, 'ok-ghost'));
    expect(existsSync(path.join(blocked, 'ghost'))).toBe(true);
    chmodSync(blocked, 0o755); // 恢复，保证 afterEach rmSync 干净收尾。
  });
});

// ---------------------------------------------------------------------------
// FM-8 TOCTOU 锁定（2026-08-13 证明批）：悬空判定单一事实源 + 删除前复检。
// unlinkDangling 是全场唯一「永久删除」（不经过回收站）的入口——它的契约是：
// 非悬空路径（实体文件/实体目录/目标已恢复的链接）绝不被 unlink。
// ---------------------------------------------------------------------------

describe('isDanglingLink / unlinkDangling（FM-8 安全锁定契约）', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-fm8-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('悬空链接（目标缺失）→ true', () => {
    const target = path.join(home, 'gone-target');
    const link = path.join(home, 'dangling');
    if (!makeDanglingLink(home, 'dangling', target)) return; // 无链接权限环境跳过
    expect(isDanglingLink(link)).toBe(true);
  });

  it('实体文件 / 实体目录 / 不存在路径 → false', () => {
    writeFileSync(path.join(home, 'plain.txt'), 'valuable', 'utf8');
    mkdirSync(path.join(home, 'plain-dir'), { recursive: true });
    expect(isDanglingLink(path.join(home, 'plain.txt'))).toBe(false);
    expect(isDanglingLink(path.join(home, 'plain-dir'))).toBe(false);
    expect(isDanglingLink(path.join(home, 'no-such'))).toBe(false);
  });

  it('链接目标存在 → false（正常链接）', () => {
    mkdirSync(path.join(home, 'real-target'), { recursive: true });
    if (!makeDanglingLink(home, 'live-link', path.join(home, 'real-target'))) return;
    expect(isDanglingLink(path.join(home, 'live-link'))).toBe(false);
  });

  it('unlinkDangling:悬空链接 → true 且链接已删', () => {
    if (!makeDanglingLink(home, 'dangling', path.join(home, 'gone-target'))) return;
    const link = path.join(home, 'dangling');
    expect(unlinkDangling(link)).toBe(true);
    expectPathGone(link);
  });

  it('unlinkDangling:实体文件 → false 且文件完好（核心安全契约）', () => {
    const p = path.join(home, 'plain.txt');
    writeFileSync(p, 'valuable-data', 'utf8');
    expect(unlinkDangling(p)).toBe(false);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('valuable-data');
  });

  it('unlinkDangling:实体目录 / 目标存在的链接 → false 且原样保留', () => {
    const dir = path.join(home, 'plain-dir');
    mkdirSync(dir, { recursive: true });
    expect(unlinkDangling(dir)).toBe(false);
    expect(existsSync(dir)).toBe(true);

    mkdirSync(path.join(home, 'real-target'), { recursive: true });
    if (!makeDanglingLink(home, 'live-link', path.join(home, 'real-target'))) return;
    expect(unlinkDangling(path.join(home, 'live-link'))).toBe(false);
    expect(existsSync(path.join(home, 'live-link'))).toBe(true);
    expect(existsSync(path.join(home, 'real-target'))).toBe(true);
  });

  it('cleanDangling 全链路仍经复检：实体文件与悬空链接并存 → 只删链接', async () => {
    const ws = path.join(home, 'work');
    const skillsDir = path.join(ws, '.lorra', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-fm8-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await writeSettings({ recentWorkspaces: [ws] });
    if (!makeDanglingLink(skillsDir, 'ghost', path.join(home, 'gone'))) return;
    writeFileSync(path.join(skillsDir, 'keep.txt'), 'keep', 'utf8');

    const res = await cleanDangling(ws);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value.cleaned).toBe(1);
    expectPathGone(path.join(skillsDir, 'ghost'));
    expect(readFileSync(path.join(skillsDir, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
