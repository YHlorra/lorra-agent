import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PLUGINS_SCHEMA_V1_0_0 } from '../../src/shared/plugins-api';

// plan S4: 本地导入（校验 + 复制 + 回滚回收站）+ 脚手架生成。
const electronMock = vi.hoisted(() => ({ trashed: [] as string[] }));
vi.mock('electron', () => ({
  shell: {
    trashItem: async (p: string) => {
      electronMock.trashed.push(p);
    },
  },
}));

import {
  createAgentPluginScaffold,
  installAgentPluginFromFolder,
} from '../../src/main/agent-plugins/install';

let srcRoot: string;
let dstRoot: string;

function writePlugin(dir: string, name: string): string {
  const d = path.join(dir, name);
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
  return d;
}

describe('agent-plugin install/create', () => {
  beforeEach(() => {
    srcRoot = mkdtempSync(path.join(tmpdir(), 'lorra-ap-src-'));
    dstRoot = mkdtempSync(path.join(tmpdir(), 'lorra-ap-dst-'));
    electronMock.trashed.length = 0;
  });
  afterEach(() => {
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(dstRoot, { recursive: true, force: true });
  });

  it('本地导入：合法 plugin.json 复制到插件根', async () => {
    const src = writePlugin(srcRoot, 'hello');
    const r = await installAgentPluginFromFolder(src, { root: dstRoot });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.name).toBe('hello');
      expect(path.basename(r.value.path)).toBe('hello');
    }
    expect(readFileSync(path.join(dstRoot, 'hello', 'plugin.json'), 'utf8')).toContain('hello');
    expect(
      readFileSync(path.join(dstRoot, 'hello', 'skills', 'greet', 'SKILL.md'), 'utf8'),
    ).toContain('greet');
  });

  it('缺 plugin.json → not-a-plugin', async () => {
    const d = path.join(srcRoot, 'empty');
    mkdirSync(d, { recursive: true });
    const r = await installAgentPluginFromFolder(d, { root: dstRoot });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('not-a-plugin');
  });

  it('manifest 致命（name 非法）→ not-a-plugin', async () => {
    const d = path.join(srcRoot, 'bad');
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, 'plugin.json'),
      JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_V1_0_0, name: 'BAD NAME' }),
      'utf8',
    );
    const r = await installAgentPluginFromFolder(d, { root: dstRoot });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('not-a-plugin');
  });

  it('同名已存在 → plugin-exists', async () => {
    const src = writePlugin(srcRoot, 'dup');
    await installAgentPluginFromFolder(src, { root: dstRoot });
    const r = await installAgentPluginFromFolder(src, { root: dstRoot });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('plugin-exists');
  });

  it('脚手架：生成合法 plugin.json + skills + 空 mcp.json', async () => {
    const r = await createAgentPluginScaffold('new-plugin', { root: dstRoot });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.name).toBe('new-plugin');
    const pj = JSON.parse(readFileSync(path.join(dstRoot, 'new-plugin', 'plugin.json'), 'utf8'));
    expect(pj.$schema).toBe(AGENT_PLUGINS_SCHEMA_V1_0_0);
    expect(pj.name).toBe('new-plugin');
    expect(
      readFileSync(path.join(dstRoot, 'new-plugin', 'skills', 'new-plugin', 'SKILL.md'), 'utf8'),
    ).toContain('new-plugin');
    expect(readFileSync(path.join(dstRoot, 'new-plugin', 'mcp.json'), 'utf8')).toContain(
      'mcpServers',
    );
  });

  it('脚手架同名已存在 → plugin-exists', async () => {
    await createAgentPluginScaffold('x', { root: dstRoot });
    const r = await createAgentPluginScaffold('x', { root: dstRoot });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('plugin-exists');
  });
});
