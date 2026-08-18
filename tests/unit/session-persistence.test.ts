import { mkdtempSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionPersistence } from '../../src/main/pi-sdk-driver/session-persistence';

// Mock the SDK at module level: SessionManager statics are the seam under
// test, and buildAgentSession's service wiring is not what we assert here.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    create: vi.fn(),
    inMemory: vi.fn(),
    open: vi.fn(),
    continueRecent: vi.fn(),
    list: vi.fn(),
  },
  createAgentSessionFromServices: vi.fn(),
  createAgentSessionServices: vi.fn(),
  createEventBus: vi.fn(() => ({})),
  createExtensionRuntime: vi.fn(() => ({})),
}));

const smCreate = vi.mocked(SessionManager.create);
const smInMemory = vi.mocked(SessionManager.inMemory);
const smList = vi.mocked(SessionManager.list);
const smOpen = vi.mocked(SessionManager.open);
const buildSession = vi.mocked(createAgentSessionFromServices);
const createServices = vi.mocked(createAgentSessionServices);

let ws: string;
let wsReal: string;

beforeEach(async () => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'lorra-sp-test-'));
  wsReal = await realpath(ws);
  vi.stubEnv('LORRA_E2E_USERDATA', ws); // lorraConfigDir lands in the temp dir
  vi.clearAllMocks();
  buildSession.mockResolvedValue({
    session: { sessionId: 'sid', extensionRunner: { extensions: [] } },
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function sessionInfo(partial: Record<string, unknown>) {
  return {
    cwd: wsReal,
    created: new Date(),
    modified: new Date(),
    messageCount: 0,
    firstMessage: '',
    ...partial,
  };
}

describe('session-persistence', () => {
  it('createInMemory persists a new session via SessionManager.create (not inMemory)', async () => {
    smCreate.mockReturnValue({} as never);
    const persistence = await createSessionPersistence({
      workspacePath: ws,
      emitBlocked: () => {},
    });

    const handle = await persistence.createInMemory(ws);

    expect(handle.sessionId).toBe('sid');
    expect(smInMemory).not.toHaveBeenCalled();
    expect(smCreate).toHaveBeenCalledTimes(1);
    const [cwd, sessionDir] = smCreate.mock.calls[0];
    expect(cwd).toBe(ws);
    // Persisted under the lorra session tree, not the SDK default ~/.pi/...
    const safe = `--${ws.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    expect(sessionDir).toBe(path.join(ws, '.lorra', 'sessions', safe));
  });

  it('list() surfaces a persisted session with messages and drops header-only (messageCount 0)', async () => {
    smList.mockResolvedValue([
      sessionInfo({ id: 'full', messageCount: 3, firstMessage: 'hi' }),
      sessionInfo({ id: 'empty', messageCount: 0, firstMessage: '' }),
    ] as never);
    const persistence = await createSessionPersistence({
      workspacePath: ws,
      emitBlocked: () => {},
    });

    const result = await persistence.list(ws);

    expect(result.map((s) => s.id)).toEqual(['full']);
  });

  it('open() builds an AgentSession from a persisted session path', async () => {
    smOpen.mockReturnValue({} as never);
    const persistence = await createSessionPersistence({
      workspacePath: ws,
      emitBlocked: () => {},
    });

    const handle = await persistence.open(path.join(ws, 'sessions', 'full.jsonl'));

    expect(handle.sessionId).toBe('sid');
    expect(smOpen).toHaveBeenCalledWith(
      path.join(ws, 'sessions', 'full.jsonl'),
      expect.stringContaining(path.join('.lorra', 'sessions')),
    );
    // Code search opened + web tools exposed: the tools array is the SDK
    // allowedToolNames whitelist that also gates customTools registration
    // (tools missing here are registered but never reach the model), so the
    // assertion covers all deliberately-open tools.
    expect(buildSession.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        tools: [
          'read',
          'write',
          'edit',
          'bash',
          'grep',
          'find',
          'ls',
          'web_search',
          'web_fetch',
          'update_plan',
          'memory',
          'install_skill',
          'knowledge',
        ],
      }),
    );
  });

  it('追加 lorra 专属系统提示词:createAgentSessionServices 收到 systemPromptOverride(含身份+路径)', async () => {
    smOpen.mockReturnValue({} as never);
    const persistence = await createSessionPersistence({
      workspacePath: ws,
      emitBlocked: () => {},
    });

    await persistence.open(path.join(ws, 'sessions', 'full.jsonl'));

    // resourceLoaderOptions.systemPromptOverride 传到 SDK 服务构造函数
    // (2026-08-15 系统提示词批:整体替换,appendSystemPromptOverride 清空)。
    const servicesArg = createServices.mock.calls[0]?.[0] as {
      resourceLoaderOptions?: { systemPromptOverride?: () => string };
    };
    const systemPrompt = servicesArg.resourceLoaderOptions?.systemPromptOverride;
    expect(systemPrompt).toBeTypeOf('function');
    const prompt = systemPrompt?.() ?? '';
    // 身份 + 运行时路径 + 专属工具都在(证明 lorra 段落确实接上了)。
    expect(prompt).toContain('lorra 工作台');
    expect(prompt).toContain('.lorra');
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('memory');
  });
});
