import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 设置页「最近工作区」移除 IPC(lorra.workspace.remove):readSettings →
// filter → writeSettings 原子持久化,返回新列表。不处理激活项(UI 层禁止)。

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
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
}));

import { registerWorkspaceHandlers } from '../../src/main/workspace/ipc';

const stubActivation = {
  activate: async () => {},
  deactivate: async () => {},
  getActivePath: () => null,
};

describe('lorra.workspace.remove(设置页最近工作区移除)', () => {
  let userdata: string;
  const settingsPath = () => path.join(userdata, 'settings.json');

  function seedSettings(recentWorkspaces: string[]): void {
    writeFileSync(settingsPath(), JSON.stringify({ recentWorkspaces }), 'utf8');
  }

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-ws-remove-'));
    electronMock.userData = userdata;
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    electronMock.handlers.clear();
    registerWorkspaceHandlers(stubActivation);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    electronMock.handlers.clear();
    rmSync(userdata, { recursive: true, force: true });
  });

  async function remove(pathArg: string) {
    const handler = electronMock.handlers.get('lorra.workspace.remove');
    expect(handler).toBeDefined();
    return (await handler!(null, { path: pathArg })) as { workspaces: string[] };
  }

  it('移除指定路径,保留其余条目', async () => {
    seedSettings(['/ws/a', '/ws/b', '/ws/c']);

    const result = await remove('/ws/b');

    expect(result.workspaces).toEqual(['/ws/a', '/ws/c']);
    // 持久化生效:重读文件与返回值一致。
    const persisted = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(persisted.recentWorkspaces).toEqual(['/ws/a', '/ws/c']);
  });

  it('移除不存在的路径:列表原样返回,不报错', async () => {
    seedSettings(['/ws/a', '/ws/b']);

    const result = await remove('/ws/nope');

    expect(result.workspaces).toEqual(['/ws/a', '/ws/b']);
  });

  it('空列表安全:移除任意路径返回空列表,不抛错', async () => {
    seedSettings([]);

    const result = await remove('/ws/a');

    expect(result.workspaces).toEqual([]);
  });

  it('移除后其余设置字段(showHiddenFiles/language/defaultHideThinking)不被清空', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        recentWorkspaces: ['/ws/a', '/ws/b'],
        showHiddenFiles: true,
        language: 'en',
        defaultHideThinking: true,
      }),
      'utf8',
    );

    await remove('/ws/a');

    const persisted = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(persisted.recentWorkspaces).toEqual(['/ws/b']);
    expect(persisted.showHiddenFiles).toBe(true);
    expect(persisted.language).toBe('en');
    expect(persisted.defaultHideThinking).toBe(true);
  });
});
