import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDateString } from '../../src/main/memory/day-summary';
import { assembleReviewPayload, type ReviewPayload } from '../../src/main/memory/review-assembler';
import type { Result } from '../../src/shared/result';
import type { ReviewRequest } from '../../src/shared/review-api';
import { at, freshUserData, isoDay, seedConcept, seedDigest } from './ofk-test-fixtures';

// Requirement: 复盘数据组装契约(改 OFK 直读)—— bundle 概念/日摘要
// 组装;日复盘取单日、周复盘取 7 天窗口;空概念可组装不报错;conversation
// digest 是紧凑摘要(不含原始全文);dailyDigest 字段由日摘要正文填充。
// 方向修正(PM):ReviewRequest 无 modules —— 模型自主判断重点,不硬编码模块勾选。

const WS_A = 'C:\\work\\demo';
const WS_B = 'C:\\work\\side';
// workspace → slug(pi-sdk 编码):C:\work\demo → C--work-demo
const SLUG_A = 'C--work-demo';

function expectOk(result: Result<ReviewPayload>): ReviewPayload {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

describe('assembleReviewPayload（OFK bundle 直读）', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = freshUserData();
  });

  afterEach(() => {
    vi.unstubAllEnvs?.();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('daily: 单日概念组装完整 payload（工作区/会话/用量/全局统计/日期）', async () => {
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'a1',
      title: 'Fix the flaky login test',
      start: at(8, 9),
      activeMs: 1_800_000,
      tokens: 1_000,
      model: 'claude-sonnet-4-5',
      tools: ['read', 'edit'],
      userText: '帮我修一下登录测试',
    });
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'a2',
      title: 'Bump the timeout',
      start: at(8, 10),
      activeMs: 300_000,
      tokens: 500,
      model: 'claude-sonnet-4-5',
      tools: ['bash'],
      unfinished: true,
      containsTodo: true,
    });
    await seedConcept({
      day: isoDay(8),
      workspace: WS_B,
      sessionRef: 'b',
      title: 'Refactor cache keys',
      start: at(8, 14),
      activeMs: 600_000,
      tokens: 2_000,
      model: 'claude-haiku',
      tools: [],
    });
    // 次日概念被单日过滤排除
    await seedConcept({
      day: isoDay(9),
      workspace: WS_A,
      sessionRef: 'c',
      title: 'next day',
      start: at(9, 9),
      activeMs: 600_000,
    });
    // 预置新鲜日摘要 → ensureDayCompiled 不触发模型调用
    await seedDigest(SLUG_A, isoDay(8), 'demo 当日摘要');

    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));

    expect(payload.date).toBe('2026-08-08');
    expect(payload.globalStats.totalConversations).toBe(3);
    expect(payload.globalStats.totalActiveMs).toBe(2_700_000);
    // 工作区按活跃时长降序。
    expect(payload.workspaces.map((w) => w.workspaceName)).toEqual([WS_A, WS_B]);
    // 会话按 start 升序。
    expect(payload.workspaces[0].conversations.map((c) => c.title)).toEqual([
      'Fix the flaky login test',
      'Bump the timeout',
    ]);
    expect(payload.workspaces[0].usage.tokens).toBe(1_500);
    expect(payload.workspaces[1].usage.tokens).toBe(2_000);
    // dailyDigest 字段 = 日摘要正文。
    expect(payload.workspaces[0].dailyDigest).toBe('demo 当日摘要');
    expect(payload.workspaces[1].dailyDigest).toBeUndefined(); // 无摘要 → 字段缺席
  });

  it('digest 字段逐项对齐契约（title/question/summary/tools/lastMessageRole/containsTodo）', async () => {
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 's1',
      title: 'Fix the flaky login test',
      tools: ['read', 'edit'],
      unfinished: true,
      containsTodo: true,
      userText: '首条用户请求',
    });
    await seedDigest(SLUG_A, isoDay(8), '当日摘要正文');

    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));
    const digest = payload.workspaces[0].conversations[0];

    expect(digest.title).toBe('Fix the flaky login test');
    // question = 正文「用户要求」首条(剥 [HH:MM] 前缀)。
    expect(digest.question).toBe('首条用户请求');
    // summary = 日摘要正文(同工作区同日共享)。
    expect(digest.summary).toBe('当日摘要正文');
    expect(digest.tools).toEqual(['read', 'edit']);
    // unfinished=true 表示末条为 user 消息。
    expect(digest.lastMessageRole).toBe('user');
    expect(digest.containsTodo).toBe(true);
  });

  it('digest 是紧凑摘要：恰好 6 个契约字段，无原始全文字段', async () => {
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 's1',
      title: 'Fix the flaky login test',
    });
    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));
    const digest = payload.workspaces[0].conversations[0];
    expect(Object.keys(digest).sort()).toEqual([
      'containsTodo',
      'lastMessageRole',
      'question',
      'summary',
      'title',
      'tools',
    ]);
  });

  it('lastMessageRole: unfinished=false -> assistant', async () => {
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 's1',
      title: 't',
      unfinished: false,
    });
    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));
    expect(payload.workspaces[0].conversations[0].lastMessageRole).toBe('assistant');
  });

  it('weekly: 7 天窗口聚合（[dateISO-6, dateISO]，窗口外排除），date 为周范围标识', async () => {
    await seedConcept({
      day: isoDay(1),
      workspace: WS_A,
      sessionRef: 'day1',
      title: 'out1',
      activeMs: 100_000,
    }); // 08-01 窗口外
    await seedConcept({
      day: isoDay(2),
      workspace: WS_A,
      sessionRef: 'day2',
      title: 'in1',
      activeMs: 200_000,
    }); // 08-02 窗口内
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'day8',
      title: 'in2',
      activeMs: 300_000,
    }); // 08-08 窗口内
    await seedConcept({
      day: isoDay(9),
      workspace: WS_A,
      sessionRef: 'day9',
      title: 'out2',
      activeMs: 400_000,
    }); // 08-09 窗口外

    const payload = expectOk(await assembleReviewPayload('weekly', isoDay(8)));

    expect(payload.globalStats.totalConversations).toBe(2);
    expect(payload.globalStats.totalActiveMs).toBe(500_000);
    expect(payload.date).toContain('2026-08-02');
    expect(payload.date).toContain('2026-08-08');
    expect(payload.date).not.toBe('2026-08-08'); // 周范围标识，非单日
  });

  it('weekly: timeAllocation 按本地日键给出每日分布（支撑周趋势）', async () => {
    await seedConcept({
      day: isoDay(2),
      workspace: WS_A,
      sessionRef: 'd2',
      title: 'a',
      activeMs: 1_800_000,
    });
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'd8',
      title: 'b',
      activeMs: 600_000,
    });
    const payload = expectOk(await assembleReviewPayload('weekly', isoDay(8)));
    expect(payload.globalStats.timeAllocation).toEqual({
      '2026-08-02': 1_800_000,
      '2026-08-08': 600_000,
    });
  });

  it('daily: timeAllocation 按工作区键给出各项目分配（原始毫秒，非占比）', async () => {
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'a',
      title: 'x',
      activeMs: 1_800_000,
    });
    await seedConcept({
      day: isoDay(8),
      workspace: WS_B,
      sessionRef: 'b',
      title: 'y',
      activeMs: 600_000,
    });
    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));
    expect(payload.globalStats.timeAllocation).toEqual({
      [WS_A]: 1_800_000,
      [WS_B]: 600_000,
    });
  });

  it('usage: tokens 求和, models 去重（首次出现顺序, 空 model 排除）', async () => {
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'm1',
      title: 'a',
      tokens: 1_000,
      model: 'claude-sonnet-4-5',
    });
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'm2',
      title: 'b',
      tokens: 2_000,
      model: 'claude-sonnet-4-5',
    });
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'm3',
      title: 'c',
      tokens: 500,
      model: '',
    });
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'm4',
      title: 'd',
      tokens: 100,
      model: 'claude-haiku',
    });
    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));
    expect(payload.workspaces[0].usage.tokens).toBe(3_600);
    expect(payload.workspaces[0].usage.models).toEqual(['claude-sonnet-4-5', 'claude-haiku']);
  });

  it('ReviewRequest 无 modules 概念: 不含 modules 的请求可正常组装', async () => {
    await seedConcept({ day: isoDay(8), workspace: WS_A, sessionRef: 's1', title: 't' });
    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));
    expect(payload.globalStats.totalConversations).toBe(1);
    const req: ReviewRequest = { kind: 'daily', dateISO: '2026-08-08' };
    expect(Object.keys(req).sort()).toEqual(['dateISO', 'kind']);
    expect('modules' in req).toBe(false);
  });

  it('退化: 空概念 -> Ok（空工作区列表 + 全零统计），不报错', async () => {
    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));
    expect(payload.date).toBe('2026-08-08');
    expect(payload.workspaces).toEqual([]);
    expect(payload.globalStats).toEqual({
      totalConversations: 0,
      totalActiveMs: 0,
      timeAllocation: {},
    });
  });

  it('本地日边界: 23:59 属当日, 次日 00:01 排除（daily）', async () => {
    await seedConcept({
      day: isoDay(8),
      workspace: WS_A,
      sessionRef: 'late',
      title: '晚间会话',
      start: at(8, 23, 59),
      activeMs: 60_000,
    });
    await seedConcept({
      day: isoDay(9),
      workspace: WS_A,
      sessionRef: 'next',
      title: '次日',
      start: at(9, 0, 1),
      activeMs: 60_000,
    });
    const payload = expectOk(await assembleReviewPayload('daily', isoDay(8)));
    expect(payload.globalStats.totalConversations).toBe(1);
    expect(payload.workspaces[0].conversations[0].title).toBe('晚间会话');
  });

  // 语义钉死（PM 2026-08-08 拍板：每日复盘 = 今日复盘）：
  // dateISO 缺省时默认本地今天；文案/方法论的「今日」与实现一致。
  it('语义: daily 缺省 dateISO → 默认今日（本地日），非昨日非明日', async () => {
    const now = Date.now();
    const today = localDateString(new Date(now));
    const payload = expectOk(await assembleReviewPayload('daily', today));
    expect(payload.date).toBe(today);
    // 今日数据必须进窗：概念 start=now（本地日=今天）→ 计入。
    const todayKey = localDateString(new Date(now));
    await seedConcept({
      day: todayKey,
      workspace: WS_A,
      sessionRef: 'now',
      title: '今日会话',
      start: now,
      activeMs: 60_000,
    });
    const withToday = expectOk(await assembleReviewPayload('daily', todayKey));
    expect(withToday.globalStats.totalConversations).toBe(1);
  });
});
