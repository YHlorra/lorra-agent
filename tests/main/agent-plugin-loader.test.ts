import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectAgentPluginSkillPaths,
  loadAgentPlugins,
} from '../../src/main/agent-plugins/loader';
import { AGENT_PLUGINS_SCHEMA_V1_0_0, MCP_SCHEMA_V1_0_0 } from '../../src/shared/plugins-api';

// Requirement（plan S2）：插件目录发现、skills（直接子目录不递归）、mcp.json 三型、
// 单插件/单 mcp 失败不影响其它、启停名单、技能根收集。

let root: string;

function plugin(name: string, files: Record<string, string>): string {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  return d;
}

function manifest(name: string): string {
  return JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_V1_0_0, name });
}

const SKILL = '---\nname: greet\ndescription: Greet user.\n---\n\nGreet.\n';

describe('agent-plugin loader', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lorra-agentplugin-load-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('空根 -> 空清单', async () => {
    const r = await loadAgentPlugins({ root });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.plugins).toEqual([]);
      expect(r.value.mcps).toEqual([]);
    }
  });

  it('发现 skills 直接子目录（含 SKILL.md），不递归', async () => {
    plugin('p1', {
      'plugin.json': manifest('p1'),
      'skills/greet/SKILL.md': SKILL,
      'skills/greet/sub/nested/SKILL.md': SKILL, // 递归子目录不应被发现
      'skills/noprob/{no skill}': 'x',
    });
    const r = await loadAgentPlugins({ root });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.plugins).toHaveLength(1);
      expect(r.value.plugins[0].name).toBe('p1');
      expect(r.value.plugins[0].skillCount).toBe(1); // 仅 greet；nested 递归不计数
    }
    const paths = await collectAgentPluginSkillPaths({ root });
    expect(paths).toHaveLength(1);
    expect(paths[0].skillsRoot).toBe(path.join(root, 'p1', 'skills'));
  });

  it('mcp.json 三型（stdio/streamable-http/sse）正确载入 + sse 标 unsupported', async () => {
    plugin('p2', {
      'plugin.json': manifest('p2'),
      'mcp.json': JSON.stringify({
        $schema: MCP_SCHEMA_V1_0_0,
        mcpServers: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: 测试占位符 cwd 语义，非模板插值。
          'svc-stdio': { type: 'stdio', command: './bin/x', args: ['--a'], cwd: '${PLUGIN_ROOT}' },
          'svc-http': { type: 'streamable-http', url: 'https://x.example.com/mcp' },
          'svc-sse': { type: 'sse', url: 'https://y.example.com/sse' },
        },
      }),
    });
    const r = await loadAgentPlugins({ root });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.plugins[0].mcpCount).toBe(3);
      const stdio = r.value.mcps.find((m) => m.id === 'svc-stdio');
      const sse = r.value.mcps.find((m) => m.id === 'svc-sse');
      expect(stdio?.type).toBe('stdio');
      expect(stdio?.origin).toBe('plugin');
      expect(sse?.health).toBe('unsupported');
    }
  });

  it('单 mcp 校验失败 -> 跳过该 server 记 issue，不影响其它', async () => {
    const bad = JSON.stringify({
      $schema: MCP_SCHEMA_V1_0_0,
      mcpServers: {
        good: { type: 'streamable-http', url: 'https://a.example.com/mcp' },
        bad: { type: 'stdio', command: '' },
        'bad-env': { type: 'stdio', command: 'x', env: { PLUGIN_ROOT: 'nope' } },
      },
    });
    plugin('p3', { 'plugin.json': manifest('p3'), 'mcp.json': bad });
    const r = await loadAgentPlugins({ root });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.plugins[0].mcpCount).toBe(1); // 仅 good
      expect(r.value.mcps).toHaveLength(1);
    }
  });

  it('manifest 致命 -> 该插件 error issues，name 回退目录名，不加载 skills/mcp', async () => {
    plugin('broken', { 'plugin.json': JSON.stringify({ name: 'BAD' }) }); // 缺 $schema
    plugin('ok', { 'plugin.json': manifest('ok'), 'skills/g/SKILL.md': SKILL });
    const r = await loadAgentPlugins({ root });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const broken = r.value.plugins.find((p) => p.name === 'broken');
      const okp = r.value.plugins.find((p) => p.name === 'ok');
      expect(broken?.issues.length).toBeGreaterThan(0);
      expect(broken?.skillCount).toBe(0);
      expect(okp?.skillCount).toBe(1);
    }
  });

  it('disabled 名单 -> plugin.enabled=false，skill paths 收集排除', async () => {
    plugin('a', { 'plugin.json': manifest('a'), 'skills/g/SKILL.md': SKILL });
    plugin('b', { 'plugin.json': manifest('b'), 'skills/h/SKILL.md': SKILL });
    const r = await loadAgentPlugins({ root, disabled: new Set(['a']) });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.plugins.find((p) => p.name === 'a')?.enabled).toBe(false);
      expect(r.value.plugins.find((p) => p.name === 'b')?.enabled).toBe(true);
    }
    const paths = await collectAgentPluginSkillPaths({ root, disabled: new Set(['a']) });
    expect(paths).toHaveLength(1);
    expect(paths[0].pluginName).toBe('b');
  });

  it('跳过 _template 与点目录', async () => {
    plugin('_template', { 'plugin.json': manifest('_template') });
    plugin('.hidden', { 'plugin.json': manifest('.hidden') });
    plugin('real', { 'plugin.json': manifest('real') });
    const r = await loadAgentPlugins({ root });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.plugins.map((p) => p.name)).toEqual(['real']);
    }
  });

  it('无 skills 目录 / 无 mcp.json -> 合法空组件', async () => {
    plugin('minimal', { 'plugin.json': manifest('minimal') });
    const r = await loadAgentPlugins({ root });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.plugins[0].skillCount).toBe(0);
      expect(r.value.plugins[0].mcpCount).toBe(0);
    }
  });
});
