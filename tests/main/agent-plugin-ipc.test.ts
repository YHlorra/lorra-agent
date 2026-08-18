import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PLUGINS_SCHEMA_V1_0_0 } from '../../src/shared/plugins-api';

// agent-plugins IPC（plan S2）：xray / setPluginEnabled / mcpAdd / mcpRemove / mcpSetEnabled。
// 通道参数校验 + PM 语域错误文案 + 启停/增删写 settings 往返。

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

import { registerAgentPluginsIpc } from '../../src/main/ipc/plugins-ipc';

const handler = (ch: string) => {
  const h = electronMock.handlers.get(ch);
  expect(h, ch).toBeDefined();
  return h!;
};

let userdata: string;
const settingsPath = () => path.join(userdata, 'settings.json');

function seedPlugin(name: string): void {
  const d = path.join(userdata, '.lorra', 'plugins', 'agent-plugins', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, 'plugin.json'),
    JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_V1_0_0, name }),
    'utf8',
  );
  mkdirSync(path.join(d, 'skills', 'greet'), { recursive: true });
  writeFileSync(
    path.join(d, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: d\n---\n',
    'utf8',
  );
}

describe('agent-plugins IPC', () => {
  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-agentplugin-ipc-'));
    electronMock.userData = userdata;
    electronMock.handlers.clear();
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    // 播种一个合法插件用于 xray（通过真实 agent-plugins root，agentPluginsRoot 走 LORRA_E2E_USERDATA）。
    seedPlugin('hello');
    // settings.json 含当前工作区，使 resolveWorkspacePath 有回退锚点。
    writeFileSync(settingsPath(), JSON.stringify({ recentWorkspaces: [userdata] }), 'utf8');
    registerAgentPluginsIpc();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    electronMock.handlers.clear();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('xray 返回插件清单（agent-plugin 技能并入，但 xray 只管 plugins/mcps）', async () => {
    const res = (await handler('lorra.plugins.xray')(null, {})) as {
      ok: boolean;
      value?: unknown;
    };
    expect(res.ok).toBe(true);
    const plugins = (res.value as { plugins: Array<{ name: string; skillCount: number }> }).plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('hello');
    expect(plugins[0].skillCount).toBe(1);
  });

  it('setPluginEnabled 参数校验：name 非空 + enabled boolean', async () => {
    const badName = (await handler('lorra.plugins.setPluginEnabled')(null, {
      name: '',
      enabled: true,
    })) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(badName.ok).toBe(false);
    expect(badName.error?.code).toBe('invalid-plugin-name');
    const badEnabled = (await handler('lorra.plugins.setPluginEnabled')(null, {
      name: 'a',
      enabled: 'yes',
    })) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(badEnabled.ok).toBe(false);
    expect(badEnabled.error?.code).toBe('invalid-enabled');
  });

  it('setPluginEnabled 停用写 disabledPlugins，xray 反映 enabled=false', async () => {
    const r = (await handler('lorra.plugins.setPluginEnabled')(null, {
      name: 'hello',
      enabled: false,
    })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(true);
    const xray = (await handler('lorra.plugins.xray')(null, {})) as {
      ok: boolean;
      value?: { plugins: Array<{ name: string; enabled: boolean }> };
    };
    expect(xray.value?.plugins[0].enabled).toBe(false);
  });

  it('mcpAdd 参数校验 + 写入 settings.mcpServers 往返', async () => {
    const bad = (await handler('lorra.plugins.mcpAdd')(null, { id: '', config: {} })) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('invalid-mcp-id');
    const okRes = (await handler('lorra.plugins.mcpAdd')(null, {
      id: 'svc',
      config: { type: 'streamable-http', url: 'https://x.example.com/mcp' },
    })) as { ok: boolean };
    expect(okRes.ok).toBe(true);
    // xray 应含 user-origin MCP
    const xray = (await handler('lorra.plugins.xray')(null, {})) as {
      ok: boolean;
      value?: { mcps: Array<{ id: string; origin: string }> };
    };
    const userMcp = xray.value?.mcps.find((m) => m.id === 'svc');
    expect(userMcp).toBeDefined();
    expect(userMcp?.origin).toBe('user');
  });

  it('mcpRemove 移除用户 MCP', async () => {
    await handler('lorra.plugins.mcpAdd')(null, {
      id: 'svc',
      config: { type: 'sse', url: 'https://y.example.com/sse' },
    });
    const r = (await handler('lorra.plugins.mcpRemove')(null, { id: 'svc' })) as { ok: boolean };
    expect(r.ok).toBe(true);
    const xray = (await handler('lorra.plugins.xray')(null, {})) as {
      ok: boolean;
      value?: { mcps: Array<{ id: string }> };
    };
    expect(xray.value?.mcps.find((m) => m.id === 'svc')).toBeUndefined();
  });

  it('mcpSetEnabled 启停用户 MCP', async () => {
    await handler('lorra.plugins.mcpAdd')(null, {
      id: 'svc',
      config: { type: 'streamable-http', url: 'https://x/mcp' },
    });
    const r = (await handler('lorra.plugins.mcpSetEnabled')(null, {
      id: 'svc',
      enabled: false,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    const xray = (await handler('lorra.plugins.xray')(null, {})) as {
      ok: boolean;
      value?: { mcps: Array<{ id: string; enabled: boolean }> };
    };
    expect(xray.value?.mcps.find((m) => m.id === 'svc')?.enabled).toBe(false);
  });
});
