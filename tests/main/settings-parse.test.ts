import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// settings 新增字段（plan S2）：agentPluginRoot / disabledPlugins / mcpServers 的
// 解析 + 归一化容错（坏类型丢弃、向后兼容）。
const electronMock = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'userData' ? electronMock.userData : '') },
}));

import { readSettings } from '../../src/main/workspace/settings';

let userdata: string;
const settingsPath = () => path.join(userdata, 'settings.json');

describe('settings 新增字段解析（agentPluginRoot/disabledPlugins/mcpServers）', () => {
  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-settings-parse-'));
    electronMock.userData = userdata;
  });
  afterEach(() => {
    rmSync(userdata, { recursive: true, force: true });
  });

  it('无字段 -> 回退默认（agentPluginRoot 空串 / disabledPlugins [] / mcpServers {}）', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ recentWorkspaces: [] }), 'utf8');
    const s = await readSettings();
    expect(s.agentPluginRoot).toBe('');
    expect(s.disabledPlugins).toEqual([]);
    expect(s.mcpServers).toEqual({});
  });

  it('合法字段全保留', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        recentWorkspaces: [],
        agentPluginRoot: 'E:/x/plugins',
        disabledPlugins: ['a', 'b'],
        mcpServers: { svc: { type: 'stdio', command: 'node', args: ['x'] } },
      }),
      'utf8',
    );
    const s = await readSettings();
    expect(s.agentPluginRoot).toBe('E:/x/plugins');
    expect(s.disabledPlugins).toEqual(['a', 'b']);
    expect(s.mcpServers?.svc?.command).toBe('node');
  });

  it('mcpServers 非法条目（type 非法/非对象）丢弃', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        recentWorkspaces: [],
        mcpServers: {
          good: { type: 'streamable-http', url: 'https://x/mcp' },
          badType: { type: 'garbage' },
          notObj: 'nope',
        },
      }),
      'utf8',
    );
    const s = await readSettings();
    expect(Object.keys(s.mcpServers ?? {})).toEqual(['good']);
  });

  it('disabledPlugins 非数组 -> 回退 []', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ recentWorkspaces: [], disabledPlugins: 'x' }),
      'utf8',
    );
    const s = await readSettings();
    expect(s.disabledPlugins).toEqual([]);
  });
});
