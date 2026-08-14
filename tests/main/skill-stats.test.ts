import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSkillStats,
  type SkillStatsInput,
  UNKNOWN_WORKSPACE,
} from '../../src/main/skills/skill-stats';
import type { Result } from '../../src/shared/result';
import type { SkillStats } from '../../src/shared/skills-api';
import { SKILL_STATS_JSONL_BYTES_MAX, SKILL_STATS_WINDOW_DAYS } from '../../src/shared/skills-api';

/** 固定基准时刻：窗口/触发时刻全部相对它断言，测试确定性（不依赖真实时钟）。 */
const NOW = Date.parse('2026-08-08T12:00:00.000Z');
const W45 = SKILL_STATS_WINDOW_DAYS * 86_400_000;

type ToolShape = 'toolCall' | 'toolUse' | 'tool_use';

/** 会话条目：扁平 cwd 字段，无 header 包装（勘误 2 实证形状）。 */
function sessionLine(cwd?: unknown): string {
  const o: Record<string, unknown> = {
    type: 'session',
    version: 3,
    id: 'sess',
    timestamp: new Date(NOW).toISOString(),
  };
  if (cwd !== undefined) o.cwd = cwd;
  return JSON.stringify(o);
}

/** 工具块三形状：toolCall+arguments（当前）/ toolUse+input / tool_use+input（snake 旧形状）。 */
function toolBlock(
  shape: ToolShape,
  name: string,
  field: 'arguments' | 'input',
  p: string,
): Record<string, unknown> {
  return { type: shape, name, [field]: { path: p } };
}

function msgLine(id: string, tsMs: number, blocks: unknown[]): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(tsMs).toISOString(),
    message: { role: 'assistant', content: blocks },
  });
}

/** 目录形技能输入（rootDir = 技能根 realpath，命中判定边界）。 */
function dirSkill(name: string, rootDir: string): SkillStatsInput {
  return { name, realPath: path.join(rootDir, 'SKILL.md'), rootDir };
}

/** 平铺 .md 技能输入（rootDir = 平铺文件所在根，与兄弟平铺技能共享）。 */
function flatSkill(name: string, rootDir: string): SkillStatsInput {
  return { name, realPath: path.join(rootDir, `${name}.md`), rootDir };
}

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw new Error(`unexpected err: ${error.code}: ${error.message}`);
    },
  });
}

describe('skill-stats（jsonl 触发统计，V1-3）', () => {
  let userData: string;
  let wsA: string;
  let wsB: string;

  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'lorra-stats-'));
    wsA = mkdtempSync(path.join(tmpdir(), 'lorra-stats-ws-a-'));
    wsB = mkdtempSync(path.join(tmpdir(), 'lorra-stats-ws-b-'));
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  });

  /** 写入 <userData>/sessions/<relDir>/<fileName>，返回完整路径。 */
  function writeSession(relDir: string, fileName: string, content: string): string {
    const dir = path.join(userData, 'sessions', relDir);
    mkdirSync(dir, { recursive: true });
    const full = path.join(dir, fileName);
    writeFileSync(full, content, 'utf8');
    return full;
  }

  function statOf(
    skills: SkillStatsInput[],
    opts: { now?: number } = {},
  ): Promise<Record<string, SkillStats>> {
    return getSkillStats(skills, { now: opts.now ?? NOW, userDataDir: userData }).then(expectOk);
  }

  it('正常命中（toolCall 当前形状 + arguments.path）→ 计数/触发时刻/工作区归桶', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'mmx-cli');
    const hitAt = NOW - 60_000;
    writeSession(
      'ws-a',
      's1.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', hitAt, [
          toolBlock('toolCall', 'read', 'arguments', path.join(root, 'SKILL.md')),
        ]),
      ].join('\n')}\n`,
    );

    const out = await statOf([dirSkill('mmx-cli', root)]);
    expect(Object.keys(out)).toEqual(['mmx-cli']);
    expect(out['mmx-cli']).toEqual({
      totalCount: 1,
      recentCount: 1,
      lastUsedAt: hitAt,
      byWorkspace: { [realpathSync(wsA)]: 1 },
    });
  });

  it('tool_use snake 旧形状（input.path）命中', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    writeSession(
      'ws-a',
      'snake.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [
          toolBlock('tool_use', 'read', 'input', path.join(root, 'SKILL.md')),
        ]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(1);
    expect(out.alpha.lastUsedAt).toBe(NOW - 60_000);
  });

  it('toolUse camel 旧形状（input.path）命中', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    writeSession(
      'ws-a',
      'camel.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [
          toolBlock('toolUse', 'read', 'input', path.join(root, 'SKILL.md')),
        ]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(1);
  });

  it('相对路径按该文件 session 条目 cwd 字段解析为绝对', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const rel = path.join('.lorra', 'skills', 'alpha', 'SKILL.md'); // 相对 cwd（wsA）
    writeSession(
      'ws-a',
      'rel.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', rel)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(1);
    expect(out.alpha.byWorkspace).toEqual({ [realpathSync(wsA)]: 1 });
  });

  it('分隔符与大小写归一化（\\ 与 / 混用、大小写）命中', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'mmx-cli');
    // 反斜杠绝对路径 + 全大写 + 正斜杠变体，双侧归一后应命中
    const upper = path.join(root, 'SKILL.md').toUpperCase();
    const forward = path.join(root, 'SKILL.md').replace(/\\/g, '/');
    writeSession(
      'ws-a',
      'norm.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', upper)]),
        msgLine('m2', NOW - 30_000, [toolBlock('toolCall', 'read', 'arguments', forward)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('mmx-cli', root)]);
    expect(out['mmx-cli'].totalCount).toBe(1); // 会话级去重：两条 read 只计 1
    expect(out['mmx-cli'].recentCount).toBe(1);
  });

  it('会话级去重：同一 jsonl 内同一技能多次 read 只计 1（取首次命中时刻）', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const p = path.join(root, 'SKILL.md');
    writeSession(
      'ws-a',
      'dedup.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 120_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
        msgLine('m2', NOW - 60_000, [
          toolBlock('toolCall', 'read', 'arguments', p),
          toolBlock('toolCall', 'read', 'arguments', path.join(root, 'references', 'x.md')),
        ]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(1);
    expect(out.alpha.recentCount).toBe(1);
    expect(out.alpha.lastUsedAt).toBe(NOW - 120_000); // 首次命中时刻
  });

  it('跨 jsonl 累加：两个文件各命中一次 → totalCount 2、lastUsedAt 取最近', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const p = path.join(root, 'SKILL.md');
    writeSession(
      'ws-a',
      'f1.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 120_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    writeSession(
      'ws-a',
      'f2.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m2', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha).toEqual({
      totalCount: 2,
      recentCount: 2,
      lastUsedAt: NOW - 60_000,
      byWorkspace: { [realpathSync(wsA)]: 2 },
    });
  });

  it('跨工作区归桶（45 天窗口场景）：同技能 ws1 三次/ws2 一次，窗口外 1 次不计 recent', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha'); // 技能位置（绝对路径）
    const p = path.join(root, 'SKILL.md');
    // 归桶看会话条目 cwd，不看 read 路径本身
    writeSession(
      'ws-a',
      'f1.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 120_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    writeSession(
      'ws-a',
      'f2.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m2', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    writeSession(
      'ws-b',
      'f3.jsonl',
      `${[
        sessionLine(wsB),
        msgLine('m3', NOW - 30_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    writeSession(
      'ws-a',
      'f4.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m4', NOW - W45 - 1, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(4);
    expect(out.alpha.recentCount).toBe(3);
    expect(out.alpha.lastUsedAt).toBe(NOW - 30_000);
    expect(out.alpha.byWorkspace).toEqual({ [realpathSync(wsA)]: 3, [realpathSync(wsB)]: 1 });
  });

  it('cwd 缺失/损坏 → 「未知工作区」桶（统计不丢）', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const p = path.join(root, 'SKILL.md');
    writeSession(
      'ws-a',
      'no-cwd.jsonl',
      `${[
        sessionLine(undefined),
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    writeSession(
      'ws-a',
      'bad-cwd.jsonl',
      `${[
        sessionLine(123),
        msgLine('m2', NOW - 30_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(2);
    expect(out.alpha.byWorkspace).toEqual({ [UNKNOWN_WORKSPACE]: 2 });
  });

  it('45 天窗口边界：第 45 天整含、第 46 天不含（timestamp ≥ now − 45d）', async () => {
    const root = path.join(wsA, '.lorra', 'skills');
    const edge = path.join(root, 'edge.md');
    const stale = path.join(root, 'stale.md');
    const boundaryHit = NOW - W45; // 恰好 45 天前 → recent 含
    const outsideHit = NOW - W45 - 1; // 再早 1ms → recent 不含
    writeSession(
      'ws-a',
      'window.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', boundaryHit, [toolBlock('toolCall', 'read', 'arguments', edge)]),
        msgLine('m2', outsideHit, [toolBlock('toolCall', 'read', 'arguments', stale)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([flatSkill('edge', root), flatSkill('stale', root)]);
    expect(out.edge).toEqual({
      totalCount: 1,
      recentCount: 1,
      lastUsedAt: boundaryHit,
      byWorkspace: { [realpathSync(wsA)]: 1 },
    });
    expect(out.stale).toEqual({
      totalCount: 1,
      recentCount: 0,
      lastUsedAt: outsideHit,
      byWorkspace: { [realpathSync(wsA)]: 1 },
    });
  });

  it('引用子文件命中：rootDir 下 references/x.md 计入', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'yichen-content-archive');
    const ref = path.join(root, 'references', 'platform-routes.md');
    writeSession(
      'ws-a',
      'ref.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', ref)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('yichen-content-archive', root)]);
    expect(out['yichen-content-archive'].totalCount).toBe(1);
  });

  it('read 非技能文件不计（含平铺兄弟技能不因共享 rootDir 误伤、前缀边界字符）', async () => {
    const sharedRoot = path.join(wsA, '.lorra', 'skills');
    const alpha = flatSkill('alpha', sharedRoot);
    const beta = flatSkill('beta', sharedRoot);
    const gamma = dirSkill('gamma', path.join(sharedRoot, 'gamma'));
    writeSession(
      'ws-a',
      'miss.jsonl',
      `${[
        sessionLine(wsA),
        // beta 自身文件 → 只命中 beta；alpha 不因共享 rootDir 前缀误伤
        msgLine('m1', NOW - 60_000, [
          toolBlock('toolCall', 'read', 'arguments', path.join(sharedRoot, 'beta.md')),
        ]),
        // 目录形 gamma 的根目录本身（无尾分隔符）→ 不命中（边界字符 /）
        msgLine('m2', NOW - 30_000, [
          toolBlock('toolCall', 'read', 'arguments', path.join(sharedRoot, 'gamma')),
        ]),
        // 无关文件 → 不计
        msgLine('m3', NOW - 10_000, [
          toolBlock('toolCall', 'read', 'arguments', path.join(wsA, 'notes.txt')),
        ]),
      ].join('\n')}\n`,
    );
    const out = await statOf([alpha, beta, gamma]);
    expect(out.alpha.totalCount).toBe(0);
    expect(out.beta.totalCount).toBe(1);
    expect(out.gamma.totalCount).toBe(0);
  });

  it('坏行跳过（含流式半行）、好行照计', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const p = path.join(root, 'SKILL.md');
    writeSession(
      'ws-a',
      'dirty.jsonl',
      `${[
        sessionLine(wsA),
        '{ broken json line',
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
        '{"type":"message","id":"half",', // 流式追加中的半行
        msgLine('m2', NOW - 30_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(1); // 坏行跳过 + 会话级去重
    expect(out.alpha.recentCount).toBe(1);
  });

  it('整文件不可读（stat 抛错）→ 该文件跳过、整体不报错', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const p = path.join(root, 'SKILL.md');
    writeSession(
      'ws-a',
      'good.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    // 断链 symlink 名 .jsonl：stat/read 抛错 → 整文件跳过（win32 可确定性复现）
    symlinkSync(
      path.join(userData, 'sessions', 'ws-a', 'no-such-target'),
      path.join(userData, 'sessions', 'ws-a', 'broken.jsonl'),
    );

    const res = await getSkillStats([dirSkill('alpha', root)], { now: NOW, userDataDir: userData });
    expect(res.isOk()).toBe(true);
    const out = expectOk(res);
    expect(out.alpha.totalCount).toBe(1); // 只有 good.jsonl 计入
  });

  it('嵌套会话目录递归（子代理会话）', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const p = path.join(root, 'SKILL.md');
    writeSession(
      'ws-a',
      'top.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    writeSession(
      'ws-a/nested',
      'child.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m2', NOW - 30_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(2);
  });

  it('>64MB jsonl 跳过（防 DoS），其余文件照计', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const p = path.join(root, 'SKILL.md');
    writeSession(
      'ws-a',
      'good.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    const huge = path.join(userData, 'sessions', 'ws-a', 'huge.jsonl');
    writeFileSync(huge, `${sessionLine(wsA)}\n`, 'utf8');
    truncateSync(huge, SKILL_STATS_JSONL_BYTES_MAX + 1);
    const out = await statOf([dirSkill('alpha', root)]);
    expect(out.alpha.totalCount).toBe(1);
  });

  it('空技能集合 → 空 Record', async () => {
    writeSession(
      'ws-a',
      's.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [
          toolBlock('toolCall', 'read', 'arguments', path.join(wsA, 'x', 'SKILL.md')),
        ]),
      ].join('\n')}\n`,
    );
    const out = await statOf([]);
    expect(out).toEqual({});
  });

  it('sessions 目录不存在 → 全部技能 0（不报错）', async () => {
    const root = path.join(wsA, '.lorra', 'skills');
    const out = await statOf([dirSkill('alpha', root), flatSkill('beta', root)]);
    expect(out.alpha).toEqual({ totalCount: 0, recentCount: 0, lastUsedAt: null, byWorkspace: {} });
    expect(out.beta).toEqual({ totalCount: 0, recentCount: 0, lastUsedAt: null, byWorkspace: {} });
  });

  it('追加幂等：扫→追加→再扫 = 追加后完整解析（不累加不遗漏，mtime 缓存同一扫描函数）', async () => {
    const root = path.join(wsA, '.lorra', 'skills');
    const alpha = flatSkill('alpha', root);
    const beta = flatSkill('beta', root);
    const file = writeSession(
      'ws-a',
      'idem.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 120_000, [
          toolBlock('toolCall', 'read', 'arguments', path.join(root, 'alpha.md')),
        ]),
      ].join('\n')}\n`,
    );

    const first = await statOf([alpha, beta]);
    expect(first.alpha).toEqual({
      totalCount: 1,
      recentCount: 1,
      lastUsedAt: NOW - 120_000,
      byWorkspace: { [realpathSync(wsA)]: 1 },
    });
    expect(first.beta.totalCount).toBe(0);

    // 追加一行（beta 命中）—— 真实追加必然改变 mtime；显式推后规避文件系统粒度差异
    writeFileSync(
      file,
      `${msgLine('m2', NOW - 60_000, [
        toolBlock('toolCall', 'read', 'arguments', path.join(root, 'beta.md')),
      ])}\n`,
      { flag: 'a' },
    );
    utimesSync(file, new Date(), new Date(Date.now() + 2_000));

    const second = await statOf([alpha, beta]);
    expect(second.alpha.totalCount).toBe(1); // 不累加（per-file replace 语义）
    expect(second.alpha.lastUsedAt).toBe(NOW - 120_000);
    expect(second.beta.totalCount).toBe(1); // 追加计入（全文件幂等重解析）
    expect(second.beta.lastUsedAt).toBe(NOW - 60_000);

    // mtime 未变 → 复用缓存：同一扫描函数结果稳定、不双计
    const third = await statOf([alpha, beta]);
    expect(third).toEqual(second);
  });

  it('mtime 未变 → 复用缓存结果（mtime 是唯一变化信号，内容变更不重解析）', async () => {
    const root = path.join(wsA, '.lorra', 'skills', 'alpha');
    const p = path.join(root, 'SKILL.md');
    const file = writeSession(
      'ws-a',
      'cache.jsonl',
      `${[
        sessionLine(wsA),
        msgLine('m1', NOW - 60_000, [toolBlock('toolCall', 'read', 'arguments', p)]),
      ].join('\n')}\n`,
    );
    const first = await statOf([dirSkill('alpha', root)]);
    expect(first.alpha.totalCount).toBe(1);

    // 把 mtime 归一化到整毫秒（utimesSync 精度为 ms，子毫秒值无法精确恢复）
    const M = Math.floor(Date.now() / 1000) * 1000;
    utimesSync(file, new Date(M), new Date(M));
    expect(statSync(file).mtimeMs).toBe(M);
    // 第一次扫描在 mtime=M 之后：缓存写入 mtime=M
    const baseline = await statOf([dirSkill('alpha', root)]);
    expect(baseline.alpha.totalCount).toBe(1);

    // 内容改为命中另一技能，但把 mtime 恢复成缓存值 → 缓存判定 mtime 未变 → 复用旧结果
    writeFileSync(
      file,
      `${[
        sessionLine(wsA),
        msgLine('m2', NOW - 30_000, [
          toolBlock('toolCall', 'read', 'arguments', path.join(root, 'beta.md')),
        ]),
      ].join('\n')}\n`,
      'utf8',
    );
    utimesSync(file, new Date(M), new Date(M));
    expect(statSync(file).mtimeMs).toBe(M); // 前提：mtime 精确恢复

    const second = await statOf([dirSkill('alpha', root)]);
    expect(second.alpha.totalCount).toBe(1); // 复用缓存，未按新内容重解析
  });
});
