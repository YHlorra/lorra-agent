import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAgentPluginManifest } from '../../src/main/agent-plugins/manifest';
import { AGENT_PLUGINS_SCHEMA_V1_0_0 } from '../../src/shared/plugins-api';

// Requirement（plan S1/S2）：plugin.json 封闭 schema 校验。
// 覆盖：合法 / 缺 $schema / name 非法 / 未知字段 warning / author 额外键 / 类型错。

let dir: string;

function writeManifest(name: string, obj: Record<string, unknown>): string {
  const d = path.join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'plugin.json'), JSON.stringify(obj), 'utf8');
  return d;
}

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: AGENT_PLUGINS_SCHEMA_V1_0_0, name: 'hello-plugin', ...overrides };
}

describe('agent-plugin manifest', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-agentplugin-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('合法最小清单：name + $schema 即过', async () => {
    const d = writeManifest('a', valid());
    const r = await readAgentPluginManifest(d);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.name).toBe('hello-plugin');
      expect(r.value.warnings).toEqual([]);
      expect(r.value.unknownKeys).toEqual([]);
    }
  });

  it('完整清单：version/description/author/homepage/repository/license/keywords 全保留', async () => {
    const d = writeManifest(
      'b',
      valid({
        version: '1.2.0',
        description: 'Brief plugin description',
        author: { name: 'Author', email: 'a@example.com', url: 'https://example.com' },
        homepage: 'https://docs.example.com',
        repository: 'https://github.com/example/p',
        license: 'MIT',
        keywords: ['a', 'b'],
      }),
    );
    const r = await readAgentPluginManifest(d);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.version).toBe('1.2.0');
      expect(r.value.author?.name).toBe('Author');
      expect(r.value.license).toBe('MIT');
      expect(r.value.keywords).toEqual(['a', 'b']);
    }
  });

  it('缺 $schema -> 致命', async () => {
    const d = writeManifest('c', { name: 'hello-plugin' });
    const r = await readAgentPluginManifest(d);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('manifest-fatal');
  });

  it('$schema 版本不符 -> 致命', async () => {
    const d = writeManifest(
      'd',
      valid({ $schema: 'https://agent-plugins.org/schemas/0.9.0/plugin.schema.json' }),
    );
    const r = await readAgentPluginManifest(d);
    expect(r.isErr()).toBe(true);
  });

  it('name 非法（大写/前导连字符/双点）-> 致命', async () => {
    for (const bad of ['My-Plugin', '-start', 'has--double', 'too..many', 'A']) {
      const d = writeManifest('e-' + bad, valid({ name: bad }));
      const r = await readAgentPluginManifest(d);
      expect(r.isErr(), bad).toBe(true);
    }
  });

  it('未知顶层字段 -> 非致命 warning 忽略', async () => {
    const d = writeManifest('f', valid({ extraThing: 123 }));
    const r = await readAgentPluginManifest(d);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.unknownKeys).toEqual(['extraThing']);
      expect(r.value.warnings.length).toBe(1);
    }
  });

  it('非对象 extensions -> 非致命 warning', async () => {
    const d = writeManifest('g', valid({ extensions: 'bad' }));
    const r = await readAgentPluginManifest(d);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.warnings.length).toBe(1);
  });

  it('author 含未知键 -> 致命', async () => {
    const d = writeManifest('h', valid({ author: { name: 'A', extra: 'x' } }));
    const r = await readAgentPluginManifest(d);
    expect(r.isErr()).toBe(true);
  });

  it('version/description/homepage 非字符串 -> 致命', async () => {
    const d = writeManifest('i', valid({ version: 2 }));
    const r = await readAgentPluginManifest(d);
    expect(r.isErr()).toBe(true);
  });

  it('keywords 非字符串数组 -> 致命', async () => {
    const d = writeManifest('j', valid({ keywords: [1, 2] }));
    const r = await readAgentPluginManifest(d);
    expect(r.isErr()).toBe(true);
  });

  it('plugin.json 不存在 -> manifest-read-failed', async () => {
    const d = path.join(dir, 'missing');
    mkdirSync(d, { recursive: true });
    const r = await readAgentPluginManifest(d);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('manifest-read-failed');
  });

  it('plugin.json 非法 JSON -> manifest-parse-failed', async () => {
    const d = path.join(dir, 'badjson');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'plugin.json'), 'not-json', 'utf8');
    const r = await readAgentPluginManifest(d);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('manifest-parse-failed');
  });
});
