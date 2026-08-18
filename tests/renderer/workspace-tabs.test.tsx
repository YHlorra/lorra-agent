import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTabs } from '../../src/renderer/workspace-tabs';

// 顶栏 tab「×」(2026-08-18):从最近工作区列表移除,仅界面减负。
// 契约:激活 tab 不渲染移除按钮(保持 recentWorkspaces[0]=激活 不变量);
// × 只触发 onRemove,不冒泡成激活;tab 主体点击仍走 onActivate。
describe('WorkspaceTabs 移除最近工作区', () => {
  it('激活 tab 不渲染移除按钮,非激活 tab 渲染', () => {
    render(
      <WorkspaceTabs
        workspaces={['/ws/a', '/ws/b']}
        activePath="/ws/a"
        onActivate={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '从列表移除 a' })).toBeNull();
    expect(screen.getByRole('button', { name: '从列表移除 b' })).toBeInTheDocument();
  });

  it('点击 × 调 onRemove(path) 且不触发 onActivate', () => {
    const onActivate = vi.fn();
    const onRemove = vi.fn();
    render(
      <WorkspaceTabs
        workspaces={['/ws/a', '/ws/b']}
        activePath="/ws/a"
        onActivate={onActivate}
        onAdd={() => {}}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '从列表移除 b' }));
    expect(onRemove).toHaveBeenCalledWith('/ws/b');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('点击 tab 主体(非 ×)触发 onActivate', () => {
    const onActivate = vi.fn();
    render(
      <WorkspaceTabs
        workspaces={['/ws/b']}
        activePath="/ws/a"
        onActivate={onActivate}
        onAdd={() => {}}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'b' }));
    expect(onActivate).toHaveBeenCalledWith('/ws/b');
  });
});
