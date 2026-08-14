import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 审查裁定 #1(延续):今日页形状对拍 —— fact.workspace 必须是会话头 header.cwd 的
// 真实路径(workspace.activate 可直接消费的形态);workspaces[].color 必须是 token
// 名 'ws-1'..'ws-6'(按名稳定分配)。
// P1 新契约:getDayFacts = 冷同步 jsonl → OFK 概念 → bundle 直读聚合(不再走
// facts.db);categories 大类分区统计;坏文件/坏概念 fail-open。

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

// S6:getDayFacts 内做 stale 判定 + 后台调度编译 —— mock 掉真实编译(真实实现会
// 走模型调用,测试环境无 auth 且慢);缺省 stale 空(不调度),编译成功/失败由
// 专门用例验证。readDayDigestSegments 同样 stub(空 Map),避免测试依赖真实日摘要文件。
const dayDigestMock = vi.hoisted(() => ({
  dayDigestStaleGroups: vi.fn(),
  compileDay: vi.fn(),
  readDayDigestSegments: vi.fn(),
}));
vi.mock('../../src/main/ofk/day-digest', () => ({
  dayDigestStaleGroups: dayDigestMock.dayDigestStaleGroups,
  compileDay: dayDigestMock.compileDay,
  readDayDigestSegments: dayDigestMock.readDayDigestSegments,
}));

import { registerTodayHandlers } from '../../src/main/ipc/today-ipc';
import { localDateString, type TodayDayData } from '../../src/main/memory/day-summary';
import { ofkBundleRoot, readConcept } from '../../src/main/ofk/ofk-bundle';
import { err, ok } from '../../src/shared/result';

const COLOR_TOKENS = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6'];

/**
 * 以给定本地基准时刻构造会话 jsonl(概念目录按本地日对齐)。
 * 缺省基准 = 本地 2026-08-08 09:05。
 */
function linearSessionJsonl(
  sessionId: string,
  cwd: string,
  base: Date = new Date(2026, 7, 8, 9, 5),
): string {
  const baseMs = base.getTime();
  const ts = (offsetSec: number) => new Date(baseMs + offsetSec * 1000).toISOString();
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: ts(0), cwd },
    {
      type: 'message',
      id: `${sessionId}-m1`,
      parentId: null,
      timestamp: ts(5),
      message: { role: 'user', content: [{ type: 'text', text: 'Fix the flaky login test' }] },
    },
    {
      type: 'message',
      id: `${sessionId}-m2`,
      parentId: `${sessionId}-m1`,
      timestamp: ts(40),
      message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    },
    {
      type: 'message',
      id: `${sessionId}-m3`,
      parentId: `${sessionId}-m2`,
      timestamp: ts(70),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

const DAY = localDateString(new Date(2026, 7, 8, 9, 5)); // 本地 2026-08-08

type DayFactsResponse =
  | { status: 'ok'; value: TodayDayData }
  | { status: 'error'; error: { code: string; message: string } };

function okValue(res: DayFactsResponse): TodayDayData {
  if (res.status === 'ok') return res.value;
  throw new Error(`expected ok, got ${res.error.code}`);
}

/** S6:handler 现用 event.sender 推送编译完成事件 → 假 event 携带可断言的 send。 */
function makeFakeEvent() {
  return {
    sender: {
      isDestroyed: () => false,
      send: vi.fn(),
    },
  };
}

async function getDayFacts(dateISO: string = DAY) {
  const handler = electronMock.handlers.get('lorra.today.getDayFacts');
  expect(handler).toBeDefined();
  if (!handler) throw new Error('handler missing');
  const res = (await handler(makeFakeEvent(), { dateISO })) as DayFactsResponse;
  expect(res.status).toBe('ok');
  return okValue(res);
}

describe('today-ipc getDayFacts（OFK bundle 直读）', () => {
  let userdata: string;
  let wsRealA: string;
  let wsRealB: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-today-'));
    // 真实存在的目录 = 会话头 cwd 的合法形态(workspace.activate 可直接消费)。
    wsRealA = mkdtempSync(path.join(tmpdir(), 'lorra-ws-real-a-'));
    wsRealB = mkdtempSync(path.join(tmpdir(), 'lorra-ws-real-b-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    electronMock.handlers.clear();
    dayDigestMock.dayDigestStaleGroups.mockReset();
    dayDigestMock.dayDigestStaleGroups.mockResolvedValue(ok([])); // 缺省无 stale → 不调度
    dayDigestMock.compileDay.mockReset();
    dayDigestMock.compileDay.mockResolvedValue(ok()); // 缺省成功 no-op(仅 stale 时触发)
    dayDigestMock.readDayDigestSegments.mockReset();
    dayDigestMock.readDayDigestSegments.mockResolvedValue(ok(new Map())); // 缺省无 LLM 段
    registerTodayHandlers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
    rmSync(wsRealA, { recursive: true, force: true });
    rmSync(wsRealB, { recursive: true, force: true });
  });

  function seedSession(
    dirName: string,
    sessionId: string,
    cwd: string,
    base: Date = new Date(2026, 7, 8, 9, 5),
  ): void {
    const sessionsRoot = path.join(userdata, '.lorra', 'sessions', dirName);
    mkdirSync(sessionsRoot, { recursive: true });
    const stamp = `${localDateString(base)}T09-00-00-000Z`;
    writeFileSync(
      path.join(sessionsRoot, `${stamp}_${sessionId}.jsonl`),
      linearSessionJsonl(sessionId, cwd, base),
      'utf8',
    );
  }

  it('fact.workspace 为会话头 header.cwd 的真实路径(非目录 basename);概念落 bundle', async () => {
    seedSession('ws-encoded-a', 'sess-real-a', wsRealA);

    const day = await getDayFacts();

    expect(day.facts).toHaveLength(1);
    expect(day.facts[0].sessionRef).toBe('sess-real-a');
    expect(day.facts[0].workspace).toBe(wsRealA);
    expect(day.workspaces).toHaveLength(1);
    expect(day.workspaces[0].name).toBe(wsRealA);
    // 大类分区:P1 恒 'uncategorized'(概念 frontmatter 原样透出)
    expect(day.categories).toEqual([
      {
        category: 'uncategorized',
        label: '未分类',
        count: 1,
        totalActiveMs: day.facts[0].activeMs,
      },
    ]);
    // bundle 已生成:概念 + 根索引 + 变更日志
    const index = await readConcept('index.md');
    expect(index.isOk()).toBe(true);
    expect(index.unwrapOr('')).toContain('## 会话');
    const log = await readConcept('log.md');
    expect(log.isOk()).toBe(true);
    expect(log.unwrapOr('')).toContain('**Creation**');
  });

  it('workspaces[].color 为 token 名 ws-1..ws-6,按名稳定分配(非 hex)', async () => {
    seedSession('ws-encoded-a', 'sess-real-a', wsRealA);
    seedSession('ws-encoded-b', 'sess-real-b', wsRealB);

    const first = await getDayFacts();
    const second = await getDayFacts();

    expect(first.workspaces.map((w) => w.name).sort()).toEqual([wsRealA, wsRealB].sort());
    for (const w of first.workspaces) {
      expect(COLOR_TOKENS).toContain(w.color);
      expect(w.color).not.toMatch(/^#/);
    }
    const colorsByName = new Map(first.workspaces.map((w) => [w.name, w.color]));
    for (const w of second.workspaces) {
      expect(colorsByName.get(w.name)).toBe(w.color);
    }
  });

  it('dateISO 过滤: 查非当天返回空数据(概念按日目录隔离)', async () => {
    seedSession('ws-encoded-a', 'sess-real-a', wsRealA);

    const day = await getDayFacts('2026-08-09');

    expect(day.facts).toEqual([]);
    expect(day.workspaces).toEqual([]);
    expect(day.categories).toEqual([]);
    expect(day.stats.totalActiveMs).toBe(0);
  });

  it('日期契约: 查昨天只回昨天的概念, 查今天只回今天的(概念按本地日目录隔离)', async () => {
    seedSession('ws-encoded-a', 'sess-yesterday', wsRealA, new Date(2026, 7, 7, 9, 5));
    seedSession('ws-encoded-b', 'sess-today', wsRealB, new Date(2026, 7, 8, 9, 5));

    const yesterday = await getDayFacts('2026-08-07');
    expect(yesterday.facts.map((f) => f.sessionRef)).toEqual(['sess-yesterday']);
    expect(yesterday.stats.sessionCount).toBe(1);

    const today = await getDayFacts('2026-08-08');
    expect(today.facts.map((f) => f.sessionRef)).toEqual(['sess-today']);
  });

  it('日期参数缺省 = 今天: 不传 dateISO 返回今日事实', async () => {
    const now = new Date();
    const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    seedSession('ws-encoded-a', 'sess-today-default', wsRealA, todayNoon);

    const handler = electronMock.handlers.get('lorra.today.getDayFacts');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('handler missing');
    const res = (await handler(makeFakeEvent())) as DayFactsResponse;
    expect(res.status).toBe('ok');
    const value = okValue(res);
    expect(value.facts.map((f) => f.sessionRef)).toEqual(['sess-today-default']);
  });

  it('重复调用幂等: 概念内容相同 diff-skip,事实不重复', async () => {
    seedSession('ws-encoded-a', 'sess-real-a', wsRealA);

    const first = await getDayFacts();
    const second = await getDayFacts();

    expect(second.facts).toHaveLength(1);
    expect(second.facts[0].factId).toBe(first.facts[0].factId);
    expect(second.facts[0].sessionRef).toBe('sess-real-a');
  });

  it('fail-open: 坏 jsonl 不中断其余会话;坏概念文档被跳过', async () => {
    seedSession('ws-encoded-a', 'sess-good', wsRealA);
    const sessionsRoot = path.join(userdata, '.lorra', 'sessions', 'ws-encoded-b');
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(path.join(sessionsRoot, 'broken.jsonl'), 'garbage\n', 'utf8');
    // 手工塞一个 frontmatter 损坏的概念文件(解析失败应跳过)
    const badConceptDir = path.join(ofkBundleRoot(), 'sessions', 'ws-bad', '2026', DAY);
    mkdirSync(badConceptDir, { recursive: true });
    writeFileSync(path.join(badConceptDir, 'bad.md'), 'no frontmatter here\n', 'utf8');

    const day = await getDayFacts();
    expect(day.facts.map((f) => f.sessionRef)).toEqual(['sess-good']);
    expect(day.stats.sessionCount).toBe(1);
  });

  it('stats/categories 与概念同源: 多会话统计求和', async () => {
    seedSession('ws-encoded-a', 'sess-a', wsRealA);
    seedSession('ws-encoded-a', 'sess-b', wsRealA, new Date(2026, 7, 8, 14, 5));

    const day = await getDayFacts();
    expect(day.stats.sessionCount).toBe(2);
    expect(day.stats.byPeriod.morning).toBeGreaterThan(0);
    expect(day.stats.byPeriod.afternoon).toBeGreaterThan(0);
    expect(day.categories).toHaveLength(1);
    expect(day.categories[0].category).toBe('uncategorized');
    expect(day.categories[0].count).toBe(2);
    expect(day.categories[0].totalActiveMs).toBe(day.stats.totalActiveMs);
  });

  it('S6: stale 空 → 只判 stale,不调度编译(compileDay 永不调用)', async () => {
    seedSession('ws-encoded-a', 'sess-real-a', wsRealA);

    await getDayFacts();
    expect(dayDigestMock.dayDigestStaleGroups).toHaveBeenCalledWith(DAY);
    expect(dayDigestMock.compileDay).not.toHaveBeenCalled();

    // 日期参数透传:查 2026-08-09 时以该日判 stale
    await getDayFacts('2026-08-09');
    expect(dayDigestMock.dayDigestStaleGroups).toHaveBeenLastCalledWith('2026-08-09');
    expect(dayDigestMock.compileDay).not.toHaveBeenCalled();
  });

  it('S6: stale 非空 → 页面立即返回数据;编译完成后推送 dayCompiled 给请求 sender', async () => {
    seedSession('ws-encoded-a', 'sess-real-a', wsRealA);
    dayDigestMock.dayDigestStaleGroups.mockResolvedValue(
      ok([{ slug: 'C--work-demo', concepts: [] }]),
    );
    const event = makeFakeEvent();

    vi.useFakeTimers();
    try {
      const handler = electronMock.handlers.get('lorra.today.getDayFacts');
      expect(handler).toBeDefined();
      if (!handler) throw new Error('handler missing');
      const res = (await handler(event, { dateISO: DAY })) as DayFactsResponse;
      expect(res.status).toBe('ok'); // 页面数据不等待编译
      expect(okValue(res).stats.sessionCount).toBe(1);
      expect(dayDigestMock.compileDay).not.toHaveBeenCalled(); // 防抖期内未编译

      await vi.advanceTimersByTimeAsync(5_000); // 防抖到期 → 编译 → 推送
      expect(dayDigestMock.compileDay).toHaveBeenCalledWith(DAY);
      expect(event.sender.send).toHaveBeenCalledWith('lorra.today.dayCompiled', { dateISO: DAY });
    } finally {
      vi.useRealTimers();
    }
  });

  it('S6: compileDay Err → 不推送(fail-open),页面数据照常', async () => {
    seedSession('ws-encoded-a', 'sess-real-a', wsRealA);
    dayDigestMock.dayDigestStaleGroups.mockResolvedValue(
      ok([{ slug: 'C--work-demo', concepts: [] }]),
    );
    dayDigestMock.compileDay.mockResolvedValue(
      err({ code: 'model-unavailable', message: 'no model' }),
    );
    const event = makeFakeEvent();

    vi.useFakeTimers();
    try {
      const handler = electronMock.handlers.get('lorra.today.getDayFacts');
      expect(handler).toBeDefined();
      if (!handler) throw new Error('handler missing');
      const res = (await handler(event, { dateISO: DAY })) as DayFactsResponse;
      expect(res.status).toBe('ok');
      expect(okValue(res).stats.sessionCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(dayDigestMock.compileDay).toHaveBeenCalledTimes(1);
      expect(event.sender.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('S6: 编译抛出(reject)同样不阻断 getDayFacts,不推送', async () => {
    seedSession('ws-encoded-a', 'sess-real-a', wsRealA);
    dayDigestMock.dayDigestStaleGroups.mockResolvedValue(
      ok([{ slug: 'C--work-demo', concepts: [] }]),
    );
    dayDigestMock.compileDay.mockRejectedValue(new Error('compile crashed'));
    const event = makeFakeEvent();

    vi.useFakeTimers();
    try {
      const handler = electronMock.handlers.get('lorra.today.getDayFacts');
      expect(handler).toBeDefined();
      if (!handler) throw new Error('handler missing');
      const res = (await handler(event, { dateISO: DAY })) as DayFactsResponse;
      expect(res.status).toBe('ok');
      expect(okValue(res).stats.sessionCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(dayDigestMock.compileDay).toHaveBeenCalledTimes(1);
      expect(event.sender.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('today-ipc 数据源插件并入（）', () => {
  let userdata: string;
  let wsRealA: string;
  let home: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-today-plug-'));
    wsRealA = mkdtempSync(path.join(tmpdir(), 'lorra-ws-plug-a-'));
    home = mkdtempSync(path.join(tmpdir(), 'lorra-claude-home-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    electronMock.userData = userdata; // settings.json 位于 userData 根(settings 真源)
    electronMock.handlers.clear();
    dayDigestMock.dayDigestStaleGroups.mockReset();
    dayDigestMock.dayDigestStaleGroups.mockResolvedValue(ok([])); // 缺省无 stale → 不调度
    dayDigestMock.compileDay.mockReset();
    dayDigestMock.compileDay.mockResolvedValue(ok());
    dayDigestMock.readDayDigestSegments.mockReset();
    dayDigestMock.readDayDigestSegments.mockResolvedValue(ok(new Map()));
    registerTodayHandlers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(userdata, { recursive: true, force: true });
    rmSync(wsRealA, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('启用 claudeCode 后其会话事实并入当日聚合;未启用则不入', async () => {
    // pi 会话(header.cwd = 真实路径)
    const sessionsRoot = path.join(userdata, '.lorra', 'sessions', 'ws-encoded-a');
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(
      path.join(sessionsRoot, '2026-08-08T09-00-00-000Z_sess-pi.jsonl'),
      linearSessionJsonl('sess-pi', wsRealA),
      'utf8',
    );
    // claude-code 会话(2026-08-08)
    const projectDir = path.join(home, '.claude', 'projects', 'E--work-demo');
    mkdirSync(projectDir, { recursive: true });
    const ccLines = [
      {
        type: 'user',
        message: { role: 'user', content: 'Claude Code 会话' },
        timestamp: '2026-08-08T01:00:00.000Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'done' },
        timestamp: '2026-08-08T01:01:00.000Z',
      },
    ];
    writeFileSync(
      path.join(projectDir, 'cc1.jsonl'),
      ccLines.map((l) => JSON.stringify(l)).join('\n'),
      'utf8',
    );

    // 未启用:只有 pi 会话
    const dayOff = await getDayFacts();
    expect(dayOff.facts.map((f) => f.sessionRef)).toEqual(['sess-pi']);

    // 启用 claudeCode(settings.json 位于 userData 根)
    writeFileSync(
      path.join(userdata, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [], dataSources: { claudeCode: true } }),
      'utf8',
    );

    const dayOn = await getDayFacts();
    const refs = dayOn.facts.map((f) => f.sessionRef).sort();
    expect(refs).toContain('sess-pi');
    expect(refs.some((r) => r.startsWith('claude-code-'))).toBe(true);
    const ccFact = dayOn.facts.find((f) => f.sessionRef.startsWith('claude-code-'));
    expect(ccFact).toBeDefined();
    if (!ccFact) throw new Error('claude-code fact missing');
    expect(ccFact.title).toBe('Claude Code 会话');
    expect(dayOn.stats.sessionCount).toBe(2);
  });

  it('坏插件不影响 pi 时间线(fail-open)', async () => {
    // pi 会话
    const sessionsRoot = path.join(userdata, '.lorra', 'sessions', 'ws-encoded-a');
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(
      path.join(sessionsRoot, '2026-08-08T09-00-00-000Z_sess-pi.jsonl'),
      linearSessionJsonl('sess-pi', wsRealA),
      'utf8',
    );
    // 坏插件:plugin.json 非法
    const pluginDir = path.join(userdata, '.lorra', 'plugins', 'collectors', 'broken');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, 'plugin.json'), 'not-json', 'utf8');
    writeFileSync(
      path.join(pluginDir, 'index.mjs'),
      'export async function collect() { return []; }',
      'utf8',
    );

    const day = await getDayFacts();
    expect(day.facts.map((f) => f.sessionRef)).toEqual(['sess-pi']);
    expect(day.stats.sessionCount).toBe(1);
  });
});
