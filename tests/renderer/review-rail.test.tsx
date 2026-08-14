/**
 * 复盘栏黑盒测试(agent-memory-today-timeline,,PM 方向修正版)。
 *
 * 规范真源:
 * - 
 * (每个 it 首行标注对应 Scenario / Requirement;PM 修正:复盘重点由模型
 * 自主判断,MUST NOT 硬编码模块勾选;用户提示词输入已取消(2026-08-08),
 * 复盘重点由用户直接修改技能文件承载)
 * - ui-design/today-timeline-v2.html 复盘栏:今日复盘主按钮 + 本周深度复盘
 * 幽灵按钮 + 报告列表 + 生成中 Thinking Orb + 空态文案
 *
 * 实现不存在(PM 方向未落地)——相关用例为红色;实现方按下列测试钩子暴露可观测面:
 * data-testid="review-rail" 复盘栏根节点
 * button 今日复盘 / 本周深度复盘 两个生成入口(主/幽灵,class 含 btn-primary/btn-ghost)
 * data-testid="review-skill-hint" 技能文件引导提示(含 .lorra/skills/daily-review.md
 * 与 deep-review.md 路径,不渲染提示词输入框)
 * data-testid="review-pending" 生成中卡片,文案含「生成中」,含 class*="orb" 元素
 * data-testid="review-item" + data-id 历史条目(button,可点击读报告;展示 kind+date,无模块)
 * data-testid="review-empty" 历史列表空态(含指引文案)
 * data-testid="review-error" 生成失败提示(含下一步指引)
 * 界面 MUST NOT 渲染模块勾选控件,亦不裸显示英文模块 ID。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TodayPage } from '../../src/renderer/today-page';
import {
  errRes,
  installReviewLorraMock,
  makeReviewMarkdown,
  makeReviewMeta,
  okRes,
  type ReviewLorraMock,
  type ReviewMeta,
} from './review-test-data';

let mock: ReviewLorraMock;

beforeEach(() => {
  mock = installReviewLorraMock();
  mock.review.list.mockResolvedValue(okRes([]));
});

/** 渲染今日页并等时间线就绪(复盘栏挂在今日页内)。 */
async function renderToday(): Promise<void> {
  render(<TodayPage />);
  await screen.findAllByTestId('today-block');
}

function reviewItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="review-item"]'));
}

// =========================================================================
// Requirement: 复盘入口(手动触发)
// =========================================================================

describe('Requirement: 复盘入口', () => {
  it('Scenario 手动触发:应用启动未点击复盘按钮 → 没有任何 generate 调用;两入口在位且主/幽灵层级有别', async () => {
    await renderToday();
    const dailyBtn = screen.getByRole('button', { name: '今日复盘' });
    const weeklyBtn = screen.getByRole('button', { name: '本周深度复盘' });
    expect(dailyBtn).toBeInTheDocument();
    expect(weeklyBtn).toBeInTheDocument();
    // 主按钮(实底) vs 幽灵按钮(描边):v2 视觉层级契约。
    expect(dailyBtn.className).toMatch(/btn-primary/);
    expect(weeklyBtn.className).toMatch(/btn-ghost/);
    expect(mock.review.generate).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Requirement: 每日复盘生成(PM 方向:模型自主判断 + 可选提示词)
// =========================================================================

describe('Requirement: 每日复盘生成', () => {
  it('Scenario 模型自主判断:直接生成 → 请求只带 kind,不携带模块列表与提示词字段', async () => {
    const user = userEvent.setup();
    mock.review.generate.mockResolvedValue(okRes(makeReviewMeta({ id: 'r1' })));
    await renderToday();

    await user.click(screen.getByRole('button', { name: '今日复盘' }));
    const req = mock.review.generate.mock.calls[0][0];
    expect(req.kind).toBe('daily');
    expect(req.modules).toBeUndefined(); // MUST NOT 硬编码模块勾选
    expect(req.userPrompt).toBeUndefined(); // 提示词输入已取消(PM 2026-08-08)
    expect(Object.keys(req).sort()).toEqual(['kind']);
  });

  it('技能文件引导:复盘栏渲染引导提示(含 daily/deep 技能文件路径),不再渲染提示词输入框', async () => {
    await renderToday();
    // 引导提示在位,含两个技能文件名。
    const hint = screen.getByTestId('review-skill-hint');
    expect(hint.textContent).toContain('.lorra/skills/daily-review.md');
    expect(hint.textContent).toContain('deep-review.md');
    expect(hint.textContent).toMatch(/即时生效/);
    // 提示词输入框不存在。
    expect(document.querySelector('[data-testid="review-user-prompt"]')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('UI 无模块勾选控件:复盘栏不再渲染 checkbox/data-module,且无英文模块 ID 裸显示', async () => {
    await renderToday();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(document.querySelector('[data-module]')).toBeNull();
    // 本地化:界面不裸显示英文模块 ID
    expect(document.body.textContent).not.toMatch(
      /\b(summary|missed|usage|code|roadmap|trends|research)\b/i,
    );
  });
});

// =========================================================================
// Requirement: 每周深度复盘生成(PM 方向:探索维度由模型自主判断)
// =========================================================================

describe('Requirement: 每周深度复盘生成', () => {
  it('Scenario 周复盘跨天聚合:本周深度复盘 → kind=weekly,不携带模块列表与提示词字段', async () => {
    const user = userEvent.setup();
    mock.review.generate.mockResolvedValue(okRes(makeReviewMeta({ id: 'r2', kind: 'weekly' })));
    await renderToday();
    await user.click(screen.getByRole('button', { name: '本周深度复盘' }));
    const req = mock.review.generate.mock.calls[0][0];
    expect(req.kind).toBe('weekly');
    expect(req.modules).toBeUndefined();
  });
});

// =========================================================================
// Requirement: 报告存档与历史(生成中状态)
// =========================================================================

describe('Requirement: 报告存档与历史', () => {
  it('生成中状态:点击后按钮禁用 + Thinking Orb;generate 完成后列表出现新条目并恢复按钮', async () => {
    const user = userEvent.setup();
    const meta = makeReviewMeta({ id: 'r-new', dateISO: '2026-08-07' });
    // 首载空列表;生成成功后刷新返回新条目
    mock.review.list.mockResolvedValueOnce(okRes([])).mockResolvedValue(okRes([meta]));
    let resolveGen!: (v: { status: 'ok'; value: ReviewMeta }) => void;
    mock.review.generate.mockReturnValue(
      new Promise((res) => {
        resolveGen = res as (v: { status: 'ok'; value: ReviewMeta }) => void;
      }),
    );
    await renderToday();

    const dailyBtn = screen.getByRole('button', { name: '今日复盘' });
    await user.click(dailyBtn);

    // 生成中:按钮禁用 + Thinking Orb 呈现
    expect(dailyBtn).toBeDisabled();
    const pending = screen.getByTestId('review-pending');
    expect(pending.textContent).toMatch(/生成中/);
    expect(pending.querySelector('[class*="orb"]')).not.toBeNull();

    // 生成完成:新条目入列,按钮恢复
    await act(async () => {
      resolveGen(okRes(meta));
    });
    await waitFor(() => expect(screen.getByTestId('review-item')).toBeInTheDocument());
    expect(screen.queryByTestId('review-pending')).not.toBeInTheDocument();
    expect(dailyBtn).not.toBeDisabled();
    expect(mock.review.list).toHaveBeenCalledTimes(2); // 首载 + 生成后刷新
  });

  it('Scenario 报告持久化:历史列表按 createdAt 倒序渲染', async () => {
    mock.review.list.mockResolvedValue(
      okRes([
        makeReviewMeta({ id: 'old', dateISO: '2026-08-05', createdAt: 1_000 }),
        makeReviewMeta({ id: 'mid', dateISO: '2026-08-06', createdAt: 2_000 }),
        makeReviewMeta({ id: 'new', dateISO: '2026-08-07', createdAt: 3_000 }),
      ]),
    );
    await renderToday();
    const items = reviewItems();
    expect(items).toHaveLength(3);
    expect(items.map((el) => el.getAttribute('data-id'))).toEqual(['new', 'mid', 'old']);
  });

  it('退化:list 返回空 → 复盘栏显示空态文案与指引,而非空白', async () => {
    await renderToday();
    const empty = screen.getByTestId('review-empty');
    expect(empty.textContent).toMatch(/(复盘|报告)/);
    expect(empty.textContent).toMatch(/(生成|开始)/);
  });
});

// =========================================================================
// PM 方向:报告展示不再含模块(kind+date),modal 内无模块文本
// =========================================================================

describe('PM 方向: 报告展示(kind+date,无模块)', () => {
  it('历史列表项展示 kind+date,不显示模块文本;modal 内亦无模块文本,只读渲染照旧', async () => {
    const user = userEvent.setup();
    const meta = makeReviewMeta({ id: 'r1', kind: 'daily', dateISO: '2026-08-07' });
    mock.review.list.mockResolvedValue(okRes([meta]));
    mock.review.read.mockResolvedValue(okRes({ meta, markdown: makeReviewMarkdown(meta) }));
    await renderToday();

    // 列表项:kind+date 展示,无模块文本(中文 label 或英文 ID 均不出现)
    const item = screen.getByTestId('review-item');
    expect(item.textContent).toMatch(/2026-08-07/);
    expect(item.textContent).toMatch(/每日复盘/);
    expect(item.textContent).not.toMatch(/摘要|遗漏提醒|用量|代码|summary|missed|usage|code/i);

    // modal:无模块文本;只读 markdown 渲染与阅读照旧
    await user.click(item);
    const dialog = await screen.findByRole('dialog', { name: /复盘/ });
    expect(
      within(dialog).queryByText(/摘要|遗漏提醒|用量|代码|summary|missed|usage|code/i),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /每日复盘/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
  });
});

// =========================================================================
// Requirement: 生成失败与无模型退化
// =========================================================================

describe('Requirement: 生成失败与无模型退化', () => {
  it('Scenario 无模型配置:generate 返回 model-unavailable → 提示含下一步指引,时间线不受影响', async () => {
    const user = userEvent.setup();
    mock.review.generate.mockResolvedValue(
      errRes('model-unavailable', '没有可用的模型提供方'),
    );
    await renderToday();
    const blocksBefore = screen.getAllByTestId('today-block').length;
    expect(blocksBefore).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: '今日复盘' }));
    const err = await screen.findByTestId('review-error');
    expect(err.textContent).toContain('没有可用的模型提供方');
    expect(err.textContent).toMatch(/(设置|配置模型)/); // 下一步指引
    // 时间线、统计与事实层不受影响
    expect(screen.getAllByTestId('today-block').length).toBe(blocksBefore);
    expect(screen.getByTestId('today-page')).toBeInTheDocument();
  });

  it('复审 #N2 退化:generate 返回 review-timed-out → 提示「生成超时」类文案 + 重试指引,不出现配置模型引导', async () => {
    // 后端将分离独立错误码 review-timed-out;前端提示不得误走 model-unavailable
    // 专属的「设置/配置模型」引导,且重试指引由前端给出(不依赖后端消息自带「重试」)。
    const user = userEvent.setup();
    mock.review.generate.mockResolvedValue(errRes('review-timed-out', '复盘生成超时'));
    await renderToday();

    await user.click(screen.getByRole('button', { name: '今日复盘' }));
    const err = await screen.findByTestId('review-error');
    expect(err.textContent).toMatch(/超时/); // 「生成超时」类文案
    expect(err.textContent).toMatch(/重试/); // 重试指引(前端提供,非后端消息)
    expect(err.textContent).not.toMatch(/(设置|配置模型)/); // model-unavailable 专属,不得出现
    expect(within(err).queryByRole('button', { name: '去配置模型' })).not.toBeInTheDocument();
    // 入口恢复,可重试
    expect(screen.getByRole('button', { name: '今日复盘' })).not.toBeDisabled();
  });

  it('Scenario 生成中途失败:generate reject → 提示失败原因,无半成品条目进列表,可重试', async () => {
    const user = userEvent.setup();
    mock.review.generate.mockRejectedValue(new Error('llm down'));
    await renderToday();

    await user.click(screen.getByRole('button', { name: '今日复盘' }));
    expect(await screen.findByTestId('review-error')).toBeInTheDocument();
    // 无半成品条目
    expect(reviewItems()).toHaveLength(0);
    // 入口恢复,可重试(再次点击重新触发 generate)
    const dailyBtn = screen.getByRole('button', { name: '今日复盘' });
    expect(dailyBtn).not.toBeDisabled();
    mock.review.generate.mockResolvedValue(okRes(makeReviewMeta({ id: 'retry-ok' })));
    await user.click(dailyBtn);
    expect(mock.review.generate).toHaveBeenCalledTimes(2);
  });
});
