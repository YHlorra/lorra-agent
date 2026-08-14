import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 设置 IPC:lorra.settings.get 返回 { showHiddenFiles, language },
// language 真源解析容错('en' 显式指定,其余落 zh)——变异测试发现解析分支
// 无测试覆盖,补此文件钉死。
const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userData: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, fn);
    },
  },
  app: {
    getPath: (name: string) => (name === 'userData' ? electronMock.userData : ''),
  },
}));

import { registerSettingsHandlers } from '../../src/main/ipc/settings-ipc';
import type { SerializedResult } from '../../src/shared/result';

type GetResult = SerializedResult<{
  showHiddenFiles: boolean;
  language: 'zh' | 'en';
  defaultHideThinking: boolean;
  compileModel: { providerId: string; modelId: string } | null;
  dataSources: { claudeCode: boolean; opencode: boolean; ohMyPi: boolean; workbuddy: boolean };
}>;

describe('lorra.settings.get/set(语言真源)', () => {
  let userdata: string;
  const settingsPath = () => path.join(userdata, 'settings.json');

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-settings-'));
    electronMock.userData = userdata;
    electronMock.handlers.clear();
    registerSettingsHandlers();
  });

  afterEach(() => {
    electronMock.handlers.clear();
    rmSync(userdata, { recursive: true, force: true });
  });

  async function get(): Promise<GetResult> {
    const handler = electronMock.handlers.get('lorra.settings.get');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('handler missing');
    return (await handler(null)) as GetResult;
  }

  it("settings.json language='en' 时 get 返回 en", async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ recentWorkspaces: [], showHiddenFiles: true, language: 'en' }),
      'utf8',
    );

    const res = await get();
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.value).toEqual({
        showHiddenFiles: true,
        language: 'en',
        defaultHideThinking: false,
        compileModel: null,
        dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
      });
    }
  });

  it('language 缺省/未知/损坏 → 落 zh,showHiddenFiles 落 false', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ recentWorkspaces: [], showHiddenFiles: true }),
      'utf8',
    );
    const missing = await get();
    expect(missing.status === 'ok' && missing.value.language).toBe('zh');
    expect(missing.status === 'ok' && missing.value.defaultHideThinking).toBe(false);

    writeFileSync(settingsPath(), JSON.stringify({ recentWorkspaces: [], language: 'ja' }), 'utf8');
    const unknown = await get();
    expect(unknown.status === 'ok' && unknown.value.language).toBe('zh');
    expect(unknown.status === 'ok' && unknown.value.showHiddenFiles).toBe(false);

    writeFileSync(settingsPath(), '{corrupt', 'utf8');
    const corrupt = await get();
    expect(corrupt.status === 'ok' && corrupt.value.language).toBe('zh');
  });

  it('set 带 language 写回后 get 读到同值', async () => {
    const setHandler = electronMock.handlers.get('lorra.settings.set');
    expect(setHandler).toBeDefined();
    if (!setHandler) throw new Error('handler missing');
    const setRes = (await setHandler(null, { language: 'en' })) as SerializedResult<void>;
    expect(setRes.status).toBe('ok');

    const res = await get();
    expect(res.status === 'ok' && res.value.language).toBe('en');
  });

  it('defaultHideThinking 缺省 → false;set 写回 true 后 get 读到同值且不影响其他字段', async () => {
    const fresh = await get();
    expect(fresh.status === 'ok' && fresh.value.defaultHideThinking).toBe(false);

    const setHandler = electronMock.handlers.get('lorra.settings.set');
    expect(setHandler).toBeDefined();
    if (!setHandler) throw new Error('handler missing');
    const setRes = (await setHandler(null, {
      defaultHideThinking: true,
      showHiddenFiles: true,
    })) as SerializedResult<void>;
    expect(setRes.status).toBe('ok');

    const after = await get();
    expect(after.status === 'ok' && after.value.defaultHideThinking).toBe(true);
    expect(after.status === 'ok' && after.value.showHiddenFiles).toBe(true);
    // 未显式写入的 language 保持缺省 zh。
    expect(after.status === 'ok' && after.value.language).toBe('zh');
  });
});

describe('lorra.settings compileModel（语义清洗模型）', () => {
  let userdata: string;
  const settingsPath = () => path.join(userdata, 'settings.json');

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-settings-'));
    electronMock.userData = userdata;
    electronMock.handlers.clear();
    registerSettingsHandlers();
  });

  afterEach(() => {
    electronMock.handlers.clear();
    rmSync(userdata, { recursive: true, force: true });
  });

  async function get(): Promise<GetResult> {
    const handler = electronMock.handlers.get('lorra.settings.get');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('handler missing');
    return (await handler(null)) as GetResult;
  }

  it('往返: set compileModel → get 读到同值;null 清除', async () => {
    const setHandler = electronMock.handlers.get('lorra.settings.set');
    expect(setHandler).toBeDefined();
    if (!setHandler) throw new Error('handler missing');

    const setRes = (await setHandler(null, {
      compileModel: { providerId: 'ollama', modelId: 'qwen2.5' },
    })) as SerializedResult<void>;
    expect(setRes.status).toBe('ok');

    const res = await get();
    expect(res.status === 'ok' && res.value.compileModel).toEqual({
      providerId: 'ollama',
      modelId: 'qwen2.5',
    });

    // null = 清除 → 回跟随默认
    const clearRes = (await setHandler(null, { compileModel: null })) as SerializedResult<void>;
    expect(clearRes.status).toBe('ok');
    const afterClear = await get();
    expect(afterClear.status === 'ok' && afterClear.value.compileModel).toBeNull();
  });

  it('非法形状落 null（不清除其他字段）', async () => {
    const setHandler = electronMock.handlers.get('lorra.settings.set');
    expect(setHandler).toBeDefined();
    if (!setHandler) throw new Error('handler missing');

    const bad = (await setHandler(null, {
      compileModel: { providerId: '', modelId: 'x' },
    })) as SerializedResult<void>;
    expect(bad.status).toBe('ok');

    const res = await get();
    expect(res.status === 'ok' && res.value.compileModel).toBeNull();
  });

  it('缺省 → null;settings.json 预置 compileModel 读回', async () => {
    const missing = await get();
    expect(missing.status === 'ok' && missing.value.compileModel).toBeNull();

    writeFileSync(
      settingsPath(),
      JSON.stringify({
        recentWorkspaces: [],
        compileModel: { providerId: 'openai', modelId: 'gpt-4o' },
      }),
      'utf8',
    );
    const preset = await get();
    expect(preset.status === 'ok' && preset.value.compileModel).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
  });
});

describe('lorra.settings dataSources（数据源开关）', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-settings-'));
    electronMock.userData = userdata;
    electronMock.handlers.clear();
    registerSettingsHandlers();
  });

  afterEach(() => {
    electronMock.handlers.clear();
    rmSync(userdata, { recursive: true, force: true });
  });

  async function get(): Promise<GetResult> {
    const handler = electronMock.handlers.get('lorra.settings.get');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('handler missing');
    return (await handler(null)) as GetResult;
  }

  it('缺省全关;set 单个开关写回后 get 读到同值,其余保持关闭', async () => {
    const missing = await get();
    expect(missing.status === 'ok' && missing.value.dataSources).toEqual({
      claudeCode: false,
      opencode: false,
      ohMyPi: false,
      workbuddy: false,
    });

    const setHandler = electronMock.handlers.get('lorra.settings.set');
    expect(setHandler).toBeDefined();
    if (!setHandler) throw new Error('handler missing');
    const setRes = (await setHandler(null, {
      dataSources: { claudeCode: true },
    })) as SerializedResult<void>;
    expect(setRes.status).toBe('ok');

    const res = await get();
    expect(res.status === 'ok' && res.value.dataSources).toEqual({
      claudeCode: true,
      opencode: false,
      ohMyPi: false,
      workbuddy: false,
    });
  });

  it('多开关累积: 逐次开启各自保留(合并语义)', async () => {
    const setHandler = electronMock.handlers.get('lorra.settings.set');
    expect(setHandler).toBeDefined();
    if (!setHandler) throw new Error('handler missing');
    await setHandler(null, { dataSources: { opencode: true } });
    await setHandler(null, { dataSources: { ohMyPi: true } });

    const res = await get();
    expect(res.status === 'ok' && res.value.dataSources).toEqual({
      claudeCode: false,
      opencode: true,
      ohMyPi: true,
      workbuddy: false,
    });
  });

  it('白名单: 非法键/非 true 值落 false', async () => {
    writeFileSync(
      path.join(userdata, 'settings.json'),
      JSON.stringify({
        recentWorkspaces: [],
        dataSources: { claudeCode: true, hacked: true, opencode: 'yes' },
      }),
      'utf8',
    );
    const res = await get();
    expect(res.status === 'ok' && res.value.dataSources).toEqual({
      claudeCode: true,
      opencode: false,
      ohMyPi: false,
      workbuddy: false,
    });
  });
});
