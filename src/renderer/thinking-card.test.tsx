import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useAppStore } from './lib/app-store';
import { ThinkingCard } from './thinking-card';

describe('ThinkingCard', () => {
  it('Given partial 思考 When 渲染 Then 默认展开,全文可见(流式)+标题「思考」+「思考中」', () => {
    const { container } = render(<ThinkingCard messageId="m1" thinking="正在想…" running />);

    const button = screen.getByRole('button', { name: /思考/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('思考中')).toBeInTheDocument();
    // 默认展开:流式全文直接可见(detail 在文档中)。
    const detailText = container.querySelector('.thinking-detail p');
    expect(detailText).not.toBeNull();
    expect(detailText?.textContent).toBe('正在想…');
  });

  it('Given 点击标题 When 渲染 Then 折叠收起全文,再点展开恢复', async () => {
    const user = userEvent.setup();
    const { container } = render(<ThinkingCard messageId="m1" thinking="深度的思考内容" running />);

    const button = screen.getByRole('button', { name: /思考/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.thinking-detail')).toBeNull();
    // 折叠后流式期仍显示单行预览(aria-hidden)。
    const preview = container.querySelector('.thinking-preview');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe('深度的思考内容');

    await user.click(button);
    expect(container.querySelector('.thinking-detail')).not.toBeNull();
  });

  it('Given final 思考 When 渲染 Then 默认展开全文,标题带耗时且显示「已完成」', () => {
    const { container } = render(
      <ThinkingCard messageId="m1" thinking="最终思考" durationMs={35_000} />,
    );

    expect(screen.getByRole('button', { name: /思考 · 35秒/ })).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(container.querySelector('.thinking-detail p')?.textContent).toBe('最终思考');
  });

  it('Given markdown 思考内容 When 渲染 Then 全文渲染为 Markdown(加粗可见)', () => {
    const { container } = render(<ThinkingCard messageId="m1" thinking="**加粗** 文本" />);

    expect(container.querySelector('.thinking-text strong')).not.toBeNull();
    expect(screen.getByText('加粗')).toBeInTheDocument();
  });

  it('Given thinkingRedacted When 渲染 Then 默认展开显示折叠提示', () => {
    render(<ThinkingCard messageId="m1" thinking="" running thinkingRedacted />);

    expect(screen.getByText('（思考内容已被安全策略折叠）')).toBeInTheDocument();
  });

  it('Given 设置「默认隐藏思考链」When 渲染 Then 思考卡默认折叠,仅单行预览;点击可展开', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ defaultHideThinking: true });
    const { container } = render(<ThinkingCard messageId="m1" thinking="深度的思考内容" running />);

    const button = screen.getByRole('button', { name: /思考/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.thinking-detail')).toBeNull();
    // 折叠时流式预览仍可见(内容不丢,只是收起)。
    expect(container.querySelector('.thinking-preview')?.textContent).toBe('深度的思考内容');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.thinking-detail p')?.textContent).toBe('深度的思考内容');
  });
});
