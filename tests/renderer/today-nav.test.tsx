/**
 * App 导航增量黑盒测试(agent-memory-today-timeline,,TDD 第一棒)。
 *
 * 规范真源:
 * - 
 * (导航三态扩展为四态 / 今日页不渲染工作区 tab 条 / 页面切换状态保持)
 * - 
 * 「今日页入口与页面结构」Requirement(图标栏第 2 位入口 / 离开回工作台)
 *
 * 现状:实现已在(未提交),本文件断言「点击/路由/状态」行为;today IPC mock
 * 钉生产 SerializedResult 信封 {status:'ok',value}。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '@/lib/app-store';
import { App } from '../../src/renderer/App';
import { makeDayData, okToday } from './today-test-data';
import type { MemoryEntry } from '../../src/shared/memory-schema';

/** 记忆页 bridge 最小 stub(路由渲染需要 list* 三件套)。 */
function okMemory<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

beforeEach(() => {
  globalThis.__lorraStub = { workspacePath: 'C:/test/workspace' };
  // App 需要 window.lorra.today 才能渲染今日页;mock 返回生产 SerializedResult
  // 信封 {status:'ok',value}(与 src/main/ipc/today-ipc.ts 同构)。
  Object.defineProperty(window.lorra, 'today', {
    value: {
      getDayFacts: vi.fn().mockResolvedValue(okToday(makeDayData())),
    },
    writable: true,
    configurable: true,
  });
  // App 需要 window.lorra.memory 才能渲染记忆页(mock 返回 preload toView 形状)。
  Object.defineProperty(window.lorra, 'memory', {
    value: {
      listCandidates: vi.fn().mockResolvedValue(okMemory([] as MemoryEntry[])),
      listActive: vi.fn().mockResolvedValue(okMemory([] as MemoryEntry[])),
      listArchived: vi.fn().mockResolvedValue(okMemory([] as MemoryEntry[])),
      confirm: vi.fn().mockResolvedValue(okMemory(undefined)),
      confirmBatch: vi.fn().mockResolvedValue(okMemory([] as MemoryEntry[])),
      edit: vi.fn().mockResolvedValue(okMemory(undefined)),
      reject: vi.fn().mockResolvedValue(okMemory(undefined)),
      rejectBatch: vi.fn().mockResolvedValue(okMemory([] as MemoryEntry[])),
      retire: vi.fn().mockResolvedValue(okMemory(undefined)),
      search: vi.fn().mockResolvedValue(okMemory([] as MemoryEntry[])),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window.lorra as unknown as Record<string, unknown>).today;
  delete (window.lorra as unknown as Record<string, unknown>).memory;
});

describe('Requirement: 今日页导航(app-shell spec)', () => {
  it('Scenario 导航三态扩展为四态:路由可解析 today 态并渲染今日整页', async () => {
    useAppStore.setState({ page: 'today' });
    render(<App />);

    expect(await screen.findByTestId('today-page')).toBeInTheDocument();
  });

  it('Scenario 从图标栏进入今日页:今日入口位于图标栏第 2 位', async () => {
    render(<App />);
    await screen.findByRole('region', { name: 'Agent 对话' });

    const nav = screen.getByRole('navigation', { name: '页面导航' });
    const buttons = Array.from(nav.querySelectorAll('button'));
    expect(buttons[1]).toHaveAttribute('aria-label', '今日');
  });

  it('Scenario 从图标栏进入今日页:点击第 2 位今日入口 → 今日整页,工作区 tab 条不渲染', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('region', { name: 'Agent 对话' });

    await user.click(screen.getByRole('button', { name: '今日' }));

    expect(await screen.findByTestId('today-page')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: '工作区' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agent 对话' })).not.toBeInTheDocument();
  });

  it('Scenario 今日页不渲染工作区 tab 条:today 态内容区为今日页专属布局', async () => {
    useAppStore.setState({ page: 'today' });
    render(<App />);

    expect(await screen.findByTestId('today-page')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: '工作区' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agent 对话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tree', { name: '文件树' })).not.toBeInTheDocument();
  });

  it('Scenario 离开今日页回到工作台 / 页面切换状态保持:会话不重建、三栏布局完整恢复', async () => {
    const user = userEvent.setup();
    const continueSpy = vi
      .spyOn(window.lorra.session, 'continueRecent')
      .mockResolvedValue({ ok: true, value: { sessionId: 'sess-keep' } });
    render(<App />);

    // 工作台就绪:会话活跃,composer 可见。
    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    expect(composer).toBeInTheDocument();

    // 进入今日页。
    await user.click(screen.getByRole('button', { name: '今日' }));
    expect(await screen.findByTestId('today-page')).toBeInTheDocument();

    // 回工作台:三栏布局恢复(会话历史 / 文件树 / 当前文档 / Agent 对话)。
    await user.click(screen.getByRole('button', { name: '工作台' }));
    expect(await screen.findByRole('region', { name: 'Agent 对话' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '向 Agent 提问' })).toBeInTheDocument();
    expect(screen.getByRole('tree', { name: '文件树' })).toBeInTheDocument();

    // 会话状态保持:工作区路径未变,会话 bootstrap 不重跑(仅首挂载 1 次)。
    expect(continueSpy).toHaveBeenCalledTimes(1);
  });

  it('PM 走查回归:窗口控件恒钉右缘——中间槽(titlebar-slot)恒渲染、window-actions 为 titlebar 末子且不随页面切换卸载', async () => {
    // 背景:titlebar 为 grid(44px | 1fr | 420px),旧实现 tab 条直接占中列;
    // 今日页无 tab 时 window-actions 自动落入中列 → 停在标题栏中间(PM 走查)。
    // 根因修复:页面内容只占 titlebar-slot(恒渲染,今日页为空占位),
    // window-actions 恒落第 3 列右缘,不依赖内容撑开。
    // jsdom 无布局引擎,钉结构契约(槽恒渲染 + actions 为末子);像素级右缘
    // 走 
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('region', { name: 'Agent 对话' });

    const titlebar = document.querySelector('.titlebar');
    expect(titlebar).not.toBeNull();
    const actionsAtStart = titlebar!.querySelector('.window-actions');

    // 工作台页:中间槽存在且容纳工作区 tab 条(页面内容只占此槽)。
    let slot = titlebar!.querySelector('.titlebar-slot');
    expect(slot).not.toBeNull();
    expect(within(slot as HTMLElement).getByRole('tablist', { name: '工作区' })).toBeInTheDocument();

    // 进入今日页:中间槽仍渲染(空占位),tab 条不渲染——控件右缘不依赖内容。
    await user.click(screen.getByRole('button', { name: '今日' }));
    await screen.findByTestId('today-page');
    slot = titlebar!.querySelector('.titlebar-slot');
    expect(slot).not.toBeNull();
    expect(within(slot as HTMLElement).queryByRole('tablist', { name: '工作区' })).not.toBeInTheDocument();

    // 窗口控件组:titlebar 末子(右缘 DOM 序),三按钮在位,且不随页面切换卸载(同一 DOM 节点)。
    const actions = titlebar!.querySelector('.window-actions');
    expect(actions).not.toBeNull();
    expect(titlebar!.lastElementChild).toBe(actions);
    expect(actions).toBe(actionsAtStart);
    expect(within(actions as HTMLElement).getByRole('button', { name: '最小化窗口' })).toBeInTheDocument();
    expect(within(actions as HTMLElement).getByRole('button', { name: '最大化窗口' })).toBeInTheDocument();
    expect(within(actions as HTMLElement).getByRole('button', { name: '关闭窗口' })).toBeInTheDocument();
  });
});

describe('Requirement: 记忆页导航(app-shell spec,6.9)', () => {
  it('Scenario 导航四态扩展为五态:路由可解析 memory 态并渲染记忆整页', async () => {
    useAppStore.setState({ page: 'memory' });
    render(<App />);

    expect(await screen.findByTestId('memory-page')).toBeInTheDocument();
  });

  it('Scenario 记忆页入口位于图标栏第 3 位(工作台/今日/记忆)', async () => {
    render(<App />);
    await screen.findByRole('region', { name: 'Agent 对话' });

    const nav = screen.getByRole('navigation', { name: '页面导航' });
    const buttons = Array.from(nav.querySelectorAll('button'));
    expect(buttons[2]).toHaveAttribute('aria-label', '记忆');
  });

  it('Scenario 点击第 3 位记忆入口 → 记忆整页,工作区 tab 条不渲染', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('region', { name: 'Agent 对话' });

    await user.click(screen.getByRole('button', { name: '记忆' }));

    expect(await screen.findByTestId('memory-page')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: '工作区' })).not.toBeInTheDocument();
  });
});
