import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_TYPING_IDLE_MS, ApprovalModal } from '../../src/renderer/approval-modal';

export type ApprovalDecision = 'allowOnce' | 'allowAlways' | 'deny';

const APPROVAL = {
  approvalId: 'a1',
  toolName: 'write',
  target: 'D:/out.txt',
  reason: 'approval-required: 写入位置在工作区外',
};

function renderModal(
  over: {
    onRespond?: (id: string, d: ApprovalDecision) => Promise<void>;
  } = {},
) {
  const onRespond = over.onRespond ?? vi.fn(async () => {});
  render(<ApprovalModal approval={APPROVAL} onRespond={onRespond} />);
  return onRespond;
}

describe('ApprovalModal 分级审批模态', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('未在打字时立即弹出;展示工具/目标/reason,焦点落在拒绝按钮(默认安全)', () => {
    renderModal();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('AI 请求执行')).toBeInTheDocument();
    expect(screen.getByText('write')).toBeInTheDocument();
    expect(screen.getByText('D:/out.txt')).toBeInTheDocument();
    expect(screen.getByText('写入位置在工作区外')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toHaveFocus();
  });

  it('渲染三选项按钮:允许一次 / 总是允许 / 拒绝', () => {
    renderModal();

    expect(screen.getByRole('button', { name: '允许一次' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '总是允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
  });

  it('用户在打字(composer 聚焦且有内容)时延迟弹出,空闲后出现', () => {
    // 模拟用户在 composer 输入:聚焦有内容的 textarea。
    const ta = document.createElement('textarea');
    ta.value = '正在输入的消息';
    document.body.appendChild(ta);
    ta.focus();

    renderModal();
    expect(screen.queryByRole('alertdialog')).toBeNull(); // 不打断输入

    act(() => {
      vi.advanceTimersByTime(APPROVAL_TYPING_IDLE_MS - 1);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull(); // 未到空闲阈值

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    ta.remove();
  });

  it('允许一次 → onRespond(approvalId, allowOnce),不持久化由 driver 语义保证', async () => {
    const onRespond = renderModal();

    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await act(async () => {});
    expect(onRespond).toHaveBeenCalledWith('a1', 'allowOnce');
  });

  it('总是允许 → onRespond(approvalId, allowAlways)', async () => {
    const onRespond = renderModal();

    fireEvent.click(screen.getByRole('button', { name: '总是允许' }));
    await act(async () => {});
    expect(onRespond).toHaveBeenCalledWith('a1', 'allowAlways');
  });

  it('拒绝 → onRespond(approvalId, deny)', async () => {
    const onRespond = renderModal();

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await act(async () => {});
    expect(onRespond).toHaveBeenCalledWith('a1', 'deny');
  });

  it('裁决期间按钮禁用,防止重复提交', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const onRespond = vi.fn(async () => {
      await gate;
    });
    renderModal({ onRespond });

    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    expect(screen.getByRole('button', { name: '允许一次' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '总是允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled();

    await act(async () => {
      release();
    });
    expect(screen.getByRole('button', { name: '允许一次' })).toBeEnabled();
  });
});
