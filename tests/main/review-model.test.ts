import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LorraError } from '../../src/shared/result';

// 复审 #N2:超时误映射 model-unavailable —— review-model 的错误映射正则把
// 'timed out' 吞进 model-unavailable。钉死契约:纯函数 mapReviewError(err) 三类分类：
// 超时 → code 'review-timed-out'（message 含「超时」+ 重试指引）
// 无模型/认证缺失（No API key/Authentication failed/no model 等）→ 'model-unavailable'
// 其他 → 'review-generation-failed'
// 新增:createCompileModelInvoke 的 compileModel 解析分支
// （已配置 getModel 命中 → 传 model;getModel 未命中/未配置 → 走默认不传）。
// mapReviewError 是纯函数,不依赖 SDK —— mock 掉 pi-coding-agent 保持导入图轻量。

const sdkMock = vi.hoisted(() => ({
  createAgentSessionServices: vi.fn(),
  createAgentSessionFromServices: vi.fn(),
  inMemory: vi.fn(),
  getModel: vi.fn(),
  userData: '',
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: { inMemory: (...args: unknown[]) => sdkMock.inMemory(...args) },
  createAgentSessionFromServices: (...args: unknown[]) =>
    sdkMock.createAgentSessionFromServices(...args),
  createAgentSessionServices: (...args: unknown[]) => sdkMock.createAgentSessionServices(...args),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? sdkMock.userData : ''),
  },
}));

import { createCompileModelInvoke, mapReviewError } from '../../src/main/memory/review-model';

/** 组装一个可应答的假会话(prompt 写 fileEntries,返回文本)。 */
function makeSession(options?: { model?: unknown; answer?: string }) {
  return {
    model: options?.model ?? {},
    dispose: vi.fn(),
    abort: vi.fn(),
    prompt: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
    }),
    sessionManager: {
      fileEntries: [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: options?.answer ?? 'answer' }],
          },
        },
      ],
    },
  };
}

describe('mapReviewError', () => {
  it('超时 -> review-timed-out, message 含「超时」与重试指引', () => {
    const cases: unknown[] = [
      'review generation timed out',
      'request timed out after 120s',
      'the operation timed out',
      'Timeout exceeded',
      new Error('ETIMEDOUT'),
    ];
    for (const c of cases) {
      const e: LorraError = mapReviewError(c);
      expect(e.code).toBe('review-timed-out');
      expect(e.message).toMatch(/超时/);
      expect(e.message).toMatch(/重试/);
    }
  });

  it('无模型/认证缺失 -> model-unavailable', () => {
    const cases: unknown[] = [
      'No API key found',
      'Authentication failed: invalid credentials',
      'no model configured',
      'login required',
      new Error('credentials expired'),
    ];
    for (const c of cases) {
      expect(mapReviewError(c).code).toBe('model-unavailable');
    }
  });

  it('其他错误 -> review-generation-failed', () => {
    const cases: unknown[] = [
      'Connection refused',
      'ECONNREFUSED',
      new Error('boom'),
      42,
      { unexpected: 'shape' },
      '',
    ];
    for (const c of cases) {
      expect(mapReviewError(c).code).toBe('review-generation-failed');
    }
  });
});

describe('createCompileModelInvoke（compileModel 解析分支）', () => {
  let userdata: string;
  const settingsPath = () => path.join(userdata, 'settings.json');

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-compile-model-'));
    sdkMock.userData = userdata;
    sdkMock.createAgentSessionServices.mockResolvedValue({
      modelRuntime: { getModel: sdkMock.getModel },
    });
    sdkMock.inMemory.mockReturnValue({});
    sdkMock.getModel.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sdkMock.createAgentSessionServices.mockReset();
    sdkMock.createAgentSessionFromServices.mockReset();
    sdkMock.inMemory.mockReset();
    rmSync(userdata, { recursive: true, force: true });
  });

  function stubSettings(compileModel: unknown): void {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        recentWorkspaces: [],
        ...(compileModel !== undefined ? { compileModel } : {}),
      }),
      'utf8',
    );
  }

  it('已配置且 getModel 命中 → createAgentSessionFromServices 收到解析出的 model', async () => {
    stubSettings({ providerId: 'ollama', modelId: 'qwen2.5' });
    const resolvedModel = { providerId: 'ollama', modelId: 'qwen2.5' };
    sdkMock.getModel.mockReturnValue(resolvedModel);
    sdkMock.createAgentSessionFromServices.mockResolvedValue({
      session: makeSession({ model: resolvedModel }),
    });

    const invoke = createCompileModelInvoke();
    const result = await invoke('hello');

    expect(result.isOk()).toBe(true);
    expect(sdkMock.getModel).toHaveBeenCalledWith('ollama', 'qwen2.5');
    const options = sdkMock.createAgentSessionFromServices.mock.calls[0][0] as {
      model?: unknown;
    };
    expect(options.model).toBe(resolvedModel);
  });

  it('已配置但 getModel 未命中 → console.warn,不传 model(走默认)', async () => {
    stubSettings({ providerId: 'ollama', modelId: 'ghost' });
    sdkMock.getModel.mockReturnValue(undefined);
    sdkMock.createAgentSessionFromServices.mockResolvedValue({
      session: makeSession(),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const invoke = createCompileModelInvoke();
    const result = await invoke('hello');

    expect(result.isOk()).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    const options = sdkMock.createAgentSessionFromServices.mock.calls[0][0] as {
      model?: unknown;
    };
    expect(options.model).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('未配置(compileModel 缺省)→ 不调 getModel,不传 model', async () => {
    stubSettings(undefined);
    sdkMock.createAgentSessionFromServices.mockResolvedValue({
      session: makeSession(),
    });

    const invoke = createCompileModelInvoke();
    const result = await invoke('hello');

    expect(result.isOk()).toBe(true);
    expect(sdkMock.getModel).not.toHaveBeenCalled();
    const options = sdkMock.createAgentSessionFromServices.mock.calls[0][0] as {
      model?: unknown;
    };
    expect(options.model).toBeUndefined();
  });
});
