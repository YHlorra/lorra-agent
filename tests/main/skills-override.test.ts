import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// V1-5/V1-6 + 2026-08-13 技能收集批测试:
// - settings.ts:disabledSkills / skillCollectionRoot / workspaceSkillOverrides 读写往返、
// 类型守卫回退、recordRecentWorkspace 保留清单;**workspaceOptInSkills 键已移除**
// (clean cutover:旧 settings.json 里的字段被白名单解析天然忽略);
// - 共享剔除合并 buildSkillsOverride **恒合并**语义(无 opt-in gate):
// workspaceSkillOverrides[wsRealpath] 无条件合并、既有剔除保持(.pi 前缀 +
// daily/deep-review)、disabledSkills 合并、realpath 匹配、去重保序;
// - session-persistence 集成:settings 经 readSettings 流入 skillsOverride(恒合并);
// additionalSkillPaths 动态加入自定义收集根(存在且不与既有两项重复)。
//
// electron mock:settings.ts 走 app.getPath('userData') 定位 settings.json;
// session-persistence 传递依赖 tool-safety interceptor(shell)。userData 每测试指向临时目录。
const electronMock = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? electronMock.userData : ''),
  },
  shell: {
    trashItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    create: vi.fn(),
    inMemory: vi.fn(),
    open: vi.fn(),
    continueRecent: vi.fn(),
    list: vi.fn(),
  },
  createAgentSessionServices: vi.fn(),
  createAgentSessionFromServices: vi.fn(),
  createEventBus: vi.fn(() => ({ emit: vi.fn(), on: vi.fn(() => () => {}) })),
  createExtensionRuntime: vi.fn(() => ({ extensions: [] })),
  loadExtensionFromFactory: vi.fn().mockResolvedValue({}),
}));

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
} from '@earendil-works/pi-coding-agent';
import { createSessionPersistence } from '../../src/main/pi-sdk-driver/session-persistence';
import { buildSkillsOverride } from '../../src/main/skills/skills-override';
import {
  readSettings,
  recordRecentWorkspace,
  writeSettings,
} from '../../src/main/workspace/settings';

const mockCreateServices = createAgentSessionServices as ReturnType<typeof vi.fn>;
const mockCreateSession = createAgentSessionFromServices as ReturnType<typeof vi.fn>;

const settingsPath = () => path.join(electronMock.userData, 'settings.json');

// ---------------------------------------------------------------------------
// V1-5 + 2026-08-13: settings.ts 技能键
// ---------------------------------------------------------------------------

describe('settings 技能键 (V1-5 + 收集批)', () => {
  let userData: string;

  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-settings-'));
    electronMock.userData = userData;
  });

  afterEach(() => {
    electronMock.userData = '';
  });

  it('读写往返: disabledSkills / skillCollectionRoot / workspaceSkillOverrides 完整往返', async () => {
    const wsReal = path.join('C:', 'real', 'ws');
    await writeSettings({
      recentWorkspaces: ['/ws'],
      showHiddenFiles: true,
      disabledSkills: ['alpha', 'beta'],
      skillCollectionRoot: 'E:/my-collection',
      workspaceSkillOverrides: { [wsReal]: ['alpha', 'gamma'] },
    });

    const read = await readSettings();

    expect(read.disabledSkills).toEqual(['alpha', 'beta']);
    expect(read.skillCollectionRoot).toBe('E:/my-collection');
    expect(read.workspaceSkillOverrides).toEqual({ [wsReal]: ['alpha', 'gamma'] });
  });

  it('缺省值: 旧 settings.json(无新键)读回默认 disabledSkills=[] / skillCollectionRoot 空串 / overrides={}', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ recentWorkspaces: ['/ws'] }), 'utf8');

    const read = await readSettings();

    expect(read.disabledSkills).toEqual([]);
    expect(read.skillCollectionRoot).toBe('');
    expect(read.workspaceSkillOverrides).toEqual({});
  });

  it('skillCollectionRoot: 空串/空白/非字符串 → 空串(使用默认值)', async () => {
    for (const raw of ['', '   ', 42, null]) {
      writeFileSync(
        settingsPath(),
        JSON.stringify({ recentWorkspaces: ['/ws'], skillCollectionRoot: raw }),
        'utf8',
      );
      expect((await readSettings()).skillCollectionRoot).toBe('');
    }
  });

  it('类型错回退默认值: string[]/Record 类型守卫,坏类型不炸', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        recentWorkspaces: ['/ws'],
        disabledSkills: 'not-an-array',
        workspaceSkillOverrides: { wsA: 'not-an-array' },
      }),
      'utf8',
    );

    const read = await readSettings();

    expect(read.disabledSkills).toEqual([]);
    expect(read.workspaceSkillOverrides).toEqual({});
  });

  it('disabledSkills 数组内非字符串条目被过滤,字符串保留', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ recentWorkspaces: ['/ws'], disabledSkills: ['ok', 42, null, 'keep'] }),
      'utf8',
    );

    const read = await readSettings();

    expect(read.disabledSkills).toEqual(['ok', 'keep']);
  });

  it('旧 settings.json 里的 workspaceOptInSkills 字段被白名单解析忽略(clean cutover,无迁移)', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        recentWorkspaces: ['/ws'],
        workspaceOptInSkills: true,
        workspaceSkillOverrides: { '/ws': ['alpha'] },
      }),
      'utf8',
    );

    const read = await readSettings();

    expect('workspaceOptInSkills' in read).toBe(false);
    // 名单本身保留(语义升级为恒合并的按工作区停用名单)。
    expect(read.workspaceSkillOverrides).toEqual({ '/ws': ['alpha'] });
  });

  it('recordRecentWorkspace 保留新键: 工作区切换不丢技能设置', async () => {
    const wsReal = path.join('C:', 'ws', 'old');
    await writeSettings({
      recentWorkspaces: ['/old'],
      disabledSkills: ['alpha'],
      skillCollectionRoot: 'E:/col',
      workspaceSkillOverrides: { [wsReal]: ['alpha'] },
    });

    await recordRecentWorkspace('/new');

    const read = await readSettings();
    expect(read.recentWorkspaces[0]).toBe('/new');
    expect(read.disabledSkills).toEqual(['alpha']);
    expect(read.skillCollectionRoot).toBe('E:/col');
    expect(read.workspaceSkillOverrides).toEqual({ [wsReal]: ['alpha'] });
  });
});

// ---------------------------------------------------------------------------
// V1-6 改写: buildSkillsOverride 共享剔除合并(恒合并,无 opt-in gate)
// ---------------------------------------------------------------------------

describe('buildSkillsOverride 共享剔除合并(恒合并)', () => {
  const WS = '/workspace/real';
  // 既有剔除原样迁入: 复盘种子(调用方经 existingExclusions 传入,现状 =
  // daily-review/deep-review) + .pi 项目技能源前缀(由 wsPath 派生)。
  const seeds = ['daily-review', 'deep-review'];

  it('名单空: 不新增任何剔除(既有 pi 前缀 + 种子原样)', () => {
    expect(
      buildSkillsOverride({
        wsPath: WS,
        disabledSkills: [],
        workspaceSkillOverrides: {},
        existingExclusions: seeds,
      }),
    ).toEqual([`${WS}/.pi`, 'daily-review', 'deep-review']);
  });

  it('名单非空: workspaceSkillOverrides[wsPath] 恒合并(无 workspaceOptInSkills gate)', () => {
    expect(
      buildSkillsOverride({
        wsPath: WS,
        disabledSkills: [],
        workspaceSkillOverrides: { [WS]: ['skill-g'] },
        existingExclusions: seeds,
      }),
    ).toEqual([`${WS}/.pi`, 'daily-review', 'deep-review', 'skill-g']);
  });

  it('disabledSkills 无条件合并(全局隐藏,恒生效)', () => {
    const result = buildSkillsOverride({
      wsPath: WS,
      disabledSkills: ['g1', 'g2'],
      workspaceSkillOverrides: { [WS]: ['g3'] },
      existingExclusions: seeds,
    });
    expect(result).toEqual([`${WS}/.pi`, 'daily-review', 'deep-review', 'g1', 'g2', 'g3']);
  });

  it('realpath 匹配: 只取 workspaceSkillOverrides[wsPath],其它工作区键不命中', () => {
    const result = buildSkillsOverride({
      wsPath: WS,
      disabledSkills: [],
      workspaceSkillOverrides: { [WS]: ['mine'], '/other/ws': ['theirs'] },
      existingExclusions: seeds,
    });
    expect(result).toEqual([`${WS}/.pi`, 'daily-review', 'deep-review', 'mine']);
  });

  it('去重 + 保序: 重复条目(种子/隐藏/override 交叉)只出现一次,顺序 = pi → seeds → disabled → overrides', () => {
    const result = buildSkillsOverride({
      wsPath: WS,
      disabledSkills: ['dup', 'daily-review', 'dup'],
      workspaceSkillOverrides: { [WS]: ['dup', 'deep-review', 'extra'] },
      existingExclusions: seeds,
    });
    expect(result).toEqual([`${WS}/.pi`, 'daily-review', 'deep-review', 'dup', 'extra']);
  });

  it('既有剔除保持: .pi 前缀条目派生自 wsPath(前斜杠、无尾分隔符,边界由消费方 entry + "/" 判定)', () => {
    const result = buildSkillsOverride({
      wsPath: WS,
      disabledSkills: [],
      workspaceSkillOverrides: {},
      existingExclusions: seeds,
    });
    expect(result[0]).toBe(`${WS}/.pi`);
    expect(result[0]).not.toMatch(/[\\/]$/);
  });

  it('existingExclusions 缺省为空数组', () => {
    const result = buildSkillsOverride({
      wsPath: WS,
      disabledSkills: [],
      workspaceSkillOverrides: {},
    });
    expect(result).toEqual([`${WS}/.pi`]);
  });
});

// ---------------------------------------------------------------------------
// session-persistence 集成:恒合并 + additionalSkillPaths 动态收集根
// ---------------------------------------------------------------------------

describe('session-persistence 集成: skillsOverride 合并设置 + 动态收集根 (V1-6 + 收集批)', () => {
  let ws: string;
  let wsReal: string;

  type SkillLike = { name: string; filePath: string };
  type SkillsOverride = (base: { skills: SkillLike[] }) => { skills: SkillLike[] };

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'lorra-sk-ws-'));
    wsReal = await realpath(ws);
    electronMock.userData = mkdtempSync(path.join(tmpdir(), 'lorra-sk-user-'));
    vi.clearAllMocks();
    mockCreateSession.mockResolvedValue({
      session: { sessionId: 'sid', extensionRunner: { extensions: [] } },
    } as never);
  });

  afterEach(() => {
    electronMock.userData = '';
  });

  /** 第 index 次 createAgentSessionServices 调用注入的 skillsOverride(3 处取用,锁步提取)。 */
  function skillsOverrideAt(index: number): SkillsOverride {
    const options = mockCreateServices.mock.calls[index]?.[0] as
      | { resourceLoaderOptions?: { skillsOverride?: unknown } }
      | undefined;
    const override = options?.resourceLoaderOptions?.skillsOverride;
    if (typeof override !== 'function') {
      throw new Error(`skillsOverride not wired at createAgentSessionServices call #${index}`);
    }
    return override as SkillsOverride;
  }

  /** 第 index 次 createAgentSessionServices 调用注入的 additionalSkillPaths。 */
  function additionalSkillPathsAt(index: number): string[] {
    const options = mockCreateServices.mock.calls[index]?.[0] as
      | { resourceLoaderOptions?: { additionalSkillPaths?: unknown } }
      | undefined;
    const paths = options?.resourceLoaderOptions?.additionalSkillPaths;
    if (!Array.isArray(paths)) {
      throw new Error(
        `additionalSkillPaths not wired at createAgentSessionServices call #${index}`,
      );
    }
    return paths as string[];
  }

  function piPath(...rest: string[]): string {
    return path.join(wsReal, '.pi', 'skills', ...rest).replace(/\\/g, '/');
  }

  function lorraPath(...rest: string[]): string {
    return path.join(wsReal, '.lorra', 'skills', ...rest).replace(/\\/g, '/');
  }

  it('默认(无设置文件): 既有剔除不变 —— .pi 前缀与复盘种子仍被剔除;additionalSkillPaths 无重复收集根', async () => {
    const persistence = await createSessionPersistence({
      workspacePath: ws,
      emitBlocked: () => {},
    });
    await persistence.createInMemory(ws);

    const result = skillsOverrideAt(0)({
      skills: [
        { name: 'pi-skill', filePath: piPath('pi-skill', 'SKILL.md') },
        { name: 'daily-review', filePath: lorraPath('daily-review.md') },
        { name: 'deep-review', filePath: lorraPath('deep-review.md') },
        { name: 'lorra-skill', filePath: lorraPath('lorra-skill', 'SKILL.md') },
      ],
    });
    expect(result.skills.map((s) => s.name)).toEqual(['lorra-skill']);

    // 默认收集根 = ~/.agents/skills(已含于 base) → 不重复添加。
    const paths = additionalSkillPathsAt(0).map((p) => p.toLowerCase());
    const userAgents = path.join(os.homedir(), '.agents', 'skills');
    expect(paths.filter((p) => p === userAgents.toLowerCase())).toHaveLength(1);
  });

  it('disabledSkills 流入 skillsOverride;workspaceSkillOverrides[wsRealpath] 恒合并(无 opt-in gate)', async () => {
    await writeSettings({
      recentWorkspaces: [ws],
      disabledSkills: ['disabled-a'],
      workspaceSkillOverrides: { [wsReal]: ['ws-disabled'] },
    });
    const persistence = await createSessionPersistence({
      workspacePath: ws,
      emitBlocked: () => {},
    });
    await persistence.createInMemory(ws);

    const result = skillsOverrideAt(0)({
      skills: [
        { name: 'disabled-a', filePath: lorraPath('disabled-a', 'SKILL.md') },
        { name: 'ws-disabled', filePath: lorraPath('ws-disabled', 'SKILL.md') },
        { name: 'daily-review', filePath: lorraPath('daily-review.md') },
        { name: 'kept', filePath: lorraPath('kept', 'SKILL.md') },
      ],
    });
    expect(result.skills.map((s) => s.name)).toEqual(['kept']);
  });

  it('自定义收集根(存在)加入 additionalSkillPaths;不存在则不加入', async () => {
    const customRoot = path.join(wsReal, '.custom-collection');
    mkdirSync(customRoot, { recursive: true });
    await writeSettings({
      recentWorkspaces: [ws],
      skillCollectionRoot: customRoot,
    });
    const persistence = await createSessionPersistence({
      workspacePath: ws,
      emitBlocked: () => {},
    });
    await persistence.createInMemory(ws);

    const paths = additionalSkillPathsAt(0);
    expect(paths).toContain(path.resolve(customRoot));

    // 目录删掉后重建会话 → 不再加入(存在性过滤)。
    // (win32 上 rmSync 目录即可;此处直接再写 settings + 新会话)
    await writeSettings({
      recentWorkspaces: [ws],
      skillCollectionRoot: path.join(wsReal, '.not-exists-collection'),
    });
    await persistence.createInMemory(ws);
    const paths2 = additionalSkillPathsAt(1);
    expect(paths2.some((p) => p.includes('.not-exists-collection'))).toBe(false);
  });

  it('每次创建会话重新读设置: 会话间切换 disabledSkills 即生效', async () => {
    await writeSettings({
      recentWorkspaces: [ws],
      disabledSkills: ['first'],
      workspaceSkillOverrides: {},
    });
    const persistence = await createSessionPersistence({
      workspacePath: ws,
      emitBlocked: () => {},
    });
    await persistence.createInMemory(ws);

    await writeSettings({
      recentWorkspaces: [ws],
      disabledSkills: ['second'],
      workspaceSkillOverrides: {},
    });
    await persistence.createInMemory(ws);

    expect(mockCreateServices.mock.calls).toHaveLength(2);
    const firstOverride = skillsOverrideAt(0);
    const secondOverride = skillsOverrideAt(1);

    expect(
      firstOverride({ skills: [{ name: 'first', filePath: lorraPath('first', 'SKILL.md') }] })
        .skills,
    ).toEqual([]);
    expect(
      firstOverride({
        skills: [{ name: 'second', filePath: lorraPath('second', 'SKILL.md') }],
      }).skills.map((s) => s.name),
    ).toEqual(['second']);
    expect(
      secondOverride({
        skills: [{ name: 'first', filePath: lorraPath('first', 'SKILL.md') }],
      }).skills.map((s) => s.name),
    ).toEqual(['first']);
    expect(
      secondOverride({ skills: [{ name: 'second', filePath: lorraPath('second', 'SKILL.md') }] })
        .skills,
    ).toEqual([]);
  });
});
