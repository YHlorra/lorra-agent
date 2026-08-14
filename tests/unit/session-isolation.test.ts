import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

// Session-persistence transitively pulls in `trash-delete.ts` which imports
// `shell` from `electron`. In unit-test env we never load Electron's binary;
// stub the surface used by the safety interceptor.
//
// `workspace-realpath` cross-workspace + symlink isolation behavior was
// previously mocked here; those cases now live in
// `tests/integration/workspace-realpath.test.ts` (T2 from PLAN.md) which
// exercises real `realpath` against real symlinks in os.tmpdir. This
// suite keeps the mock for the remaining tests that incidentally need a
// controlled realpath return value (SDK config binding, error paths).
vi.mock('electron', () => ({
  shell: {
    trashItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    list: vi.fn(),
    open: vi.fn(),
    continueRecent: vi.fn(),
    create: vi.fn(),
    inMemory: vi.fn(),
  },
  createAgentSessionServices: vi.fn(),
  createAgentSessionFromServices: vi.fn(),
  createEventBus: vi.fn(() => ({ emit: vi.fn(), on: vi.fn(() => () => {}) })),
  createExtensionRuntime: vi.fn(() => ({ extensions: [] })),
  loadExtensionFromFactory: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/main/pi-sdk-driver/workspace-realpath', () => ({
  readWorkspaceRealpath: vi.fn(),
}));

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { SessionInfo } from '../../src/main/pi-sdk-driver/driver';
import { createSessionPersistence } from '../../src/main/pi-sdk-driver/session-persistence';
import { readWorkspaceRealpath } from '../../src/main/pi-sdk-driver/workspace-realpath';

const mockList = SessionManager.list as ReturnType<typeof vi.fn>;
const mockCreateServices = createAgentSessionServices as ReturnType<typeof vi.fn>;
const mockCreateSession = createAgentSessionFromServices as ReturnType<typeof vi.fn>;
const mockRealpath = readWorkspaceRealpath as ReturnType<typeof vi.fn>;

function makeSession(id: string, cwd: string, p: string = `/tmp/${id}.jsonl`): SessionInfo {
  return {
    id,
    cwd,
    path: p,
    created: new Date(),
    modified: new Date(),
    // Non-empty session: list filters header-only (messageCount 0) sessions.
    messageCount: 1,
    firstMessage: 'hi',
  };
}

describe('session isolation', () => {
  it('binds each new session to the default in same-source SDK settings', async () => {
    vi.stubEnv('LORRA_E2E_USERDATA', 'C:/test/user-data');
    const agentDir = path.join('C:/test/user-data', '.lorra');
    let defaultModel = 'first-model';
    const sessions: Array<{ defaultModel: string }> = [];

    mockRealpath.mockResolvedValue('/workspace/real');
    mockCreateServices.mockImplementation(async ({ agentDir: actualAgentDir }) => ({
      defaultModel: actualAgentDir === agentDir ? defaultModel : 'wrong-source',
    }));
    mockCreateSession.mockImplementation(async ({ services }) => {
      const session = {
        defaultModel: (services as { defaultModel: string }).defaultModel,
        extensionRunner: { extensions: [] },
      };
      sessions.push(session);
      return { session };
    });

    const persistence = await createSessionPersistence({
      workspacePath: '/workspace',
      emitBlocked: () => {},
    });
    await persistence.createInMemory('/workspace');
    defaultModel = 'second-model';
    await persistence.createInMemory('/workspace');

    // exp-5: skill 双源 —— 项目技能走 <workspace>/.lorra/skills(additionalSkillPaths),
    // 用户全局技能库 <home>/.agents/skills 同样加载(2026-08-10);
    // skillsOverride 负责剔除 SDK 默认的 <cwd>/.pi/skills 项目技能源。
    const resourceLoaderOptions = {
      additionalSkillPaths: [
        path.join('/workspace/real', '.lorra', 'skills'),
        path.join(os.homedir(), '.agents', 'skills'),
      ],
      skillsOverride: expect.any(Function),
    };
    expect(mockCreateServices).toHaveBeenNthCalledWith(1, {
      cwd: '/workspace/real',
      agentDir,
      resourceLoaderOptions,
    });
    expect(mockCreateServices).toHaveBeenNthCalledWith(2, {
      cwd: '/workspace/real',
      agentDir,
      resourceLoaderOptions,
    });
    expect(sessions.map((session) => session.defaultModel)).toEqual([
      'first-model',
      'second-model',
    ]);
    vi.unstubAllEnvs();
  });

  it('skillsOverride filters out project `.pi/skills` (SDK default), keeps `.lorra/skills`', async () => {
    vi.stubEnv('LORRA_E2E_USERDATA', 'C:/test/user-data');
    mockRealpath.mockResolvedValue('/workspace/real');

    const persistence = await createSessionPersistence({
      workspacePath: '/workspace',
      emitBlocked: () => {},
    });
    await persistence.createInMemory('/workspace');

    const options = mockCreateServices.mock.calls[0]?.[0] as {
      resourceLoaderOptions?: {
        skillsOverride?: (base: {
          skills: Array<{ name: string; filePath: string }>;
          diagnostics: unknown[];
        }) => { skills: Array<{ name: string; filePath: string }>; diagnostics: unknown[] };
      };
    };
    const skillsOverride = options.resourceLoaderOptions?.skillsOverride;
    expect(skillsOverride).toBeTypeOf('function');

    // SDK DefaultResourceLoader 加载后、注入系统提示前调用本函数;输入为
    // 全部已发现技能(全局 agentDir/skills + 项目 .pi/skills + additionalSkillPaths)。
    const base = {
      diagnostics: [],
      skills: [
        { name: 'pi-skill', filePath: '/workspace/real/.pi/skills/pi-skill/SKILL.md' },
        { name: 'lorra-skill', filePath: '/workspace/real/.lorra/skills/lorra-skill/SKILL.md' },
        { name: 'global-skill', filePath: 'C:/test/user-data/.lorra/skills/global-skill/SKILL.md' },
      ],
    };
    if (!skillsOverride) throw new Error('skillsOverride not wired');
    const result = skillsOverride(base as never);

    expect(result.skills.map((s) => s.name)).toEqual(['lorra-skill', 'global-skill']);
    expect(result.diagnostics).toEqual(base.diagnostics);
    vi.unstubAllEnvs();
  });

  it('skillsOverride drops seeded flat review .md skills, keeps `.pi`-segment workspace skills', async () => {
    vi.stubEnv('LORRA_E2E_USERDATA', 'C:/test/user-data');
    mockRealpath.mockResolvedValue('/workspace/real');

    const persistence = await createSessionPersistence({
      workspacePath: '/workspace',
      emitBlocked: () => {},
    });
    await persistence.createInMemory('/workspace');

    const options = mockCreateServices.mock.calls[0]?.[0] as {
      resourceLoaderOptions?: {
        skillsOverride?: (base: {
          skills: Array<{ name: string; filePath: string }>;
          diagnostics: unknown[];
        }) => { skills: Array<{ name: string; filePath: string }>; diagnostics: unknown[] };
      };
    };
    const skillsOverride = options.resourceLoaderOptions?.skillsOverride;
    expect(skillsOverride).toBeTypeOf('function');

    // 复盘播种的平铺 .md 会被 SDK 当技能发现(includeRootFiles),必须按名剔除;
    // 前缀锚定只删 <ws>/.pi/ 目录,工作区路径含 `.pi` 段的技能不受影响。
    const base = {
      diagnostics: [],
      skills: [
        { name: 'pi-skill', filePath: '/workspace/real/.pi/skills/pi-skill/SKILL.md' },
        { name: 'daily-review', filePath: '/workspace/real/.lorra/skills/daily-review.md' },
        { name: 'deep-review', filePath: '/workspace/real/.lorra/skills/deep-review.md' },
        {
          name: 'sandbox-skill',
          filePath: '/workspace/real/.pi-project/.lorra/skills/sandbox-skill/SKILL.md',
        },
        { name: 'lorra-skill', filePath: '/workspace/real/.lorra/skills/lorra-skill/SKILL.md' },
        {
          name: 'global-skill',
          filePath: 'C:/test/user-data/.lorra/skills/global-skill/SKILL.md',
        },
      ],
    };
    if (!skillsOverride) throw new Error('skillsOverride not wired');
    const result = skillsOverride(base as never);

    expect(result.skills.map((s) => s.name)).toEqual([
      'sandbox-skill',
      'lorra-skill',
      'global-skill',
    ]);
    expect(result.diagnostics).toEqual(base.diagnostics);
    vi.unstubAllEnvs();
  });

  it('corrupt JSONL (SessionManager.list throws) → list returns []', async () => {
    mockList.mockRejectedValue(new Error('corrupt JSONL'));
    mockRealpath.mockResolvedValue('/workspace/real');

    const persistence = await createSessionPersistence({
      workspacePath: '/workspace',
      emitBlocked: () => {},
    });
    const result = await persistence.list('/workspace');

    expect(result).toEqual([]);
  });

  it('fast-check: only sessions whose cwd realpath matches workspace are returned', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 10 }),
            cwd: fc.string({ minLength: 1, maxLength: 20 }),
          }),
          { minLength: 0, maxLength: 10 },
        ),
        fc.string({ minLength: 1, maxLength: 10 }),
        async (sessions, workspaceRealpath) => {
          // Deterministic mock: session cwd realpath equals workspace realpath
          // only when the cwd string starts with the workspace realpath prefix.
          mockRealpath.mockImplementation((p: string) => {
            if (p === '/workspace') return Promise.resolve(workspaceRealpath);
            if (sessions.some((s) => s.cwd === p)) {
              return Promise.resolve(
                p.startsWith(workspaceRealpath) ? workspaceRealpath : '/other/path',
              );
            }
            return Promise.resolve('/other/path');
          });
          mockList.mockResolvedValue(
            sessions.map((s) => ({
              ...s,
              created: new Date(),
              modified: new Date(),
              messageCount: 1,
              firstMessage: 'hi',
              path: `/tmp/${s.id}.jsonl`,
            })),
          );

          const persistence = await createSessionPersistence({
            workspacePath: '/workspace',
            emitBlocked: () => {},
          });
          const result = await persistence.list('/workspace');

          const expected = sessions.filter((s) => s.cwd.startsWith(workspaceRealpath));
          expect(result.map((r) => r.id)).toEqual(expected.map((e) => e.id));
          return true;
        },
      ),
    );
  });

  it('list returns SessionInfo with path that points at the SDK JSONL file', async () => {
    mockRealpath.mockImplementation((p: string) => {
      if (p === '/workspace' || p === '/workspace/s1') return Promise.resolve('/workspace/real');
      return Promise.resolve('/other');
    });

    mockList.mockResolvedValue([makeSession('s1', '/workspace/s1', '/tmp/sessions/s1.jsonl')]);

    const persistence = await createSessionPersistence({
      workspacePath: '/workspace',
      emitBlocked: () => {},
    });
    const list = await persistence.list('/workspace');
    expect(list).toHaveLength(1);
    expect(list[0]?.path).toBe('/tmp/sessions/s1.jsonl');
  });
});
