import { describe, expect, it } from 'vitest';
import {
  localDateString,
  type TodayDayData,
  WORKSPACE_COLORS,
  workspaceColor,
} from '../../src/main/memory/day-summary';
import { segmentsOfConcept, summarizeOfkDay } from '../../src/main/ofk/day-aggregate';
import type { SegmentSpec } from '../../src/main/ofk/day-digest';
import type { SessionCategory, SessionConceptDoc } from '../../src/shared/ofk-schema';
import { SESSION_CATEGORIES } from '../../src/shared/ofk-schema';

// Requirement(step 8):summarizeOfkDay 承接原 summarizeDay 全部口径
// (byPeriod 原始毫秒/总量/排序/空退化/workspaces 聚合与 token 着色),新增
// categories 大类分区统计(按 SESSION_CATEGORIES 序、仅非空、非法值落 uncategorized);
// localDateString/WORKSPACE_COLORS/workspaceColor 断言原样迁入。
// 审查裁定 #2:byPeriod 三段各为该时段【原始活跃毫秒数】(不是 0-1 占比);
// 审查裁定 #1:workspaces[].color 为 token 名 ws-1..ws-6(按名稳定分配)。

const COLOR_TOKENS = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6'];

function makeConcept(overrides: Partial<SessionConceptDoc> = {}): SessionConceptDoc {
  const base: SessionConceptDoc = {
    type: 'Session',
    title: 't',
    description: 't',
    category: 'uncategorized',
    workspace: 'C:\\work\\demo',
    start: new Date(2026, 7, 8, 9).toISOString(),
    end: new Date(2026, 7, 8, 9, 1).toISOString(),
    activeMs: 60_000,
    tokens: 0,
    model: '',
    tools: [],
    unfinished: false,
    containsTodo: false,
    privacy: 'public_safe',
    sessionRef: 'sess-x',
    breaks: [],
  };
  return { ...base, ...overrides };
}

function at(hour: number, minute = 0, day = 8): string {
  return new Date(2026, 7, day, hour, minute).toISOString();
}

describe('summarizeOfkDay', () => {
  it('byPeriod 三段为该时段原始活跃毫秒数（非 0-1 占比）', () => {
    const data: TodayDayData = summarizeOfkDay(
      [
        makeConcept({ sessionRef: 'f-morning', start: at(9), end: at(9, 1), activeMs: 60_000 }),
        makeConcept({ sessionRef: 'f-afternoon', start: at(14), activeMs: 30_000 }),
        makeConcept({ sessionRef: 'f-evening', start: at(20), activeMs: 10_000 }),
      ],
      '2026-08-08',
      new Map(),
    );

    expect(data.stats.byPeriod).toEqual({ morning: 60_000, afternoon: 30_000, evening: 10_000 });
    expect(data.stats.totalActiveMs).toBe(100_000);
    expect(data.stats.sessionCount).toBe(3);
  });

  it('时段分桶边界: 11:59→morning, 12:00/17:59→afternoon, 18:00→evening', () => {
    const cases: Array<[number, number, number]> = [
      [11, 59, 1_000],
      [12, 0, 2_000],
      [17, 59, 4_000],
      [18, 0, 8_000],
    ];
    const concepts = cases.map(([h, m, activeMs]) => makeConcept({ start: at(h, m), activeMs }));
    const byPeriod = summarizeOfkDay(concepts, '2026-08-08', new Map()).stats.byPeriod;
    expect(byPeriod).toEqual({ morning: 1_000, afternoon: 6_000, evening: 8_000 });
  });

  it('总量聚合: totalActiveMs / sessionCount / tokens 为各概念之和', () => {
    const data: TodayDayData = summarizeOfkDay(
      [
        makeConcept({ sessionRef: 'a', activeMs: 60_000, tokens: 100 }),
        makeConcept({ sessionRef: 'b', activeMs: 40_000, tokens: 250 }),
        makeConcept({ sessionRef: 'c', activeMs: 10_000, tokens: 0 }),
      ],
      '2026-08-08',
      new Map(),
    );

    expect(data.stats.totalActiveMs).toBe(110_000);
    expect(data.stats.sessionCount).toBe(3);
    expect(data.stats.tokens).toBe(350);
  });

  it('facts 按 start 升序输出,且携带 category', () => {
    const data: TodayDayData = summarizeOfkDay(
      [
        makeConcept({ sessionRef: 'late', start: at(20), category: 'reading' }),
        makeConcept({ sessionRef: 'early', start: at(8), category: 'work' }),
        makeConcept({ sessionRef: 'mid', start: at(12), category: 'chat' }),
      ],
      '2026-08-08',
      new Map(),
    );
    expect(data.facts.map((f) => f.sessionRef)).toEqual(['early', 'mid', 'late']);
    expect(data.facts.map((f) => f.category)).toEqual(['work', 'chat', 'reading']);
  });

  it('退化: 空概念 -> 全零统计、空 workspaces、空 categories', () => {
    const data: TodayDayData = summarizeOfkDay([], '2026-08-08', new Map());
    expect(data.stats).toEqual({
      totalActiveMs: 0,
      sessionCount: 0,
      tokens: 0,
      byPeriod: { morning: 0, afternoon: 0, evening: 0 },
    });
    expect(data.workspaces).toEqual([]);
    expect(data.categories).toEqual([]);
    expect(data.facts).toEqual([]);
  });

  it('workspaces 按工作区聚合原始 activeMs, 降序, color 为 token 名', () => {
    const data: TodayDayData = summarizeOfkDay(
      [
        makeConcept({ sessionRef: 'a1', workspace: 'ws-a', activeMs: 60_000 }),
        makeConcept({ sessionRef: 'a2', workspace: 'ws-a', activeMs: 40_000 }),
        makeConcept({ sessionRef: 'b1', workspace: 'ws-b', activeMs: 50_000 }),
      ],
      '2026-08-08',
      new Map(),
    );

    expect(data.workspaces.map((w) => w.name)).toEqual(['ws-a', 'ws-b']); // 100_000 > 50_000
    expect(data.workspaces[0].totalActiveMs).toBe(100_000);
    expect(data.workspaces[1].totalActiveMs).toBe(50_000);
    for (const w of data.workspaces) {
      expect(COLOR_TOKENS).toContain(w.color);
      expect(w.color).not.toMatch(/^#/);
    }
  });

  it('workspaces color 按名稳定: 同名工作区两次聚合同色', () => {
    const base = () => makeConcept({ workspace: 'C:\\work\\stable' });
    const a = summarizeOfkDay([base()], '2026-08-08', new Map());
    const b = summarizeOfkDay([base()], '2026-08-08', new Map());
    expect(a.workspaces[0].color).toBe(b.workspaces[0].color);
  });

  it('categories: 按 SESSION_CATEGORIES 序聚合 count/totalActiveMs, 仅非空', () => {
    const data: TodayDayData = summarizeOfkDay(
      [
        makeConcept({ sessionRef: 'a', category: 'chat', activeMs: 10_000 }),
        makeConcept({ sessionRef: 'b', category: 'work', activeMs: 60_000 }),
        makeConcept({ sessionRef: 'c', category: 'work', activeMs: 40_000 }),
        makeConcept({ sessionRef: 'd', category: 'reading', activeMs: 30_000 }),
      ],
      '2026-08-08',
      new Map(),
    );
    expect(data.categories.map((c) => c.category)).toEqual(['work', 'reading', 'chat']);
    expect(data.categories).toEqual([
      { category: 'work', label: '工作', count: 2, totalActiveMs: 100_000 },
      { category: 'reading', label: '阅读', count: 1, totalActiveMs: 30_000 },
      { category: 'chat', label: '闲聊', count: 1, totalActiveMs: 10_000 },
    ]);
    // categories 总计数 = sessionCount(与 stats 同源)
    expect(data.categories.reduce((s, c) => s + c.count, 0)).toBe(data.stats.sessionCount);
  });

  it('categories 退化: 非法 category 值落 uncategorized;标签取自 SESSION_CATEGORY_LABELS', () => {
    const bad = makeConcept({ sessionRef: 'bad', category: 'nonsense' as SessionCategory });
    const data = summarizeOfkDay([bad], '2026-08-08', new Map());
    expect(data.categories).toEqual([
      { category: 'uncategorized', label: '未分类', count: 1, totalActiveMs: 60_000 },
    ]);
    expect(data.facts[0].category).toBe('uncategorized');
  });

  it('categories 顺序即 SESSION_CATEGORIES 序(与常量同源)', () => {
    const data = summarizeOfkDay(
      [
        makeConcept({ sessionRef: 'u', category: 'uncategorized' }),
        makeConcept({ sessionRef: 'r', category: 'reading' }),
        makeConcept({ sessionRef: 'w', category: 'work' }),
      ],
      '2026-08-08',
      new Map(),
    );
    const order = data.categories.map((c) => c.category);
    const sorted = [...order].sort(
      (a, b) => SESSION_CATEGORIES.indexOf(a) - SESSION_CATEGORIES.indexOf(b),
    );
    expect(order).toEqual(sorted);
    expect(order[0]).toBe('work'); // 序首 = work(与 SESSION_CATEGORIES 首元素一致)
  });

  it('本地日边界语义: 概念 start 的本地日决定其归属', () => {
    // 23:59 与次日 00:01 分属两天(本地日口径)
    const lateNight = makeConcept({ sessionRef: 'late', start: at(23, 59, 8) });
    const nextMorning = makeConcept({ sessionRef: 'next', start: at(0, 1, 9) });
    expect(localDateString(new Date(lateNight.start))).toBe('2026-08-08');
    expect(localDateString(new Date(nextMorning.start))).toBe('2026-08-09');
  });

  it('localDateString 补零与本地日语义', () => {
    expect(localDateString(new Date(2026, 7, 8, 23, 59))).toBe('2026-08-08');
    expect(localDateString(new Date(2026, 11, 31))).toBe('2026-12-31');
    expect(localDateString(new Date(2026, 0, 3))).toBe('2026-01-03');
  });

  it('WORKSPACE_COLORS 为 6 个 token 名(非 hex)', () => {
    expect(WORKSPACE_COLORS).toEqual(['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6']);
    expect(workspaceColor('anything')).toMatch(/^ws-\d$/);
  });
});

describe('segmentsOfConcept / summarizeOfkDay segments', () => {
  it('无 LLM 段无 breaks → 单段(整概念,activeMs = 概念值,category 继承概念)', () => {
    const concept = makeConcept({
      sessionRef: 's1',
      category: 'work',
      start: at(9),
      end: at(9, 30),
      activeMs: 600_000,
      breaks: [],
    });
    const segments = segmentsOfConcept(concept, undefined);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      sessionRef: 's1',
      category: 'work',
      start: Date.parse(at(9)),
      end: Date.parse(at(9, 30)),
      activeMs: 600_000,
      title: 't',
      workspace: 'C:\\work\\demo',
    });
  });

  it('有 breaks → 切 n+1 段,段 category 继承概念;activeMs 按时间占比分配', () => {
    const concept = makeConcept({
      sessionRef: 's1',
      category: 'reading',
      start: at(9),
      end: at(10),
      activeMs: 1_800_000, // 60 分钟,各 30 分钟段 → 900_000 每段
      breaks: [Date.parse(at(9, 30))],
    });
    const segments = segmentsOfConcept(concept, undefined);
    expect(segments).toHaveLength(2);
    expect(segments[0].start).toBe(Date.parse(at(9)));
    expect(segments[0].end).toBe(Date.parse(at(9, 30)));
    expect(segments[1].start).toBe(Date.parse(at(9, 30)));
    expect(segments[1].end).toBe(Date.parse(at(10)));
    for (const seg of segments) {
      expect(seg.category).toBe('reading');
      expect(seg.activeMs).toBe(900_000);
    }
    expect(segments.reduce((s, x) => s + x.activeMs, 0)).toBe(1_800_000);
  });

  it('breaks 乱序/越界 → 按升序切分,越界断口丢弃', () => {
    const concept = makeConcept({
      sessionRef: 's1',
      start: at(9),
      end: at(10),
      activeMs: 3_600_000,
      breaks: [Date.parse(at(9, 45)), Date.parse(at(9, 15)), Date.parse(at(8)), Date.parse(at(11))],
    });
    const segments = segmentsOfConcept(concept, undefined);
    // 有效断口 09:15、09:45 → 3 段
    expect(segments.map((s) => s.start)).toEqual([
      Date.parse(at(9)),
      Date.parse(at(9, 15)),
      Date.parse(at(9, 45)),
    ]);
  });

  it('概念跨度为 0 → 段 activeMs = 概念 activeMs(不除零)', () => {
    const concept = makeConcept({ start: at(9), end: at(9), activeMs: 42_000, breaks: [] });
    expect(segmentsOfConcept(concept, undefined)[0].activeMs).toBe(42_000);
  });

  it('有 LLM 段 → 用 LLM 段(category/start/end/summary 取段值);解析失败项丢弃', () => {
    const concept = makeConcept({
      sessionRef: 's1',
      category: 'uncategorized',
      start: at(9),
      end: at(10),
      activeMs: 3_600_000,
      breaks: [],
    });
    const llm: SegmentSpec[] = [
      { category: 'reading', start: at(9), end: at(9, 20), summary: '读第三章' },
      { category: 'chat', start: at(9, 20), end: at(9, 40) },
      { category: 'work', start: 'not-a-date', end: at(9, 50) },
    ];
    const segments = segmentsOfConcept(concept, llm);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      category: 'reading',
      start: Date.parse(at(9)),
      end: Date.parse(at(9, 20)),
      summary: '读第三章',
    });
    expect(segments[1]).toMatchObject({ category: 'chat' });
    // LLM 段不覆盖概念全区间(09:40–10:00 不渲染)
    expect(segments.some((s) => s.end === Date.parse(at(10)))).toBe(false);
  });

  it('LLM 段优先于 breaks(概念同时有 breaks 与 LLM 段 → 用 LLM 段)', () => {
    const concept = makeConcept({
      sessionRef: 's1',
      start: at(9),
      end: at(10),
      activeMs: 3_600_000,
      breaks: [Date.parse(at(9, 30))],
    });
    const llm: SegmentSpec[] = [{ category: 'programming', start: at(9), end: at(10) }];
    const segments = segmentsOfConcept(concept, llm);
    expect(segments).toHaveLength(1);
    expect(segments[0].category).toBe('programming');
  });

  it('summarizeOfkDay: segments 按 start 升序输出;categories 按段统计(段数/段 activeMs 合计)', () => {
    const data: TodayDayData = summarizeOfkDay(
      [
        // 10:00–11:00 reading,断口在 10:30 → 2 段(各 30 分钟,activeMs 各半)
        makeConcept({
          sessionRef: 'r1',
          category: 'reading',
          start: at(10),
          end: at(11),
          activeMs: 600_000,
          breaks: [Date.parse(at(10, 30))],
        }),
        // 09:00–09:30 work 单段;LLM 切成 2 段
        makeConcept({
          sessionRef: 'w1',
          category: 'work',
          start: at(9),
          end: at(9, 30),
          activeMs: 300_000,
          breaks: [],
        }),
      ],
      '2026-08-08',
      new Map<string, SegmentSpec[]>([
        [
          'w1',
          [
            { category: 'work', start: at(9), end: at(9, 15) },
            { category: 'chat', start: at(9, 15), end: at(9, 30) },
          ],
        ],
      ]),
    );

    // 段升序:09:00(work) 09:15(chat) 10:00(reading) 10:30(reading)
    expect(data.segments.map((s) => s.start)).toEqual([
      Date.parse(at(9)),
      Date.parse(at(9, 15)),
      Date.parse(at(10)),
      Date.parse(at(10, 30)),
    ]);
    expect(data.segments.map((s) => s.category)).toEqual(['work', 'chat', 'reading', 'reading']);

    // categories 按段:reading count=2(300_000+300_000),work count=1,chat count=1
    expect(data.categories).toEqual([
      { category: 'work', label: '工作', count: 1, totalActiveMs: 150_000 },
      { category: 'reading', label: '阅读', count: 2, totalActiveMs: 600_000 },
      { category: 'chat', label: '闲聊', count: 1, totalActiveMs: 150_000 },
    ]);
    // facts 统计口径不变(sessionCount = 概念数,非段数)
    expect(data.stats.sessionCount).toBe(2);
    expect(data.stats.totalActiveMs).toBe(900_000);
  });

  it('summarizeOfkDay 退化: 空概念 → 空 segments、空 categories', () => {
    const data = summarizeOfkDay([], '2026-08-08', new Map());
    expect(data.segments).toEqual([]);
    expect(data.categories).toEqual([]);
  });
});
