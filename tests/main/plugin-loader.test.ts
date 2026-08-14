import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPlugins } from '../../src/main/ofk/plugin-loader';
import { pluginsRoot } from '../../src/main/ofk/plugin-template-seed';
import { freshUserData } from './ofk-test-fixtures';

// Requirement(step 3):合法插件加载 + collect 包装(元素校验/补全);
// plugin.json 非法/import 抛错 → status:'error' 不影响其他插件;collect 返回
// 非法元素剔除;插件目录 = LORRA_E2E_USERDATA tmp。

const ISO = '2026-08-08T01:00:00.000Z';

function writePlugin(dir: string, files: Record<string, string>): void {
  mkdirSync(path.join(pluginsRoot(), 'collectors', dir), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(pluginsRoot(), 'collectors', dir, name), content, 'utf8');
  }
}

const GOOD_INDEX = `export async function collect() {
  return [
    {
      sessionRef: 'plugin-1',
      scope: 'workspace',
      summaryRef: null,
      privacy: 'public_safe',
      workspace: 'E:/work/demo',
      start: '${ISO}',
      end: '${ISO}',
      activeMs: 60000,
      tokens: 100,
      title: '插件会话',
      model: '',
      tools: ['read'],
      unfinished: false,
      containsTodo: false,
    },
    {
      sessionRef: 'plugin-bad',
      scope: 'nonsense',
      summaryRef: null,
      privacy: 'public_safe',
      workspace: 'E:/work/demo',
      start: '${ISO}',
      end: '${ISO}',
      activeMs: 1,
      tokens: 1,
      title: 'x',
      model: '',
      tools: [],
      unfinished: false,
      containsTodo: false,
    },
  ];
}
`;

describe('plugin-loader', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = freshUserData();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('合法插件加载:collect 包装返回补全后的 SessionFact[](schemaVersion/collector/factId)', async () => {
    writePlugin('good', {
      'plugin.json': JSON.stringify({
        name: 'good',
        runtime: 'good-runtime',
        description: '好插件',
        main: 'index.mjs',
      }),
      'index.mjs': GOOD_INDEX,
    });

    const plugins = await loadPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('good');
    expect(plugins[0].runtime).toBe('good-runtime');
    expect(plugins[0].status).toBe('ok');

    const result = await plugins[0].collect();
    expect(result.isOk()).toBe(true);
    const facts = result.unwrapOr([]);
    // 非法元素(scope 不在枚举)被剔除 → 仅 1 条
    expect(facts).toHaveLength(1);
    expect(facts[0].sessionRef).toBe('plugin-1');
    expect(facts[0].collector).toBe('good');
    expect(facts[0].runtime).toBe('good');
    expect(facts[0].agentId).toBe('good');
    expect(facts[0].schemaVersion).toBe(1);
    expect(facts[0].factId).toHaveLength(64);
    // start/end ISO → epoch 归一化
    expect(facts[0].start).toBe(Date.parse(ISO));
  });

  it('plugin.json 非法 → status error,不影响其他插件', async () => {
    writePlugin('bad-json', {
      'plugin.json': 'not-json',
      'index.mjs': GOOD_INDEX,
    });
    writePlugin('good', {
      'plugin.json': JSON.stringify({
        name: 'good',
        runtime: 'good-runtime',
        description: 'd',
        main: 'index.mjs',
      }),
      'index.mjs': GOOD_INDEX,
    });

    const plugins = await loadPlugins();
    const byName = new Map(plugins.map((p) => [p.name, p]));
    expect(byName.get('bad-json')?.status).toBe('error');
    expect(byName.get('bad-json')?.error).toContain('plugin.json');
    expect(byName.get('good')?.status).toBe('ok');
  });

  it('name 不匹配白名单 → status error', async () => {
    writePlugin('bad-name', {
      'plugin.json': JSON.stringify({
        name: 'BAD NAME!',
        runtime: 'r',
        description: 'd',
        main: 'index.mjs',
      }),
      'index.mjs': GOOD_INDEX,
    });
    const plugins = await loadPlugins();
    expect(plugins[0].status).toBe('error');
  });

  it('import 抛错 → status error,collect 不 throw', async () => {
    writePlugin('bad-import', {
      'plugin.json': JSON.stringify({
        name: 'bad-import',
        runtime: 'r',
        description: 'd',
        main: 'index.mjs',
      }),
      'index.mjs': 'throw new Error("boom")',
    });
    const plugins = await loadPlugins();
    expect(plugins[0].status).toBe('error');
    expect(plugins[0].error).toContain('boom');
  });

  it('collect 抛错/返回非数组 → Err 不 throw', async () => {
    writePlugin('thrower', {
      'plugin.json': JSON.stringify({
        name: 'thrower',
        runtime: 'r',
        description: 'd',
        main: 'index.mjs',
      }),
      'index.mjs': 'export async function collect() { throw new Error("collect boom"); }',
    });
    writePlugin('notarray', {
      'plugin.json': JSON.stringify({
        name: 'notarray',
        runtime: 'r',
        description: 'd',
        main: 'index.mjs',
      }),
      'index.mjs': 'export async function collect() { return { a: 1 }; }',
    });

    const plugins = await loadPlugins();
    const thrower = plugins.find((p) => p.name === 'thrower');
    const notarray = plugins.find((p) => p.name === 'notarray');
    expect(thrower).toBeDefined();
    expect(notarray).toBeDefined();
    if (!thrower || !notarray) throw new Error('plugins missing');
    const a = await thrower.collect();
    expect(a.isErr()).toBe(true);
    expect(a.match({ ok: () => '', err: (e) => e.code })).toBe('plugin-collect-failed');
    const b = await notarray.collect();
    expect(b.isErr()).toBe(true);
  });

  it('字段类型校验:缺字段/非法时间戳剔除', async () => {
    writePlugin('badfields', {
      'plugin.json': JSON.stringify({
        name: 'badfields',
        runtime: 'r',
        description: 'd',
        main: 'index.mjs',
      }),
      'index.mjs': `export async function collect() {
        return [
          { sessionRef: 'a', title: 't', workspace: 'w', scope: 'workspace', summaryRef: null, privacy: 'public_safe', start: 'not-a-date', end: '${ISO}', activeMs: 1, tokens: 1, tools: [], unfinished: false, containsTodo: false },
          { sessionRef: 'b', title: 't', workspace: 'w', scope: 'workspace', summaryRef: null, privacy: 'public_safe', start: '${ISO}', end: '${ISO}', activeMs: 'x', tokens: 1, tools: [], unfinished: false, containsTodo: false },
        ];
      }`,
    });
    const plugins = await loadPlugins();
    const result = await plugins[0].collect();
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toHaveLength(0);
  });

  it('无插件目录 → []', async () => {
    const plugins = await loadPlugins();
    expect(plugins).toEqual([]);
  });
});
