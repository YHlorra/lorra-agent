/**
 * 复盘报告 modal 阅读黑盒测试(agent-memory-today-timeline)。
 *
 * 规范真源:
 * - 
 * Requirement 应用内阅读(居中 modal、渲染 Markdown、只读不改原文)
 * - ui-design/today-timeline-v2.html:modal-backdrop + modal(role="dialog"
 * aria-modal="true" aria-label="复盘报告")+ modal-close + modal-body;
 * Esc / backdrop / 关闭按钮关闭,打开时焦点进关闭按钮
 *
 * 实现不存在——整组为红色。钩子契约:
 * role="dialog" + aria-label 含「复盘」 报告 modal
 * button 关闭(aria-label="关闭") modal 关闭按钮
 * data-testid="review-item" + data-id 历史条目(button,点击 → read(id))
 * modal 内错误态:文本 + button 重试 read 失败路径
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { TodayPage } from '../../src/renderer/today-page';
import {
  errRes,
  installReviewLorraMock,
  makeReviewMarkdown,
  makeReviewMeta,
  okRes,
  type ReviewLorraMock,
} from './review-test-data';

let mock: ReviewLorraMock;

beforeEach(() => {
  mock = installReviewLorraMock();
});

/** 渲染今日页 + 单条目历史,返回该条目元素。 */
async function renderWithOneReview(): Promise<HTMLElement> {
  const meta = makeReviewMeta({ id: 'r1', kind: 'daily', dateISO: '2026-08-07' });
  mock.review.list.mockResolvedValue(okRes([meta]));
  mock.review.read.mockResolvedValue(okRes({ meta, markdown: makeReviewMarkdown(meta) }));
  render(<TodayPage />);
  await screen.findAllByTestId('today-block');
  const item = screen.getByTestId('review-item');
  expect(item).toBeInTheDocument();
  return item;
}

// =========================================================================
// Requirement: 应用内阅读
// =========================================================================

describe('Requirement: 应用内阅读', () => {
  it('Scenario 打开历史报告:点击历史条目 → read(id) → 居中 modal 渲染 Markdown', async () => {
    const user = userEvent.setup();
    const item = await renderWithOneReview();

    await user.click(item);
    // 回归守卫(生产 bug:ENOENT .../undefined.md):read 必须收到
    // { id } 对象而非裸字符串——契约单一事实源 shared/review-api。
    expect(mock.review.read).toHaveBeenCalledWith({ id: 'r1' });

    const dialog = await screen.findByRole('dialog', { name: /复盘/ });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // 复审 #N4:打开后焦点必须移入对话框内(关闭按钮)——设计稿「打开时焦点进
    // 关闭按钮」,即 focus trap 入口;当前实现只记录触发元素,焦点停在触发条目。
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '关闭' }));
    // markdown 三层结构渲染:标题 + 章节 + 条目
    expect(within(dialog).getByRole('heading', { name: /每日复盘/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /全局概览/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /工作区明细/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /跨项目洞察/ })).toBeInTheDocument();
  });

  it('阅读 MUST NOT 修改报告原文:modal 只读,无任何编辑控件', async () => {
    const user = userEvent.setup();
    const item = await renderWithOneReview();
    await user.click(item);

    const dialog = await screen.findByRole('dialog', { name: /复盘/ });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    // within 只暴露查询集(queryBy*),无 querySelector——只读校验走原生 DOM 查询。
    expect(dialog.querySelector('[contenteditable="true"]')).toBeNull();
    expect(dialog.querySelector('textarea, input')).toBeNull();
  });

  it('Esc 与关闭按钮均可关闭 modal,关闭后焦点返还触发条目', async () => {
    const user = userEvent.setup();
    const item = await renderWithOneReview();

    // Esc 关闭
    await user.click(item);
    let dialog = await screen.findByRole('dialog', { name: /复盘/ });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /复盘/ })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(item); // 焦点返还

    // 关闭按钮关闭
    await user.click(item);
    dialog = await screen.findByRole('dialog', { name: /复盘/ });
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog', { name: /复盘/ })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(item);
  });

  it('退化:read 失败 → modal 显示错误与重试,不白屏;重试成功恢复内容', async () => {
    const user = userEvent.setup();
    const meta = makeReviewMeta({ id: 'r1', kind: 'daily', dateISO: '2026-08-07' });
    mock.review.list.mockResolvedValue(okRes([meta]));
    mock.review.read
      .mockResolvedValueOnce(errRes('read-failed', '报告文件损坏'))
      .mockResolvedValue(okRes({ meta, markdown: '# 恢复的报告\n\n内容已恢复' }));
    render(<TodayPage />);
    await screen.findAllByTestId('today-block');

    await user.click(screen.getByTestId('review-item'));
    const dialog = await screen.findByRole('dialog', { name: /复盘/ });
    expect(within(dialog).getByText('报告文件损坏')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /重试/ })).toBeInTheDocument();

    // 重试 → 再次 read → 内容渲染,错误消失
    await user.click(within(dialog).getByRole('button', { name: /重试/ }));
    expect(mock.review.read).toHaveBeenCalledTimes(2);
    expect(await within(dialog).findByRole('heading', { name: /恢复的报告/ })).toBeInTheDocument();
    expect(within(dialog).queryByText('报告文件损坏')).not.toBeInTheDocument();
  });
});
