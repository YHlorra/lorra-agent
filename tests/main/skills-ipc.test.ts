/**
 * 技能管理 IPC 测试(2026-08-12-skill-manager V1-8,TDD)。
 *
 * 规范真源:
 * - (IPC 契约:
 * SerializedResult 信封 / 参数校验语义 / 错误文案 PM 语域,code 留日志)
 * - src/shared/skills-api.ts SKILLS_IPC(通道名单一事实源,逐字断言)
 * - skill-manager.ts 服务层(真实临时目录 + 空/实体技能库,不 mock manager)
 *
 * 环境照 skill-manager.test.ts 先例:electron mock(app.getPath userData →
 * 每测试临时目录,settings.json 落此处)+ ipcMain.handle 捕获(electronMock.handlers)
 * + LORRA_E2E_USERDATA(lorraConfigDir → 临时 home)+ os.homedir spy。
 *
 * 校验语义(D9):
 * - setEnabled:name = 非空字符串(typeof guard,非字符串/空 → invalid-skill-name
 * 「技能名称无效」);enabled = boolean(否则 invalid-enabled)
 * - cleanDangling:wsPath = 非空字符串 → resolveWorkspacePath realpath+存在性
 * (invalid-workspace-path)+ 成员校验 wsPath ∈ realpath(recentWorkspaces)
 * (unknown-workspace「未知工作区」)
 * - xray:wsPath 可选(缺省回退当前工作区),IPC 层类型守卫
 * - manager 错误直通(skill-not-found / system-managed-skill …)
 */

import {
  existsSync,
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

import type { SerializedResult } from '../../src/shared/result';
import { SKILLS_IPC, type SkillXray } from '../../src/shared/skills-api';

const electronMock = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? electronMock.userData : ''),
  },
  shell: {
    trashItem: vi.fn().mockResolvedValue(undefined),
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, fn);
    },
  },
}));

import { registerSkillsIpc } from '../../src/main/ipc/skills-ipc';
import { writeSettings } from '../../src/main/workspace/settings';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

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

/** 建悬空链接(win32 junction / posix symlink,target 可不存在)。 */
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

/** 直接调用已捕获的 handler(模拟 ipcMain.handle 收到 invoke)。 */
async function call<T>(channel: string, args?: unknown): Promise<SerializedResult<T>> {
  const handler = electronMock.handlers.get(channel);
  expect(handler).toBeDefined();
  return (await handler!(null, args)) as SerializedResult<T>;
}

describe('skills-ipc(lorra.skills.*,D9 契约)', () => {
  let home: string;
  let ws: string;
  let wsReal: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-ipc-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    wsReal = realpathSync(ws);
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-ipc-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await writeSettings({ recentWorkspaces: [ws] });
    electronMock.handlers.clear();
    registerSkillsIpc();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  // ---------------------------------------------------------------------
  // 通道注册
  // ---------------------------------------------------------------------

  it('Requirement 通道注册:九通道名与 SKILLS_IPC 常量逐字一致(install 已迁移为会话工具)', () => {
    expect(electronMock.handlers.has(SKILLS_IPC.xray)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.setEnabled)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.cleanDangling)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.collect)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.checkUpdates)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.updateAll)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.setWsEnabled)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.read)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.create)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // xray
  // ---------------------------------------------------------------------

  it('Scenario xray 无参 → 回退当前工作区(recentWorkspaces 首个),返回 SkillXray 全量', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');

    const res = await call<SkillXray>(SKILLS_IPC.xray);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.workspacePath).toBe(wsReal);
    expect(res.value.skills.map((s) => s.name)).toContain('alpha');
    expect(res.value.skills.find((s) => s.name === 'alpha')?.enabled).toBe(true);
    // stats 全技能有记录(空会话库 → 全零);budget 计算;dangling 当前工作区作用域。
    expect(res.value.stats['alpha']).toEqual({
      totalCount: 0,
      recentCount: 0,
      lastUsedAt: null,
      byWorkspace: {},
    });
    expect(res.value.budget.enabledCount).toBeGreaterThan(0);
    expect(res.value.dangling).toEqual([]);
  });

  it('Scenario xray 显式 wsPath → 以该工作区扫描(无需 ∈ recentWorkspaces)', async () => {
    const stranger = mkdtempSync(path.join(tmpdir(), 'lorra-sk-ipc-stranger-'));
    try {
      mkdirSync(path.join(stranger, '.git'), { recursive: true });
      writeWorkspaceSkill(stranger, 'beta', 'beta 描述');

      const res = await call<SkillXray>(SKILLS_IPC.xray, { wsPath: stranger });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.workspacePath).toBe(realpathSync(stranger));
      expect(res.value.skills.map((s) => s.name)).toContain('beta');
    } finally {
      rmSync(stranger, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  it('Scenario xray wsPath 非字符串 → IPC 层校验错误 invalid-workspace-path', async () => {
    const res = await call<SkillXray>(SKILLS_IPC.xray, { wsPath: 123 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-workspace-path');
      expect(res.error.message).toContain('工作区路径无效');
    }
  });

  it('Scenario xray wsPath 不存在 → manager resolveWorkspacePath 错误直通', async () => {
    const res = await call<SkillXray>(SKILLS_IPC.xray, {
      wsPath: path.join(home, 'no-such-ws'),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-workspace-path');
      expect(res.error.message).toContain('工作区路径无效');
    }
  });

  // ---------------------------------------------------------------------
  // setEnabled
  // ---------------------------------------------------------------------

  it('Scenario setEnabled 合法参数 → 名单写入并落盘 settings.json', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');

    const res = await call<void>(SKILLS_IPC.setEnabled, { name: 'alpha', enabled: false });
    expect(res.ok).toBe(true);
    // 落盘实锤:直接读 settings.json 原文。
    const raw = JSON.parse(
      await readFile(path.join(electronMock.userData, 'settings.json'), 'utf8'),
    ) as { disabledSkills?: string[] };
    expect(raw.disabledSkills).toEqual(['alpha']);
  });

  it('Scenario setEnabled name 非字符串 → 校验错误 invalid-skill-name(PM 语域)', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { name: 42, enabled: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-skill-name');
      expect(res.error.message).toContain('技能名称无效');
    }
  });

  it('Scenario setEnabled name 空串 → 校验错误 invalid-skill-name', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { name: '', enabled: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-skill-name');
      expect(res.error.message).toContain('技能名称无效');
    }
  });

  it('Scenario setEnabled name 缺失 → 校验错误', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { enabled: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid-skill-name');
  });

  it('Scenario setEnabled enabled 非布尔 → 校验错误 invalid-enabled', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { name: 'alpha', enabled: 'yes' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-enabled');
      expect(res.error.message).toContain('启用状态无效');
    }
  });

  it('Scenario setEnabled 未知技能名 → manager skill-not-found 错误直通', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { name: 'no-such-skill', enabled: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('skill-not-found');
      expect(res.error.message).toContain('技能不存在');
    }
  });

  it('Scenario setEnabled 系统管理种子 → system-managed-skill「由系统管理」(UI 禁用语义)', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, {
      name: 'memory-maintenance',
      enabled: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('system-managed-skill');
      expect(res.error.message).toContain('系统管理');
    }
  });

  // ---------------------------------------------------------------------
  // cleanDangling
  // ---------------------------------------------------------------------

  it('Scenario cleanDangling 合法 wsPath(∈ recentWorkspaces)→ ok({cleaned})', async () => {
    const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, { wsPath: ws });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ cleaned: 0 });
  });

  it('Scenario cleanDangling 真实悬空链接 → cleaned=1 且链接已删', async () => {
    const ok = makeDanglingLink(
      path.join(ws, '.lorra', 'skills'),
      'ghost',
      path.join(home, 'gone-target'),
    );
    if (!ok) return; // 平台不支持断链创建 → 跳过。

    const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, { wsPath: ws });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ cleaned: 1 });
    expect(existsSync(path.join(ws, '.lorra', 'skills', 'ghost'))).toBe(false);
  });

  it('Scenario cleanDangling 路径不存在(非 realpath)→ invalid-workspace-path 校验错误', async () => {
    const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, {
      wsPath: path.join(home, 'no-such-ws'),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-workspace-path');
      expect(res.error.message).toContain('工作区路径无效');
    }
  });

  it('Scenario cleanDangling 缺 wsPath / 非字符串 → invalid-workspace-path 校验错误', async () => {
    for (const args of [undefined, {}, { wsPath: 42 }]) {
      const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, args);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('invalid-workspace-path');
        expect(res.error.message).toContain('工作区路径无效');
      }
    }
  });

  it('Scenario cleanDangling 路径存在但不在 recentWorkspaces → unknown-workspace「未知工作区」', async () => {
    // 存在但从未记录过的工作区(settings 可篡改,必须 realpath 成员校验,D9)。
    const stranger = mkdtempSync(path.join(tmpdir(), 'lorra-sk-ipc-stranger-'));
    try {
      mkdirSync(path.join(stranger, '.git'), { recursive: true });
      const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, { wsPath: stranger });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('unknown-workspace');
        expect(res.error.message).toContain('未知工作区');
      }
    } finally {
      rmSync(stranger, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  // ---------------------------------------------------------------------
  // setWsEnabled(2026-08-13 批:按工作区停用)
  // ---------------------------------------------------------------------

  it('Scenario setWsEnabled 合法参数 → workspaceSkillOverrides[wsRealpath] 名单写入并落盘', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');
    const res = await call<void>(SKILLS_IPC.setWsEnabled, { name: 'alpha', enabled: false });
    expect(res.ok).toBe(true);

    const raw = JSON.parse(
      await readFile(path.join(electronMock.userData, 'settings.json'), 'utf8'),
    ) as { workspaceSkillOverrides?: Record<string, string[]> };
    expect(raw.workspaceSkillOverrides?.[wsReal]).toEqual(['alpha']);
  });

  it('Scenario setWsEnabled 恢复启用 → 名单移除', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');
    await call<void>(SKILLS_IPC.setWsEnabled, { name: 'alpha', enabled: false });
    const res = await call<void>(SKILLS_IPC.setWsEnabled, { name: 'alpha', enabled: true });
    expect(res.ok).toBe(true);
    const raw = JSON.parse(
      await readFile(path.join(electronMock.userData, 'settings.json'), 'utf8'),
    ) as { workspaceSkillOverrides?: Record<string, string[]> };
    expect(raw.workspaceSkillOverrides?.[wsReal]).toEqual([]);
  });

  it('Scenario setWsEnabled 复盘种子(2026-08-18 起普通技能)→ ok;系统管理种子仍拒', async () => {
    // daily-review 已不是系统管理:在发现集合内即可正常停用。
    writeWorkspaceSkill(ws, 'daily-review', '复盘技能');
    const res = await call<void>(SKILLS_IPC.setWsEnabled, {
      name: 'daily-review',
      enabled: false,
    });
    expect(res.ok).toBe(true);

    // memory-maintenance 仍是系统管理种子:无论扫描状态都拒。
    const managed = await call<void>(SKILLS_IPC.setWsEnabled, {
      name: 'memory-maintenance',
      enabled: false,
    });
    expect(managed.ok).toBe(false);
    if (!managed.ok) {
      expect(managed.error.code).toBe('system-managed-skill');
      expect(managed.error.message).toContain('系统管理');
    }
  });

  it('Scenario setWsEnabled name 非法(非字符串/空串)→ invalid-skill-name', async () => {
    for (const args of [
      { name: 42, enabled: false },
      { name: '', enabled: false },
      { enabled: false },
    ]) {
      const res = await call<void>(SKILLS_IPC.setWsEnabled, args);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid-skill-name');
    }
  });

  it('Scenario setWsEnabled enabled 非布尔 → invalid-enabled', async () => {
    const res = await call<void>(SKILLS_IPC.setWsEnabled, { name: 'alpha', enabled: 'yes' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid-enabled');
  });

  it('Scenario setWsEnabled wsPath 非法(非字符串)→ invalid-workspace-path', async () => {
    const res = await call<void>(SKILLS_IPC.setWsEnabled, {
      name: 'alpha',
      enabled: false,
      wsPath: 42,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid-workspace-path');
  });

  // ---------------------------------------------------------------------
  // collect(2026-08-13 批:收集散乱技能)
  // ---------------------------------------------------------------------

  it('Scenario collect 无参 → 回退当前工作区,返回 CollectResult', async () => {
    const res = await call<{ moved: number; linked: number; conflicts: string[]; notes: string[] }>(
      SKILLS_IPC.collect,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({ moved: 0, linked: 0, conflicts: [], notes: [] });
    }
  });

  it('Scenario collect wsPath 非法(非字符串/空串)→ invalid-workspace-path', async () => {
    for (const args of [{ wsPath: 42 }, { wsPath: '' }]) {
      const res = await call(SKILLS_IPC.collect, args);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid-workspace-path');
    }
  });

  // ---------------------------------------------------------------------
  // checkUpdates / updateAll(2026-08-13 批:git 更新)
  // ---------------------------------------------------------------------

  it('Scenario checkUpdates 无参 → ok(状态表;无 git 技能 → 空表)', async () => {
    const res = await call<Record<string, unknown>>(SKILLS_IPC.checkUpdates);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({});
  });

  it('Scenario updateAll 无参 → ok({updated:[],skipped:[]})', async () => {
    const res = await call<{ updated: string[]; skipped: string[] }>(SKILLS_IPC.updateAll);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ updated: [], skipped: [] });
  });
});

// ---------------------------------------------------------------------
// read(/skill 触发,2026-08-14)
// ---------------------------------------------------------------------

describe('skills-ipc read(lorra.skills.read,/skill 触发)', () => {
  let home: string;
  let ws: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-rd-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-rd-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await writeSettings({ recentWorkspaces: [ws] });
    electronMock.handlers.clear();
    registerSkillsIpc();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('Scenario 已知技能 → 返回 SKILL.md 原文', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');

    const res = await call<{ name: string; content: string }>(SKILLS_IPC.read, {
      name: 'alpha',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.name).toBe('alpha');
      expect(res.value.content).toContain('---');
      expect(res.value.content).toContain('alpha 描述');
    }
  });

  it('Scenario 未知技能 → skill-not-found', async () => {
    const res = await call<{ name: string; content: string }>(SKILLS_IPC.read, {
      name: 'nope',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('skill-not-found');
      expect(res.error.message).toBe('技能不存在');
    }
  });

  it('Scenario 非字符串/空技能名 → invalid-skill-name', async () => {
    for (const bad of [undefined, '', 42]) {
      const res = await call<{ name: string; content: string }>(SKILLS_IPC.read, { name: bad });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('invalid-skill-name');
        expect(res.error.message).toContain('技能名称无效');
      }
    }
  });

  it('Scenario 平铺 .md 技能 → 返回文件内容(名称 = 源根名,SDK fallbackName 语义)', async () => {
    mkdirSync(path.join(ws, '.lorra', 'skills'), { recursive: true });
    writeFileSync(path.join(ws, '.lorra', 'skills', 'flat.md'), '平铺技能正文', 'utf8');

    // 平铺文件 name 回退父目录名(SDK loadSkillFromFile 同款,skills-store
    // fallbackName):<ws>/.lorra/skills/flat.md → 名称「skills」。
    const res = await call<{ name: string; content: string }>(SKILLS_IPC.read, {
      name: 'skills',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.name).toBe('skills');
      expect(res.value.content).toBe('平铺技能正文');
    }
  });
});

// -------------------------------------------------------------------------
// create(lorra.skills.create,手动新建,2026-08-18)
// -------------------------------------------------------------------------

describe('skills-ipc create(lorra.skills.create,手动新建)', () => {
  let home: string;
  let ws: string;
  let wsReal: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-sk-ipc-create-'));
    ws = path.join(home, 'work');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    wsReal = realpathSync(ws);
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-ipc-create-settings-'));
    vi.stubEnv('LORRA_E2E_USERDATA', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await writeSettings({ recentWorkspaces: [ws] });
    electronMock.handlers.clear();
    registerSkillsIpc();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    electronMock.userData = '';
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('Scenario 合法 name+content → 写 <ws>/.lorra/skills/<name>.md,返回 name+filePath', async () => {
    const body = '---\nname: my-flow\ndescription: 测试技能\n---\n\n正文\n';
    const res = await call<{ name: string; filePath: string }>(SKILLS_IPC.create, {
      name: 'my-flow',
      content: body,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.name).toBe('my-flow');
    expect(res.value.filePath).toBe(path.join(wsReal, '.lorra', 'skills', 'my-flow.md'));
    expect(existsSync(res.value.filePath)).toBe(true);
    expect(readFileSync(res.value.filePath, 'utf8')).toBe(body);
  });

  it('Scenario 目标已存在 → Err skill-already-exists(不覆写用户文件)', async () => {
    const target = path.join(ws, '.lorra', 'skills', 'dup.md');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '原有内容', 'utf8');

    const res = await call<{ name: string; filePath: string }>(SKILLS_IPC.create, {
      name: 'dup',
      content: '新内容',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('skill-already-exists');
      expect(res.error.message).toContain('技能已存在');
    }
    expect(readFileSync(target, 'utf8')).toBe('原有内容');
  });

  it('Scenario 非法 name(大写/连字符开头/连字符结尾/空)→ invalid-skill-name', async () => {
    for (const name of ['MyFlow', '-flow', 'flow-', '']) {
      const res = await call<{ name: string; filePath: string }>(SKILLS_IPC.create, {
        name,
        content: 'body',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid-skill-name');
    }
    // 非法名不落任何文件。
    expect(existsSync(path.join(ws, '.lorra', 'skills'))).toBe(false);
  });

  it('Scenario 空 content → invalid-skill-content', async () => {
    const res = await call<{ name: string; filePath: string }>(SKILLS_IPC.create, {
      name: 'my-flow',
      content: '',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-skill-content');
      expect(res.error.message).toContain('技能内容不能为空');
    }
  });

  it('Scenario 显式 wsPath 不存在 → invalid-workspace-path', async () => {
    const res = await call<{ name: string; filePath: string }>(SKILLS_IPC.create, {
      name: 'my-flow',
      content: 'body',
      wsPath: path.join(home, 'no-such-ws'),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid-workspace-path');
  });
});
