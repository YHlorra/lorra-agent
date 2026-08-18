/**
 * TodayPage 黑盒测试(agent-memory-today-timeline,,审查对齐后版本)。
 *
 * 规范真源:
 * - 
 * (每个 it 首行标注对应 Scenario / Requirement)
 * - design.md D7(PX_PER_HOUR=64,块高∝active_ms 且 ≥ 最小高度,空时段留白、KPI 总量)
 * - ui-design/today-timeline-v2.html(设计定稿:每 2 小时标号共 12 个、
 * 未完成块延伸到当前时刻、颜色为 --ws-N token 名)
 *
 * mock 数据钉死生产形状(独立审查 NO-GO 修复):
 * - IPC 信封:window.lorra.today.getDayFacts 只返回 SerializedResult
 * {status:'ok',value} / {status:'error',error:{code,message}},与
 * src/main/ipc/today-ipc.ts 同构;{ok:true} 视图形状是死分支,不喂
 * - workspace = header.cwd 全路径('E:/work/demo');byPeriod = 原始毫秒
 * - workspaces[].color = token 名('ws-1'..'ws-6'),非 hex
 *
 * 测试钩子契约(实现方按此暴露可观测面):
 * data-testid="today-page" 今日整页根节点
 * data-testid="today-kpi" KPI 统计卡,data-metric=total-active|session-count|tokens|period-morning|period-afternoon|period-evening
 * data-testid="today-timeline" 24h 时间线轨道
 * data-testid="today-hour" 带标号刻度,data-hour=0,2,...,22(每 2 小时,共 12 个;23:00 无标号)
 * data-testid="today-block" 会话块;几何用 style.top / style.height(px,
 * 相对轨道,PX_PER_HOUR=64,与 now-line 同原点;
 * data-workspace / data-color(token 名) /
 * data-unfinished="true|false" /
 * data-session-count(归并块含会话数)
 * data-testid="today-legend-item" 图例项,data-workspace / data-color(token 名)
 * data-testid="today-now-line" 当前时刻线,style.top(px,与块同原点);仅「今天」渲染
 * data-testid="today-empty" 空态(ok 数据但无事实)
 * data-testid="today-timeline-error" 时间线区域内联错误横幅(含重试按钮)——PM 需求①:
 * 数据通道出错时时间线骨架仍渲染,不再整页替换
 * (旧 data-testid="today-error" 整页错误态作废)
 * data-testid="today-date-label" 页头日期按钮(点击弹出日历 popover,PM 需求②)
 * data-testid="today-calendar" 日历 popover:日单元格 data-date="YYYY-MM-DD",
 * 未来日期 disabled;选中日 is-selected;今天 is-today 带标记;
 * 月前后切换箭头(上一月/下一月);非今天含「回到今天」;
 * Esc/外部点击关闭
 * KPI 恒渲染:空数据/加载错误时四张统计卡(today-kpi)仍在位,数值 0/空分布
 * data-testid="review-rail-fallback" 复盘栏降级占位(错误边界兜底,PM 需求①隔离)
 * 悬停详情以 role="tooltip" 承载。
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '@/lib/app-store';
import { TodayPage, layoutSection, PX_PER_HOUR } from '../../src/renderer/today-page';
import type { TimelineSegment } from '../../src/shared/ofk-schema';
import {
  WORKSPACE_A,
  WORKSPACE_B,
  WS_TOKEN_A,
  WS_TOKEN_B,
  WS_TOKEN_IDLE,
  at,
  emptyDayData,
  errToday,
  fact,
  installTodayLorraMock,
  makeDayData,
  okToday,
  seg,
  type TodayDayData,
  type TodayLorraMock,
} from './today-test-data';

let mock: TodayLorraMock;

// PM 需求①隔离:默认 ReviewRail 走真实实现;隔离用例置 crash=true 让其在渲染期抛错,
// 断言时间线/KPI 不受影响(错误边界兜底)。
const railState = vi.hoisted(() => ({ crash: false }));

vi.mock('@/review-rail', async (importOriginal) => {
  // vitest v4 将 factory 内 importOriginal 展开为 unknown,显式 as 断言模块类型;
  // ReviewRail 无 props,包装组件不透传,避免 JSX props 类型推断歧义。
  const actual = (await importOriginal()) as typeof import('@/review-rail');
  const Rail = actual.ReviewRail as unknown as () => ReactElement;
  return {
    ...actual,
    ReviewRail: () => {
      if (railState.crash) throw new Error('rail crash');
      return <Rail />;
    },
  };
});

beforeEach(() => {
  railState.crash = false;
  mock = installTodayLorraMock();
});

afterEach(() => {
  railState.crash = false;
  vi.useRealTimers(); // 还原 setSystemTime 对 Date 的 mock
});

// ---------------------------------------------------------------------------
// DOM 读取助手
// ---------------------------------------------------------------------------

function blocks(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="today-block"]'));
}

/** 按纵向位置排序的块(位置=开始时刻)。 */
function blocksByTop(): HTMLElement[] {
  return blocks().sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
}

function blockOf(ws: string): HTMLElement {
  const found = blocks().find((b) => b.getAttribute('data-workspace') === ws);
  if (!found) throw new Error(`没有工作区 ${ws} 的会话块`);
  return found;
}

function kpi(metric: string): HTMLElement {
  const el = document.querySelector(`[data-testid="today-kpi"][data-metric="${metric}"]`);
  if (!el) throw new Error(`没有 KPI 卡 data-metric=${metric}`);
  return el as HTMLElement;
}

function hourLabel(hour: number): HTMLElement | null {
  return document.querySelector(`[data-testid="today-hour"][data-hour="${hour}"]`);
}

/** 渲染今日页并等数据投影完成,返回渲染出的块。 */
async function renderDay(data: TodayDayData): Promise<HTMLElement[]> {
  mock.today.getDayFacts.mockResolvedValue(okToday(data));
  render(<TodayPage />);
  return screen.findAllByTestId('today-block');
}

// =========================================================================
// Requirement: 24 小时纵向时间线
// =========================================================================

describe('Requirement: 24 小时纵向时间线(design D7: PX_PER_HOUR=64)', () => {
  it('Scenario 块位置与时长对应:14:00 开始 30 分钟 → 块位于 14:00 刻度、高度按 30 分钟比例', async () => {
    await renderDay(makeDayData()); // 09:00 wsA 30min;14:00 wsB 60min
    const [morning, afternoon] = blocksByTop();
    // 位置:14:00 − 09:00 = 5h → 顶部差 5×64=320px
    expect(parseFloat(afternoon.style.top) - parseFloat(morning.style.top)).toBe(320);
    // 高度:30min→32px,60min→64px(∝ active_ms)
    expect(parseFloat(morning.style.height)).toBe(32);
    expect(parseFloat(afternoon.style.height)).toBe(64);
    // 时间轴刻度(设计定稿 v2):每 2 小时标号,0:00/2:00/.../22:00 共 12 个;23:00 无标号
    expect(screen.getAllByTestId('today-hour')).toHaveLength(12);
    expect(hourLabel(0)).not.toBeNull();
    expect(hourLabel(22)).not.toBeNull();
    expect(hourLabel(23)).toBeNull(); // 23:00 无标签
    expect(hourLabel(1)).toBeNull(); // 奇数小时无标签
  });

  it('Requirement 含最小高度保证:极短会话块高度不低于最小高度,不塌成 0', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30 }), // 32px
        fact({ hour: 10, durMin: 0.5 }), // 0.53px → 必须被最小高度钳制(24px)
      ],
    });
    await renderDay(data);
    const [big, tiny] = blocksByTop();
    expect(parseFloat(big.style.height)).toBe(32);
    expect(parseFloat(tiny.style.height)).toBeGreaterThanOrEqual(24);
    expect(parseFloat(tiny.style.height)).toBeLessThan(parseFloat(big.style.height));
  });

  it('Scenario 当前时刻线:今日页打开时时间线上显示当前时刻标识线', async () => {
    vi.setSystemTime(new Date(2026, 7, 8, 14, 30));
    mock.today.getDayFacts.mockResolvedValue(okToday(makeDayData()));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');
    expect(screen.getByTestId('today-now-line')).toBeInTheDocument();
  });

  it('Scenario 无会话的上午:空时段留白、仅保留刻度,不渲染块', async () => {
    const data = makeDayData({
      facts: [fact({ hour: 9, durMin: 30 }), fact({ hour: 20, durMin: 30 })],
    });
    await renderDay(data);
    // 全天只有两个会话 → 只有两个块,中间全部留白
    expect(blocks()).toHaveLength(2);
    const [morning, night] = blocksByTop();
    expect(parseFloat(night.style.top) - parseFloat(morning.style.top)).toBe(11 * 64);
    // 上午 10 点无会话:刻度仍在,无块(留白是有效信息,不被装饰填充)
    expect(hourLabel(10)).not.toBeNull();
  });
});

// =========================================================================
// Requirement: 大类分组(step 7: categories 分区渲染)
// =========================================================================

describe('Requirement: 标签单轨(2026-08-14 标签分类改造)', () => {
  it('单条轨道: 单个 section(data-category="all"),计数 = 总段数,块带 data-tag', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30, category: '工作' }),
        fact({ hour: 10, durMin: 30, category: '工作' }),
        fact({ hour: 14, durMin: 60, category: '阅读' }),
      ],
      categories: [
        { category: '工作', label: '工作', count: 2, totalActiveMs: 3_600_000 },
        { category: '阅读', label: '阅读', count: 1, totalActiveMs: 3_600_000 },
      ],
    });
    await renderDay(data);
    const sections = Array.from(document.querySelectorAll('[data-testid="today-category"]'));
    // 单条 24h 轨道(不再按类别分区)
    expect(sections).toHaveLength(1);
    expect(sections[0].getAttribute('data-category')).toBe('all');
    expect(
      sections[0].querySelector('[data-testid="today-category-count"]')?.textContent,
    ).toBe('3');
    // 块全在同一 section,data-tag 标注标签
    expect(
      sections[0].querySelectorAll<HTMLElement>('[data-testid="today-block"]'),
    ).toHaveLength(3);
    expect(blocks()).toHaveLength(3);
    const tags = blocks().map((b) => b.getAttribute('data-tag'));
    expect(tags.filter((t) => t === '工作')).toHaveLength(2);
    expect(tags.filter((t) => t === '阅读')).toHaveLength(1);
  });

  it('tag 过滤 chip 行:全部 + 当日出现的标签(色点 + 计数);点击 chip → 非选中块 dim', async () => {
    const user = userEvent.setup();
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30, category: '工作' }),
        fact({ hour: 10, durMin: 30, category: '工作' }),
        fact({ hour: 14, durMin: 60, category: '阅读' }),
      ],
      categories: [
        { category: '工作', label: '工作', count: 2, totalActiveMs: 3_600_000 },
        { category: '阅读', label: '阅读', count: 1, totalActiveMs: 3_600_000 },
      ],
    });
    await renderDay(data);
    const filter = document.querySelector('[data-testid="today-tag-filter"]');
    expect(filter).not.toBeNull();
    const chips = Array.from(filter!.querySelectorAll('.tag-chip'));
    // 全部 + 工作 + 阅读(共 3 个 chip)
    expect(chips.map((c) => c.getAttribute('data-tag'))).toEqual(['all', '工作', '阅读']);
    // 初始:全部选中,无 dim
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
    for (const b of blocks()) expect(b.classList.contains('dim')).toBe(false);

    // 点「工作」→ 阅读块 dim,工作块不 dim;chips[1] pressed
    await user.click(chips[1]);
    const workBlocks = blocks().filter((b) => b.getAttribute('data-tag') === '工作');
    const readingBlocks = blocks().filter((b) => b.getAttribute('data-tag') === '阅读');
    expect(workBlocks.every((b) => !b.classList.contains('dim'))).toBe(true);
    expect(readingBlocks.every((b) => b.classList.contains('dim'))).toBe(true);
    expect(chips[1].getAttribute('aria-pressed')).toBe('true');

    // 点「全部」→ dim 全移除
    await user.click(chips[0]);
    for (const b of blocks()) expect(b.classList.contains('dim')).toBe(false);
  });

  it('标签图例与块颜色一致:legend item 的 data-tag/data-color 与块同源(token 名)', async () => {
    await renderDay(makeDayData()); // 2 段,缺省 category '未分类'
    const items = Array.from(document.querySelectorAll('[data-testid="today-legend-item"]'));
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.getAttribute('data-tag')).toBe('未分类');
    // 图例色 = 块色(tagColor 同源 token 名,非 hex)
    for (const b of blocks()) {
      expect(item.getAttribute('data-color')).toBe(b.getAttribute('data-color'));
    }
    expect(item.getAttribute('data-color')).toMatch(/^ws-\d$/);
  });

  it('图例点击过滤:点标签 chip → 非选中标签块 dim;再点取消', async () => {
    const user = userEvent.setup();
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30, category: '工作' }),
        fact({ hour: 14, durMin: 60, category: '阅读' }),
      ],
      categories: [
        { category: '工作', label: '工作', count: 1, totalActiveMs: 1_800_000 },
        { category: '阅读', label: '阅读', count: 1, totalActiveMs: 3_600_000 },
      ],
    });
    await renderDay(data);
    const items = Array.from(document.querySelectorAll('[data-testid="today-legend-item"]'));
    expect(items).toHaveLength(2);
    const workItem = items.find((i) => i.getAttribute('data-tag') === '工作');
    expect(workItem).toBeDefined();

    await user.click(workItem!);
    expect(workItem).toHaveAttribute('aria-pressed', 'true');
    expect(
      blocks()
        .find((b) => b.getAttribute('data-tag') === '工作')!
        .classList.contains('dim'),
    ).toBe(false);
    expect(
      blocks()
        .find((b) => b.getAttribute('data-tag') === '阅读')!
        .classList.contains('dim'),
    ).toBe(true);

    await user.click(workItem!);
    expect(workItem).toHaveAttribute('aria-pressed', 'false');
    for (const b of blocks()) expect(b.classList.contains('dim')).toBe(false);
  });

  it('块仍按时间定位: 单轨内块 top∝开始时刻(不再分区,全部同轨道)', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30, category: '工作' }),
        fact({ hour: 14, durMin: 30, category: '工作' }),
        fact({ hour: 10, durMin: 30, category: '阅读' }),
      ],
      categories: [
        { category: '工作', label: '工作', count: 2, totalActiveMs: 3_600_000 },
        { category: '阅读', label: '阅读', count: 1, totalActiveMs: 1_800_000 },
      ],
    });
    await renderDay(data);
    const bs = blocksByTop();
    expect(bs).toHaveLength(3);
    // 09:00 → 10:00 → 14:00 顶部差 1×64 与 4×64
    expect(parseFloat(bs[1].style.top) - parseFloat(bs[0].style.top)).toBe(64);
    expect(parseFloat(bs[2].style.top) - parseFloat(bs[1].style.top)).toBe(4 * 64);
  });
});

// =========================================================================
// Requirement: 语义分段 + 甘特堆叠(plan D4-D8:段不再合并;重叠段分列并排)
// =========================================================================

describe('Requirement: 语义分段与甘特堆叠', () => {
  it('同分类泳道内不合并:相邻同工作区会话各自成块(无归并标注)', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 14, minute: 0, durMin: 10 }), // wsA 14:00–14:10
        fact({ hour: 14, minute: 12, durMin: 10 }), // 相邻(间隔 2 分钟,旧逻辑会归并)
        fact({ hour: 14, minute: 21, durMin: 10 }),
        fact({ hour: 16, durMin: 20, workspace: WORKSPACE_B }),
      ],
    });
    await renderDay(data);
    // 不再归并:每个会话一个块
    expect(blocks()).toHaveLength(4);
    for (const b of blocks()) {
      expect(Number(b.getAttribute('data-session-count') ?? 1)).toBe(1);
    }
    // 无归并标注元素
    expect(document.querySelectorAll('[data-testid="today-merge-count"]')).toHaveLength(0);
    // 相邻同工作区 3 块各自成块;短块最小高度撑出时段时下推,
    // 同 lane(left 相同)块对垂直互不覆盖(级联下跨 lane 覆盖交给层叠 z 分层)
    const wsA = blocks()
      .filter((b) => b.getAttribute('data-workspace') === WORKSPACE_A)
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    expect(wsA).toHaveLength(3);
    for (let i = 0; i < wsA.length; i++) {
      for (let j = i + 1; j < wsA.length; j++) {
        // 同 lane(级联下 left = lane × span,left 相同即同 lane)→ 垂直不覆盖
        if (parseFloat(wsA[i].style.left) === parseFloat(wsA[j].style.left)) {
          const hi = wsA[i];
          const lo = wsA[j];
          expect(parseFloat(lo.style.top)).toBeGreaterThanOrEqual(
            parseFloat(hi.style.top) + parseFloat(hi.style.height) + 2,
          );
        }
      }
    }
  });

  it('重叠两段甘特分列:同分类时间重叠 → left 0%/50%、宽 48%(列不相交)', async () => {
    const a = fact({ hour: 9, durMin: 60 }); // 09:00–10:00
    const b = fact({ hour: 9, minute: 30, durMin: 30 }); // 09:30–10:00 重叠
    const data = makeDayData({
      facts: [a, b],
      segments: [seg(a), seg(b)],
      categories: [
        { category: '未分类', label: '未分类', count: 2, totalActiveMs: 5_400_000 },
      ],
    });
    await renderDay(data);
    expect(blocks()).toHaveLength(2);
    const [first, second] = blocksByTop();
    // 甘特分列:2 列 → left 0%/50%,宽 = 50 − 2 缝 = 48%(列不相交,不互相遮挡)
    expect(first.style.left).toBe('0%');
    expect(second.style.left).toBe('50%');
    expect(parseFloat(first.style.width)).toBe(48);
    expect(parseFloat(second.style.width)).toBe(48);
    // 层叠序:z = lane+1(后块盖前块)
    expect(first.style.getPropertyValue('--z')).toBe('1');
    expect(second.style.getPropertyValue('--z')).toBe('2');
    // 高度按段 activeMs(60min → 64px / 30min → 32px)
    expect(parseFloat(first.style.height)).toBe(64);
    expect(parseFloat(second.style.height)).toBe(32);
  });

  it('LLM 语义段:块内显示段 summary(有 summary 优先于概念 title)', async () => {
    const base = fact({ hour: 9, durMin: 30, title: '概念标题' });
    const data = makeDayData({
      facts: [base],
      segments: [seg(base, { summary: '讨论《xx》第三章' })],
    });
    await renderDay(data);
    const b = blocks()[0];
    expect(b.textContent).toContain('讨论《xx》第三章');
    expect(b.textContent).not.toContain('概念标题');
  });

  it('breaks 切段:段 category 继承概念,单轨不分区', async () => {
    const base = fact({ hour: 9, durMin: 60, category: '阅读' }); // 09:00–10:00
    const data = makeDayData({
      facts: [base],
      segments: [seg(base, { start: at(9), end: at(9, 30) }), seg(base, { start: at(9, 30), end: at(10) })],
      categories: [{ category: '阅读', label: '阅读', count: 2, totalActiveMs: 3_600_000 }],
    });
    await renderDay(data);
    const sections = Array.from(document.querySelectorAll('[data-testid="today-category"]'));
    // 单条轨道(2026-08-14 起不再按类别分区)
    expect(sections).toHaveLength(1);
    expect(sections[0].getAttribute('data-category')).toBe('all');
    expect(sections[0].querySelectorAll<HTMLElement>('[data-testid="today-block"]')).toHaveLength(2);
    // 两块时间连续(09:00 与 09:30),同 tag 不合并
    expect(blocks()).toHaveLength(2);
    for (const b of blocks()) expect(b.getAttribute('data-tag')).toBe('阅读');
  });

  it('计数按段:同概念两段 → section 头 count 显示 2(与聚合层 categories 同源)', async () => {
    const base = fact({ hour: 9, durMin: 60, category: '编程' });
    const data = makeDayData({
      facts: [base],
      segments: [seg(base, { start: at(9), end: at(9, 30) }), seg(base, { start: at(9, 30), end: at(10) })],
      categories: [{ category: '编程', label: '编程', count: 2, totalActiveMs: 3_600_000 }],
    });
    await renderDay(data);
    const sec = document.querySelector(
      '[data-testid="today-category"][data-category="all"]',
    );
    expect(sec?.querySelector('[data-testid="today-category-count"]')?.textContent).toBe('2');
  });

  it('layoutSection 单测:同会话相邻短块同列下推留缝;跨会话分列各守时间位;同会话重叠下推', () => {
    const tseg = (startMin: number, endMin: number, sessionRef = 's'): TimelineSegment => ({
      sessionRef,
      workspace: WORKSPACE_A,
      category: 'work',
      collector: 'pi-sdk',
      start: at(0, 0) + startMin * 60_000,
      end: at(0, 0) + endMin * 60_000,
      activeMs: (endMin - startMin) * 60_000,
      title: 't',
      unfinished: false,
      containsTodo: false,
      model: 'm',
      tools: [],
    });
    const opts = { pxPerHour: 64, minH: 24, gap: 2, nowTop: null };
    // 同会话相邻短块:10min 时长高 10.7px < 最小高 24 → 第二块下推到前块底 + 2 缝
    const geo = layoutSection([tseg(0, 10), tseg(20, 30)], opts);
    expect(geo[0]).toMatchObject({ lane: 0, laneCount: 1, top: 0, height: 24 });
    expect(geo[1]).toMatchObject({ lane: 0, laneCount: 1, top: 26, height: 24 });
    // 跨会话重叠对:两会话 → 两列、各守时间位(不被下推)
    const g2 = layoutSection([tseg(0, 60, 'a'), tseg(30, 60, 'b')], opts);
    expect(g2[0]).toMatchObject({ lane: 0, laneCount: 2, top: 0, height: 64 });
    expect(g2[1]).toMatchObject({ lane: 1, laneCount: 2, top: 32, height: 32 });
    // 跨会话:后段在另一列,不被同列下推(列不相交,不遮挡)
    const g3 = layoutSection([tseg(0, 60, 'a'), tseg(30, 90, 'b')], opts);
    expect(g3[0]).toMatchObject({ lane: 0, laneCount: 2, top: 0, height: 64 });
    expect(g3[1]).toMatchObject({ lane: 1, laneCount: 2, top: 32, height: 64 }); // 不被下推
    // 同会话重叠 → 同列下推留缝:第二段 top = 0 + 64 + 2 缝
    const g5 = layoutSection([tseg(0, 60, 's'), tseg(30, 60, 's')], opts);
    expect(g5[0]).toMatchObject({ lane: 0, laneCount: 1, top: 0, height: 64 });
    expect(g5[1]).toMatchObject({ lane: 0, laneCount: 1, top: 66, height: 32 });
    // 完成块(今天,nowTop 12:37):12:32–12:35 的 24px 最小高延伸会越过当前时刻线
    // (底边到 12:54)→ 截断回自然时长高 3.2px,底边 = 12:35 严格在线之上
    const g6 = layoutSection([tseg(0, 3, 'a'), tseg(32, 35, 'b')], {
      ...opts,
      nowTop: (37 * 64) / 60,
    });
    expect(g6[1]).toMatchObject({ lane: 1, laneCount: 2 });
    expect(g6[1].top).toBeCloseTo((32 * 64) / 60, 5);
    expect(g6[1].height).toBeCloseTo((3 * 64) / 60, 5);
    // 完成块最小高延伸在线之上(top0 + 24px ≤ nowTop)→ 保持 24px 不变
    const g7 = layoutSection([tseg(0, 10, 'a'), tseg(20, 30, 'b')], { ...opts, nowTop: 64 });
    expect(g7[1]).toMatchObject({ lane: 1, laneCount: 2, height: 24 });
  });

  it('会话分列:4 会话 → 四列均分,left 0/25/50/75、宽 = 100/4 − 2 = 23', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 10, durMin: 21 }), // 会话 A
        fact({ hour: 11, durMin: 58 }), // 会话 B
        fact({ hour: 12, durMin: 5 }), // 会话 C
        fact({ hour: 12, minute: 20, durMin: 8 }), // 会话 D(短块:最小高度撑出时段)
      ],
    });
    await renderDay(data);
    const bs = blocksByTop();
    expect(bs).toHaveLength(4);
    // 4 会话 → 列宽 100/4 = 25 → left 0%/25%/50%/75%;宽 = 列宽 − 2% 缝 = 23
    const colW = 100 / 4;
    expect(parseFloat(bs[0].style.left)).toBeCloseTo(0, 5);
    expect(parseFloat(bs[1].style.left)).toBeCloseTo(colW, 5);
    expect(parseFloat(bs[2].style.left)).toBeCloseTo(2 * colW, 5);
    expect(parseFloat(bs[3].style.left)).toBeCloseTo(3 * colW, 5);
    for (const b of bs) {
      expect(parseFloat(b.style.width)).toBeCloseTo(colW - 2, 5);
    }
    // 列不相交:任两列水平区间不重叠(left+width ≤ 下一列 left)
    for (let i = 0; i < 3; i++) {
      const left = parseFloat(bs[i].style.left);
      const width = parseFloat(bs[i].style.width);
      const nextLeft = parseFloat(bs[i + 1].style.left);
      expect(left + width).toBeLessThanOrEqual(nextLeft);
    }
  });

  it('甘特分列:三段互叠 → left 0%/33.3%/66.7%、宽 ≈ 31.3%、列不相交', async () => {
    const a = fact({ hour: 9, durMin: 90 }); // 09:00–10:30
    const b = fact({ hour: 9, minute: 30, durMin: 90 }); // 09:30–11:00
    const c = fact({ hour: 10, durMin: 90 }); // 10:00–11:30(三段两两重叠)
    const data = makeDayData({
      facts: [a, b, c],
      segments: [seg(a), seg(b), seg(c)],
      categories: [{ category: '未分类', label: '未分类', count: 3, totalActiveMs: 5_400_000 }],
    });
    await renderDay(data);
    expect(blocks()).toHaveLength(3);
    const sorted = blocksByTop();
    // 3 列:列宽 100/3 ≈ 33.33 → left 0%/33.33%/66.67%;宽 = 列宽 − 2% 缝
    const colW = 100 / 3;
    expect(parseFloat(sorted[0].style.left)).toBeCloseTo(0, 5);
    expect(parseFloat(sorted[1].style.left)).toBeCloseTo(colW, 5);
    expect(parseFloat(sorted[2].style.left)).toBeCloseTo(2 * colW, 5);
    for (const b of sorted) {
      expect(parseFloat(b.style.width)).toBeCloseTo(colW - 2, 5);
    }
    // 列不相交:任两列水平区间不重叠(left+width ≤ 下一列 left)
    for (let i = 0; i < 2; i++) {
      const left = parseFloat(sorted[i].style.left);
      const width = parseFloat(sorted[i].style.width);
      const nextLeft = parseFloat(sorted[i + 1].style.left);
      expect(left + width).toBeLessThanOrEqual(nextLeft);
    }
  });
});

// =========================================================================
// Requirement: 未完成会话标记(设计定稿 v2:未完成块延伸到当前时刻)
// =========================================================================

describe('Requirement: 未完成会话标记', () => {

  it('进行中光球:未完成块含 breathing 光球 canvas,完成块没有', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30, unfinished: true }),
        fact({ hour: 10, durMin: 30, unfinished: false }),
      ],
    });
    await renderDay(data);
    const unfinished = blocks().find((b) => b.getAttribute('data-unfinished') === 'true');
    const finished = blocks().find((b) => b.getAttribute('data-unfinished') !== 'true');
    expect(unfinished?.querySelector('.tl-live-orb canvas')).not.toBeNull();
    expect(finished?.querySelector('.tl-live-orb canvas')).toBeNull();
  });
  it('Scenario 未完成块可视化:unfinished=true 的块虚线边框 + 「未完成」徽标;完成的块没有', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30, unfinished: true }),
        fact({ hour: 10, durMin: 30, unfinished: false }),
      ],
    });
    await renderDay(data);
    const unfinished = blocks().find((b) => b.getAttribute('data-unfinished') === 'true');
    const finished = blocks().find((b) => b.getAttribute('data-unfinished') !== 'true');
    expect(unfinished).toBeDefined();
    expect(unfinished?.textContent).toContain('未完成');
    expect(finished).toBeDefined();
    expect(finished?.textContent).not.toContain('未完成');
  });

  it('设计定稿 v2:未完成块高度延伸到当前时刻线;普通完成块不延伸', async () => {
    vi.setSystemTime(new Date(2026, 7, 8, 10, 30));
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 10, unfinished: true }), // 09:00 起未完成 → 延伸到 10:30
        fact({ hour: 14, durMin: 30 }), // 14:00 完成块 → 高度仍按 activeMs
      ],
    });
    await renderDay(data);
    const unfinished = blocks().find((b) => b.getAttribute('data-unfinished') === 'true');
    const finished = blocks().find((b) => b.getAttribute('data-unfinished') !== 'true');
    expect(unfinished).toBeDefined();
    expect(finished).toBeDefined();
    // 延伸:09:00 → 10:30 = 90 分钟 = (90/60)×64 = 96px(而非 activeMs 10min → 10.7px)
    expect(parseFloat(unfinished!.style.height)).toBe(96);
    // 块底边与当前时刻线重合(延伸语义的几何断言,与 now-line 同原点)
    const nowLine = document.querySelector('[data-testid="today-now-line"]') as HTMLElement;
    expect(parseFloat(unfinished!.style.top) + parseFloat(unfinished!.style.height)).toBe(
      parseFloat(nowLine.style.top),
    );
    // 普通完成块:高度按 activeMs(30min → 32px),不延伸
    expect(parseFloat(finished!.style.height)).toBe(32);
  });

  it('设计定稿 v2 退化:未完成块延伸受最小高度约束(极短延伸不塌成 0)', async () => {
    vi.setSystemTime(new Date(2026, 7, 8, 10, 30));
    const data = makeDayData({
      facts: [fact({ hour: 10, minute: 29, durMin: 1, unfinished: true })], // 距 now 1 分钟 → 0.53px
    });
    await renderDay(data);
    const unfinished = blocks().find((b) => b.getAttribute('data-unfinished') === 'true');
    expect(unfinished).toBeDefined();
    expect(parseFloat(unfinished!.style.height)).toBeGreaterThanOrEqual(24);
  });

  it('完成块最小高度延伸不越过当前时刻线:短块底边在线下时截断回自然时长高', async () => {
    vi.setSystemTime(new Date(2026, 7, 8, 10, 37));
    const data = makeDayData({
      facts: [fact({ hour: 10, minute: 32, durMin: 3 })], // 10:32–10:35,距 now 2 分钟
    });
    await renderDay(data);
    const b = blocks()[0];
    const nowLine = document.querySelector('[data-testid="today-now-line"]') as HTMLElement;
    // 底边 ≤ 当前时刻线(线下方是未来,完成块不侵入)
    expect(parseFloat(b.style.top) + parseFloat(b.style.height)).toBeLessThanOrEqual(
      parseFloat(nowLine.style.top) + 1e-6,
    );
    // 截断回自然时长高(3min → 3.2px),而非最小高 24px(否则底边到 10:57 越过 10:37 线)
    expect(parseFloat(b.style.height)).toBeCloseTo((3 * PX_PER_HOUR) / 60, 5);
  });
});

// =========================================================================
// Requirement: KPI 统计卡
// =========================================================================

describe('Requirement: KPI 统计卡', () => {
  it('统计数字 MUST 来自事实层聚合:展示 stats 值,而非 UI 端重算 facts 之和', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30, tokens: 1234 }),
        fact({ hour: 10, durMin: 30, tokens: 1234 }), // facts 合计 60min / 2468 tokens / 2 会话
      ],
      stats: {
        totalActiveMs: 5_400_000, // 90 分钟——不等于 facts 之和,证明取 stats 非重算
        sessionCount: 7,
        tokens: 99999,
        byPeriod: { morning: 1_800_000, afternoon: 0, evening: 600_000 }, // 原始毫秒,非 0-1 占比
      },
    });
    await renderDay(data);
    expect(kpi('total-active').textContent).toMatch(/(90\s*分钟|1\s*小时\s*30\s*分钟)/);
    expect(kpi('session-count').textContent).toMatch(/^7/);
    expect(kpi('tokens').textContent).toMatch(/99,?999/);
    // 时段分布(上午/下午/晚上):byPeriod 喂原始毫秒 → 展示分钟数(30/10 分钟);
    // 若渲染端把 byPeriod 当 0-1 占比处理,30 分钟将变成天文数字/错误占比,此断言必红
    expect(kpi('period-morning').textContent).toMatch(/30\s*分钟/);
    expect(kpi('period-evening').textContent).toMatch(/10\s*分钟/);
    expect(kpi('period-morning').textContent).not.toBe(kpi('period-evening').textContent);
  });

  it('Scenario 统计与时间线同源:时间线上所有块时长之和 = 统计卡总时长', async () => {
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30 }),
        fact({ hour: 10, durMin: 30 }), // 间隔 1h > 阈值 → 两块,各 16px
      ],
      stats: {
        totalActiveMs: 3_600_000, // 60 分钟,与块之和一致
        sessionCount: 2,
        tokens: 2468,
        byPeriod: { morning: 3_600_000, afternoon: 0, evening: 0 },
      },
    });
    await renderDay(data);
    expect(kpi('total-active').textContent).toMatch(/(60\s*分钟|1\s*小时)/);
    const blocksSum = blocks().reduce(
      (sum, b) => sum + (parseFloat(b.style.height) / PX_PER_HOUR) * 3_600_000,
      0,
    );
    expect(Math.round(blocksSum)).toBe(3_600_000);
  });

  it('PM 需求②:空数据(空态)时 KPI 卡恒渲染——四张统计卡在位,数值为 0/空分布', async () => {
    mock.today.getDayFacts.mockResolvedValue(okToday(emptyDayData()));
    render(<TodayPage />);
    await screen.findByTestId('today-empty'); // 空态指引仍在
    // 恒渲染:无对话也不缺卡;数值 0(不因空数据消失)
    expect(kpi('total-active').textContent).toMatch(/0\s*分钟/);
    expect(kpi('session-count').textContent).toMatch(/^0/);
    expect(kpi('tokens').textContent).toMatch(/^0/);
    // 时段分布:三时段卡在位,均为空分布(0 分钟)
    expect(kpi('period-morning').textContent).toMatch(/0\s*分钟/);
    expect(kpi('period-afternoon').textContent).toMatch(/0\s*分钟/);
    expect(kpi('period-evening')).toBeInTheDocument();
  });

  it('PM 需求②:加载错误时 KPI 卡仍在位(零值),时间线骨架 + 内联错误横幅不回归', async () => {
    mock.today.getDayFacts.mockResolvedValue(errToday('memory-db-error', '记忆库读取失败'));
    render(<TodayPage />);
    expect(await screen.findByTestId('today-timeline-error')).toBeInTheDocument();
    // 错误不吞 KPI:四卡在位,零值
    expect(kpi('total-active').textContent).toMatch(/0\s*分钟/);
    expect(kpi('session-count').textContent).toMatch(/^0/);
    expect(kpi('tokens').textContent).toMatch(/^0/);
    expect(kpi('period-morning')).toBeInTheDocument();
    expect(kpi('period-evening')).toBeInTheDocument();
    expect(screen.getByTestId('today-page')).toBeInTheDocument(); // 页面不崩溃
  });
});

// =========================================================================
// Requirement: 标签图例(颜色 = tagColor 稳定映射,非 hex)
// =========================================================================

describe('Requirement: 标签图例', () => {
  it('退化:categories 为空(无段统计)时不渲染图例;有标签时图例计数 = 段计数', async () => {
    // 有标签:图例渲染,计数 = 段计数(2)
    const data = makeDayData({
      categories: [{ category: '工作', label: '工作', count: 2, totalActiveMs: 5_400_000 }],
    });
    await renderDay(data);
    const items = Array.from(document.querySelectorAll('[data-testid="today-legend-item"]'));
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute('data-tag')).toBe('工作');
    expect(items[0].textContent).toMatch(/\d/);

    // 空 categories(无标签统计)→ 图例不渲染
    cleanup();
    await renderDay(makeDayData({ categories: [] }));
    expect(document.querySelectorAll('[data-testid="today-legend-item"]')).toHaveLength(0);
  });
});

// =========================================================================
// Requirement: 交互(悬停详情 / 点击下钻)
// =========================================================================

describe('Requirement: 交互(悬停详情 / 点击下钻)', () => {
  it('Scenario 悬停显示详情:标题(summary 优先)、起止时刻、标签、智能体、时长——不含模型/Token/工具', async () => {
    const user = userEvent.setup();
    const base = fact({
      hour: 9,
      durMin: 30,
      workspace: WORKSPACE_A,
      title: '写脚本',
      category: '工作',
      model: 'claude-sonnet-4',
      tokens: 12345,
      tools: ['bash', 'write'],
    });
    const data = makeDayData({
      facts: [base],
      segments: [seg(base, { summary: '修复登录测试', collector: 'claude-code' })],
      categories: [{ category: '工作', label: '工作', count: 1, totalActiveMs: 1_800_000 }],
    });
    await renderDay(data);
    await user.hover(blocks()[0]);
    const tip = await screen.findByRole('tooltip', {}, { timeout: 3000 });
    // 标题 = LLM summary(优先于概念 title)
    expect(tip.textContent).toContain('修复登录测试');
    expect(tip.textContent).not.toContain('写脚本');
    expect(tip.textContent).toMatch(/09:00/); // 起
    expect(tip.textContent).toMatch(/09:30/); // 止
    expect(tip.textContent).toContain('工作'); // 标签(tag)
    expect(tip.textContent).toContain('Claude Code'); // 智能体(collector 映射)
    expect(tip.textContent).toMatch(/30\s*(分钟|min)/); // 时长
    // 移除模型/Token/工具三行(2026-08-14)
    expect(tip.textContent).not.toContain('claude-sonnet-4');
    expect(tip.textContent).not.toMatch(/12,?345/);
    expect(tip.textContent).not.toContain('bash');
    expect(tip.textContent).not.toContain('write');
    expect(tip.textContent).not.toContain('模型');
    expect(tip.textContent).not.toContain('Token');
    expect(tip.textContent).not.toContain('工具');
  });

  it('Scenario 点击块跳转:切回该会话所属工作区并打开会话,页面回工作台', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ page: 'today' });
    const data = makeDayData({
      facts: [fact({ hour: 9, durMin: 30, workspace: WORKSPACE_A, sessionRef: 'sess-drill' })],
    });
    const activateSpy = vi
      .spyOn(window.lorra.workspace, 'activate')
      .mockResolvedValue({ path: WORKSPACE_A });
    const openSpy = vi
      .spyOn(window.lorra.session, 'open')
      .mockResolvedValue({ ok: true, value: { sessionId: 'sess-drill' } });
    await renderDay(data);
    await user.click(blocks()[0]);
    expect(activateSpy).toHaveBeenCalledWith(WORKSPACE_A);
    expect(openSpy).toHaveBeenCalledWith({ sessionId: 'sess-drill' });
    expect(useAppStore.getState().page).toBe('workspace');
  });
});

// =========================================================================
// Requirement: 空态 / 只读投影(含 IPC 退化兄弟测试)
// =========================================================================

describe('Requirement: 空态 / 错误态 / 只读投影', () => {
  it('Scenario 全新的一天:无会话时渲染空态与开始对话指引,不渲染空白时间线骨架', async () => {
    mock.today.getDayFacts.mockResolvedValue(okToday(emptyDayData()));
    render(<TodayPage />);
    const empty = await screen.findByTestId('today-empty');
    expect(empty.textContent).toMatch(/(对话|开始)/); // 下一步指引
    expect(screen.queryByTestId('today-timeline')).not.toBeInTheDocument();
    expect(screen.queryByTestId('today-block')).not.toBeInTheDocument();
  });

  it('PM 需求①:getDayFacts 返回 err → 时间线骨架仍渲染(12 刻度在位)+ 内联错误横幅(含重试),不整页替换', async () => {
    const user = userEvent.setup();
    mock.today.getDayFacts
      .mockResolvedValueOnce(errToday('memory-db-error', '记忆库读取失败'))
      .mockResolvedValue(okToday(makeDayData()));
    render(<TodayPage />);
    // 时间线骨架:12 个刻度在位(错误不毁时间线)
    expect(await screen.findAllByTestId('today-hour')).toHaveLength(12);
    // 时间线区域内联错误横幅,非整页替换
    const banner = await screen.findByTestId('today-timeline-error');
    expect(banner.textContent).toContain('记忆库读取失败');
    // 重试 → 数据恢复 → 时间线块出现
    await user.click(within(banner).getByRole('button', { name: /重试/ }));
    expect(await screen.findAllByTestId('today-block')).toHaveLength(2);
    expect(mock.today.getDayFacts).toHaveBeenCalledTimes(2);
  });

  it('PM 需求①退化:getDayFacts IPC 抛错(reject)→ 同款韧性(时间线骨架 + 内联横幅),不崩溃', async () => {
    mock.today.getDayFacts.mockRejectedValue(new Error('ipc down'));
    render(<TodayPage />);
    expect(await screen.findAllByTestId('today-hour')).toHaveLength(12);
    expect(await screen.findByTestId('today-timeline-error')).toBeInTheDocument();
    expect(screen.getByTestId('today-page')).toBeInTheDocument(); // 页面不崩溃
  });

  it('PM 需求①:ReviewRail 渲染抛错 → 时间线与 KPI 不受影响,复盘栏位置显示降级占位(错误边界)', async () => {
    mock.today.getDayFacts.mockResolvedValue(okToday(makeDayData()));
    railState.crash = true;
    render(<TodayPage />);
    // 时间线与 KPI 完整(KPI 区共 7 个 today-kpi 元素:4 统计卡 + 3 时段 span,
    // 用 kpi('total-active') 精确命中单卡,避免 getByTestId 多匹配抛错)
    expect((await screen.findAllByTestId('today-block')).length).toBeGreaterThan(0);
    expect(kpi('total-active')).toBeInTheDocument();
    expect(kpi('session-count')).toBeInTheDocument();
    expect(kpi('period-morning')).toBeInTheDocument();
    // 复盘栏位置:降级占位而非空白/崩溃
    const fallback = await screen.findByTestId('review-rail-fallback');
    expect(fallback.textContent).toMatch(/(不可用|异常|加载失败)/);
  });

  it('Scenario 页面状态不落盘:浏览(悬停)不写 localStorage、不调 settings.set;挂载仅 1 次只读 IPC(日期切换各 +1)', async () => {
    const user = userEvent.setup();
    await renderDay(makeDayData());
    await user.hover(blocks()[0]);
    expect(localStorage.getItem('lorra-ui')).toBeNull();
    expect(mock.settings.set).not.toHaveBeenCalled();
    // 只读投影:挂载 = 1 次 getDayFacts;日期切换触发新调用(语义:每次日期切换 1 次 IPC)。
    expect(mock.today.getDayFacts).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// PM 需求②:日历日期选择(页头日期区 → 日历 popover;原前一天/后一天按钮已删)
// =========================================================================

describe('PM 需求②: 日历日期选择', () => {
  const TODAY = new Date(2026, 7, 8, 14, 30); // 2026-08-08(固定测试日)

  /** 日历 popover 容器。 */
  function cal(): HTMLElement {
    return screen.getByTestId('today-calendar');
  }

  /** 日历中某日单元格(data-date="YYYY-MM-DD")。 */
  function calDay(dateISO: string): HTMLElement {
    const el = cal().querySelector(`[data-date="${dateISO}"]`);
    if (!el) throw new Error(`日历中没有 ${dateISO} 的日单元格`);
    return el as HTMLElement;
  }

  it('日历:点击页头日期打开 popover(7 列月格),选日 → getDayFacts 收到该日期并自动关闭,页头文案跟随', async () => {
    const user = userEvent.setup();
    vi.setSystemTime(TODAY);
    mock.today.getDayFacts.mockResolvedValue(okToday(makeDayData()));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');
    // 初始:日历未打开
    expect(screen.queryByTestId('today-calendar')).not.toBeInTheDocument();

    // 页头日期(按钮) → 日历 popover 弹出
    await user.click(screen.getByTestId('today-date-label'));
    const popover = cal();
    expect(popover).toBeInTheDocument();
    // 月格:7 列周头(一~日)
    expect(popover.textContent).toMatch(/2026 年 8 月/);
    for (const w of ['一', '二', '三', '四', '五', '六', '日']) {
      expect(within(popover).getByText(w)).toBeInTheDocument();
    }

    // 选 8 月 5 日(过去日)→ IPC 收到 '2026-08-05',popover 关闭,页头日期文案变化
    await user.click(calDay('2026-08-05'));
    await waitFor(() => expect(mock.today.getDayFacts).toHaveBeenCalledWith('2026-08-05'));
    expect(screen.queryByTestId('today-calendar')).not.toBeInTheDocument();
    expect(screen.getByTestId('today-date-label').textContent).toMatch(
      /2026-08-05|8 月 5 日|2026 年 8 月 5 日/,
    );
  });

  it('日历:选今天等价回到今天(传今日或省略);非今天时 popover 内出现「回到今天」,点击恢复并关闭', async () => {
    const user = userEvent.setup();
    vi.setSystemTime(TODAY);
    mock.today.getDayFacts.mockResolvedValue(okToday(makeDayData()));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');

    // 今天:打开日历 → 无「回到今天」
    await user.click(screen.getByTestId('today-date-label'));
    expect(within(cal()).queryByRole('button', { name: '回到今天' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    // 选 8 月 5 日 → 再开日历:出现「回到今天」
    await user.click(screen.getByTestId('today-date-label'));
    await user.click(calDay('2026-08-05'));
    await waitFor(() => expect(mock.today.getDayFacts).toHaveBeenCalledWith('2026-08-05'));
    await user.click(screen.getByTestId('today-date-label'));
    expect(within(cal()).getByRole('button', { name: '回到今天' })).toBeInTheDocument();

    await user.click(within(cal()).getByRole('button', { name: '回到今天' }));
    // 语义:每次日期切换 1 次 IPC(挂载 + 选日 + 回到今天 = 3);回到今天传今日或省略
    await waitFor(() => expect(mock.today.getDayFacts).toHaveBeenCalledTimes(3));
    expect([undefined, '2026-08-08']).toContain(mock.today.getDayFacts.mock.calls[2][0]);
    expect(screen.queryByTestId('today-calendar')).not.toBeInTheDocument(); // 动作后关闭
    expect(screen.getByTestId('today-date-label').textContent).toMatch(
      /2026-08-08|8 月 8 日|2026 年 8 月 8 日/,
    );

    // 回到今天后再开日历:「回到今天」消失;今天单元格即选中日
    await user.click(screen.getByTestId('today-date-label'));
    expect(within(cal()).queryByRole('button', { name: '回到今天' })).not.toBeInTheDocument();
  });

  it('日历:未来日期禁用(点击不触发 IPC);今天带标记、选中日高亮', async () => {
    const user = userEvent.setup();
    vi.setSystemTime(TODAY);
    mock.today.getDayFacts.mockResolvedValue(okToday(makeDayData()));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');

    await user.click(screen.getByTestId('today-date-label'));
    // 明天(未来)→ 禁用;今天 → 可选
    expect(calDay('2026-08-09')).toBeDisabled();
    expect(calDay('2026-08-08')).not.toBeDisabled();
    // 今天 = 选中日:高亮 + 今天标记(圆点)
    const todayCell = calDay('2026-08-08');
    expect(todayCell.className).toContain('is-selected');
    expect(todayCell.className).toContain('is-today');
    expect(todayCell.querySelector('.cal-dot')).not.toBeNull();
    // 点击禁用日:不触发 IPC,popover 不关闭(无效点击)
    await user.click(calDay('2026-08-09'));
    expect(mock.today.getDayFacts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('today-calendar')).toBeInTheDocument();
  });

  it('日历:月份前后切换箭头;显示月 ≥ 当前月时「下一月」禁用(整月未来无意义)', async () => {
    const user = userEvent.setup();
    vi.setSystemTime(TODAY); // 2026-08-08
    mock.today.getDayFacts.mockResolvedValue(okToday(makeDayData()));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');
    await user.click(screen.getByTestId('today-date-label'));

    expect(within(cal()).getByText(/2026 年 8 月/)).toBeInTheDocument();
    // 上一月 → 7 月(历史月,整月可选)
    await user.click(within(cal()).getByRole('button', { name: '上一月' }));
    expect(within(cal()).getByText(/2026 年 7 月/)).toBeInTheDocument();
    expect(calDay('2026-07-31')).not.toBeDisabled();
    // 下一月 → 回到 8 月;当前月不可再往后翻
    await user.click(within(cal()).getByRole('button', { name: '下一月' }));
    expect(within(cal()).getByText(/2026 年 8 月/)).toBeInTheDocument();
    expect(within(cal()).getByRole('button', { name: '下一月' })).toBeDisabled();
    // 月切换不触发 getDayFacts(仅选日触发)
    expect(mock.today.getDayFacts).toHaveBeenCalledTimes(1);
  });

  it('日历:Esc 关闭 / 点击 popover 外部关闭', async () => {
    const user = userEvent.setup();
    vi.setSystemTime(TODAY);
    mock.today.getDayFacts.mockResolvedValue(okToday(makeDayData()));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');

    await user.click(screen.getByTestId('today-date-label'));
    expect(screen.getByTestId('today-calendar')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('today-calendar')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('today-date-label'));
    await user.click(document.body); // 外部点击
    expect(screen.queryByTestId('today-calendar')).not.toBeInTheDocument();
  });

  it('S6: 收到 onDayCompiled 回调 → 防抖后触发一次 getDayFacts 重取(编译完成自动刷新)', async () => {
    mock.today.getDayFacts.mockResolvedValue(okToday(makeDayData()));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');
    expect(mock.today.getDayFacts).toHaveBeenCalledTimes(1); // 挂载 1 次

    // 组件挂载时已订阅 onDayCompiled(回调 = scheduleRefresh)
    expect(mock.today.onDayCompiled).toHaveBeenCalledTimes(1);
    const notify = mock.today.onDayCompiled.mock.calls[0][0] as () => void;
    expect(notify).toBeTypeOf('function');

    act(() => notify()); // 主进程推送编译完成
    expect(mock.today.getDayFacts).toHaveBeenCalledTimes(1); // 防抖期内未重取
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600)); // REFRESH_DEBOUNCE_MS=1500
    });
    expect(mock.today.getDayFacts).toHaveBeenCalledTimes(2);
    await screen.findAllByTestId('today-block'); // 重取后数据仍渲染
  });

  it('日期语义:日历选非今天 → 无 now-line、unfinished 块高度按 activeMs(不延伸);今天行为不变', async () => {
    const user = userEvent.setup();
    vi.setSystemTime(TODAY); // 14:30
    const data = makeDayData({
      facts: [
        fact({ hour: 9, durMin: 30, unfinished: true }),
        fact({ hour: 14, durMin: 30 }),
      ],
    });
    mock.today.getDayFacts.mockResolvedValue(okToday(data));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');

    // 今天:now-line 在位
    expect(screen.getByTestId('today-now-line')).toBeInTheDocument();

    // 日历选 8 月 7 日(非今天)
    await user.click(screen.getByTestId('today-date-label'));
    await user.click(calDay('2026-08-07'));
    await waitFor(() => expect(mock.today.getDayFacts).toHaveBeenCalledWith('2026-08-07'));
    await screen.findAllByTestId('today-block');

    // 非今天:无 now-line;unfinished 高度按 activeMs(30min → 32px),不延伸
    expect(screen.queryByTestId('today-now-line')).not.toBeInTheDocument();
    const unfinished = blocks().find((b) => b.getAttribute('data-unfinished') === 'true');
    expect(unfinished).toBeDefined();
    expect(parseFloat(unfinished!.style.height)).toBe(32);
    // 非今天:普通完成块高度不变(30min → 32px)
    const finished = blocks().find((b) => b.getAttribute('data-unfinished') !== 'true');
    expect(parseFloat(finished!.style.height)).toBe(32);
  });
});
