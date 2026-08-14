import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffCard } from '../../src/renderer/diff-card';
import { stripAnsi } from '../../src/renderer/lib/ansi';

describe('stripAnsi', () => {
  it('剥离 SGR 颜色序列', () => {
    expect(stripAnsi('\x1b[31m-red\x1b[0m')).toBe('-red');
    expect(stripAnsi('\x1b[1m\x1b[32m+green\x1b[0m')).toBe('+green');
  });

  it('无 ANSI 时原样返回', () => {
    expect(stripAnsi('plain diff')).toBe('plain diff');
  });
});

describe('DiffCard', () => {
  const baseProps = {
    diff: '-old\n+new',
    fileName: 'docs/a.md',
    editId: 'call-1',
    onOpen: () => {},
    onAccept: vi.fn(async () => true),
    onRevert: vi.fn(async () => ({ ok: true, fileId: 'docs/a.md' })),
  };

  it('渲染剥码后的 diff 与文件名,三按钮齐全', () => {
    render(
      <DiffCard
        {...baseProps}
        diff={`\x1b[31m-old\x1b[0m\n\x1b[32m+new\x1b[0m`}
      />,
    );
    expect(screen.getByText('docs/a.md')).toBeInTheDocument();
    expect(document.querySelector('.diff-card-code')?.textContent).toBe('-old\n+new');
    expect(screen.getByRole('button', { name: '接受' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复原' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '在中栏打开' })).toBeInTheDocument();
    // 无残留转义序列
    expect(document.querySelector('.diff-card-code')?.textContent).not.toContain('\x1b');
  });

  it('超 20000 字符截断并标注', () => {
    const long = 'x'.repeat(25000);
    render(<DiffCard {...baseProps} diff={long} />);
    const code = document.querySelector('.diff-card-code');
    expect(code?.textContent).toContain('…（已截断）');
    expect(code?.textContent?.length).toBeLessThan(25000);
  });

  it('点「接受」成功后按钮区变「已接受」+ 仅剩打开按钮', async () => {
    const user = userEvent.setup();
    render(<DiffCard {...baseProps} />);
    await user.click(screen.getByRole('button', { name: '接受' }));

    expect(baseProps.onAccept).toHaveBeenCalledWith('call-1');
    expect(screen.getByText('已接受')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接受' })).toBeNull();
    expect(screen.getByRole('button', { name: '在中栏打开' })).toBeInTheDocument();
  });

  it('点「复原」成功后变「已复原」并回调 onReverted(fileId)', async () => {
    const onReverted = vi.fn();
    const user = userEvent.setup();
    render(<DiffCard {...baseProps} onReverted={onReverted} />);
    await user.click(screen.getByRole('button', { name: '复原' }));

    expect(baseProps.onRevert).toHaveBeenCalledWith('call-1');
    expect(screen.getByText('已复原')).toBeInTheDocument();
    expect(onReverted).toHaveBeenCalledWith('docs/a.md');
  });

  it('复原失败显示错误文案,按钮保留可重试', async () => {
    const onRevert = vi.fn(async () => ({ ok: false, error: '文件已被手动修改，无法复原' }));
    const user = userEvent.setup();
    render(<DiffCard {...baseProps} onRevert={onRevert} />);
    await user.click(screen.getByRole('button', { name: '复原' }));

    expect(screen.getByRole('alert').textContent).toContain('文件已被手动修改');
    expect(screen.getByRole('button', { name: '复原' })).toBeInTheDocument();
  });

  it('接受失败显示错误态,按钮保留', async () => {
    const onAccept = vi.fn(async () => false);
    const user = userEvent.setup();
    render(<DiffCard {...baseProps} onAccept={onAccept} />);
    await user.click(screen.getByRole('button', { name: '接受' }));

    expect(screen.queryByText('已接受')).toBeNull();
    expect(screen.getByRole('button', { name: '复原' })).toBeInTheDocument();
  });

  it('Promise 期间按钮禁用防连点', async () => {
    let resolveAccept!: (v: boolean) => void;
    const onAccept = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveAccept = r;
        }),
    );
    const user = userEvent.setup();
    render(<DiffCard {...baseProps} onAccept={onAccept} />);

    await user.click(screen.getByRole('button', { name: '接受' }));
    expect(screen.getByRole('button', { name: '接受' })).toBeDisabled();
    resolveAccept(true);
    await screen.findByText('已接受');
  });
});
