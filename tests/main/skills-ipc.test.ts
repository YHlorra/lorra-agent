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

  it('Requirement 通道注册:七通道名与 SKILLS_IPC 常量逐字一致(install 已迁移为会话工具)', () => {
    expect(electronMock.handlers.has(SKILLS_IPC.xray)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.setEnabled)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.cleanDangling)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.collect)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.checkUpdates)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.updateAll)).toBe(true);
    expect(electronMock.handlers.has(SKILLS_IPC.setWsEnabled)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // xray
  // ---------------------------------------------------------------------

  it('Scenario xray 无参 → 回退当前工作区(recentWorkspaces 首个),返回 SkillXray 全量', async () => {
    writeWorkspaceSkill(ws, 'alpha', 'alpha 描述');

    const res = await call<SkillXray>(SKILLS_IPC.xray);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
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
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.value.workspacePath).toBe(realpathSync(stranger));
      expect(res.value.skills.map((s) => s.name)).toContain('beta');
    } finally {
      rmSync(stranger, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  it('Scenario xray wsPath 非字符串 → IPC 层校验错误 invalid-workspace-path', async () => {
    const res = await call<SkillXray>(SKILLS_IPC.xray, { wsPath: 123 });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('invalid-workspace-path');
      expect(res.error.message).toContain('工作区路径无效');
    }
  });

  it('Scenario xray wsPath 不存在 → manager resolveWorkspacePath 错误直通', async () => {
    const res = await call<SkillXray>(SKILLS_IPC.xray, {
      wsPath: path.join(home, 'no-such-ws'),
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
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
    expect(res.status).toBe('ok');
    // 落盘实锤:直接读 settings.json 原文。
    const raw = JSON.parse(
      await readFile(path.join(electronMock.userData, 'settings.json'), 'utf8'),
    ) as { disabledSkills?: string[] };
    expect(raw.disabledSkills).toEqual(['alpha']);
  });

  it('Scenario setEnabled name 非字符串 → 校验错误 invalid-skill-name(PM 语域)', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { name: 42, enabled: false });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('invalid-skill-name');
      expect(res.error.message).toContain('技能名称无效');
    }
  });

  it('Scenario setEnabled name 空串 → 校验错误 invalid-skill-name', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { name: '', enabled: false });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('invalid-skill-name');
      expect(res.error.message).toContain('技能名称无效');
    }
  });

  it('Scenario setEnabled name 缺失 → 校验错误', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { enabled: false });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error.code).toBe('invalid-skill-name');
  });

  it('Scenario setEnabled enabled 非布尔 → 校验错误 invalid-enabled', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { name: 'alpha', enabled: 'yes' });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('invalid-enabled');
      expect(res.error.message).toContain('启用状态无效');
    }
  });

  it('Scenario setEnabled 未知技能名 → manager skill-not-found 错误直通', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, { name: 'no-such-skill', enabled: false });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('skill-not-found');
      expect(res.error.message).toContain('技能不存在');
    }
  });

  it('Scenario setEnabled 系统管理种子 → system-managed-skill「由系统管理」(UI 禁用语义)', async () => {
    const res = await call<void>(SKILLS_IPC.setEnabled, {
      name: 'memory-maintenance',
      enabled: false,
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('system-managed-skill');
      expect(res.error.message).toContain('系统管理');
    }
  });

  // ---------------------------------------------------------------------
  // cleanDangling
  // ---------------------------------------------------------------------

  it('Scenario cleanDangling 合法 wsPath(∈ recentWorkspaces)→ ok({cleaned})', async () => {
    const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, { wsPath: ws });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.value).toEqual({ cleaned: 0 });
  });

  it('Scenario cleanDangling 真实悬空链接 → cleaned=1 且链接已删', async () => {
    const ok = makeDanglingLink(
      path.join(ws, '.lorra', 'skills'),
      'ghost',
      path.join(home, 'gone-target'),
    );
    if (!ok) return; // 平台不支持断链创建 → 跳过。

    const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, { wsPath: ws });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.value).toEqual({ cleaned: 1 });
    expect(existsSync(path.join(ws, '.lorra', 'skills', 'ghost'))).toBe(false);
  });

  it('Scenario cleanDangling 路径不存在(非 realpath)→ invalid-workspace-path 校验错误', async () => {
    const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, {
      wsPath: path.join(home, 'no-such-ws'),
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('invalid-workspace-path');
      expect(res.error.message).toContain('工作区路径无效');
    }
  });

  it('Scenario cleanDangling 缺 wsPath / 非字符串 → invalid-workspace-path 校验错误', async () => {
    for (const args of [undefined, {}, { wsPath: 42 }]) {
      const res = await call<{ cleaned: number }>(SKILLS_IPC.cleanDangling, args);
      expect(res.status).toBe('error');
      if (res.status === 'error') {
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
      expect(res.status).toBe('error');
      if (res.status === 'error') {
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
    const res = await call<void>(SKILLS_IPC.setWsEnabled, { name: 'alpha', enabled: false });
    expect(res.status).toBe('ok');

    const raw = JSON.parse(
      await readFile(path.join(electronMock.userData, 'settings.json'), 'utf8'),
    ) as { workspaceSkillOverrides?: Record<string, string[]> };
    expect(raw.workspaceSkillOverrides?.[wsReal]).toEqual(['alpha']);
  });

  it('Scenario setWsEnabled 恢复启用 → 名单移除', async () => {
    await call<void>(SKILLS_IPC.setWsEnabled, { name: 'alpha', enabled: false });
    const res = await call<void>(SKILLS_IPC.setWsEnabled, { name: 'alpha', enabled: true });
    expect(res.status).toBe('ok');
    const raw = JSON.parse(
      await readFile(path.join(electronMock.userData, 'settings.json'), 'utf8'),
    ) as { workspaceSkillOverrides?: Record<string, string[]> };
    expect(raw.workspaceSkillOverrides?.[wsReal]).toEqual([]);
  });

  it('Scenario setWsEnabled 系统管理种子 → system-managed-skill「由系统管理」', async () => {
    const res = await call<void>(SKILLS_IPC.setWsEnabled, {
      name: 'daily-review',
      enabled: false,
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('system-managed-skill');
      expect(res.error.message).toContain('系统管理');
    }
  });

  it('Scenario setWsEnabled name 非法(非字符串/空串)→ invalid-skill-name', async () => {
    for (const args of [
      { name: 42, enabled: false },
      { name: '', enabled: false },
      { enabled: false },
    ]) {
      const res = await call<void>(SKILLS_IPC.setWsEnabled, args);
      expect(res.status).toBe('error');
      if (res.status === 'error') expect(res.error.code).toBe('invalid-skill-name');
    }
  });

  it('Scenario setWsEnabled enabled 非布尔 → invalid-enabled', async () => {
    const res = await call<void>(SKILLS_IPC.setWsEnabled, { name: 'alpha', enabled: 'yes' });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error.code).toBe('invalid-enabled');
  });

  it('Scenario setWsEnabled wsPath 非法(非字符串)→ invalid-workspace-path', async () => {
    const res = await call<void>(SKILLS_IPC.setWsEnabled, {
      name: 'alpha',
      enabled: false,
      wsPath: 42,
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error.code).toBe('invalid-workspace-path');
  });

  // ---------------------------------------------------------------------
  // collect(2026-08-13 批:收集散乱技能)
  // ---------------------------------------------------------------------

  it('Scenario collect 无参 → 回退当前工作区,返回 CollectResult', async () => {
    const res = await call<{ moved: number; linked: number; conflicts: string[]; notes: string[] }>(
      SKILLS_IPC.collect,
    );
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.value).toMatchObject({ moved: 0, linked: 0, conflicts: [], notes: [] });
    }
  });

  it('Scenario collect wsPath 非法(非字符串/空串)→ invalid-workspace-path', async () => {
    for (const args of [{ wsPath: 42 }, { wsPath: '' }]) {
      const res = await call(SKILLS_IPC.collect, args);
      expect(res.status).toBe('error');
      if (res.status === 'error') expect(res.error.code).toBe('invalid-workspace-path');
    }
  });

  // ---------------------------------------------------------------------
  // checkUpdates / updateAll(2026-08-13 批:git 更新)
  // ---------------------------------------------------------------------

  it('Scenario checkUpdates 无参 → ok(状态表;无 git 技能 → 空表)', async () => {
    const res = await call<Record<string, unknown>>(SKILLS_IPC.checkUpdates);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.value).toEqual({});
  });

  it('Scenario updateAll 无参 → ok({updated:[],skipped:[]})', async () => {
    const res = await call<{ updated: string[]; skipped: string[] }>(SKILLS_IPC.updateAll);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.value).toEqual({ updated: [], skipped: [] });
  });
});
