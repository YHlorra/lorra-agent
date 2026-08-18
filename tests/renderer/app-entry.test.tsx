/**
 * Black-box component tests for the App entry / empty-state / model-availability
 * triad (of the model-provider-config change). Verifies the
 * spec-defined wiring between chat header → ProvidersPage navigation and
 * the chat-pane empty state.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../src/renderer/App';
import { installLorraMock, makeLorraMock } from './lorra-test-helpers';

beforeEach(() => {
  // workspacePath so App goes past the picker into workspace view.
  globalThis.__lorraStub = { workspacePath: 'C:/test/workspace' };
});

afterEach(() => {
  cleanup();
  globalThis.__lorraStub = undefined;
});

/** Wait until the chat header is in the DOM (App is fully mounted). */
async function waitForAppReady(): Promise<void> {
  await screen.findByRole('region', { name: 'Agent 对话' });
}

/** Header model-state button (the .model-state-btn in the chat header). */
function headerModelStateBtn(): HTMLButtonElement {
  const btn = document.querySelector('button.model-state-btn');
  if (!btn) throw new Error('Header model-state button not found');
  return btn as HTMLButtonElement;
}

/** Chat-pane empty-CTA button (the .pc-btn-primary inside .chat-empty-cta). */
function chatEmptyCtaBtn(): HTMLButtonElement {
  const btn = document.querySelector('.chat-empty-cta button');
  if (!btn) throw new Error('Chat empty CTA button not found');
  return btn as HTMLButtonElement;
}

describe('7.3 入口跳转与空/正常态', () => {
  it('头部 model-state 按钮: 点头部入口 → 配置页（ProvidersPage）出现', async () => {
    const m = makeLorraMock();
    m.session.continueRecent.mockResolvedValue({ ok: true, value: { sessionId: 'sess-test' } });
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = userEvent.setup();
    render(<App />);

    await waitForAppReady();
    // Wait for chat-model-state to settle.
    await waitFor(() => {
      expect(headerModelStateBtn().textContent).toContain('连接模型');
    });
    await user.click(headerModelStateBtn());

    // ProvidersPage mounts. The rail has "已连接" + "默认模型" headings;
    // the "返回工作区" button replaces the workspace grid.
    expect(await screen.findByText('返回工作区')).toBeInTheDocument();
    expect(screen.getByText('已连接')).toBeInTheDocument();
    expect(screen.getByText('默认模型')).toBeInTheDocument();
  });

  it('引导态: getAvailable=[] 且 getDefault=null → 头部 CTA + 空状态 CTA + 发送禁用', async () => {
    const m = makeLorraMock();
    m.session.continueRecent.mockResolvedValue({ ok: true, value: { sessionId: 'sess-test' } });
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.models.getAvailable.mockResolvedValue({ ok: true, value: [] });
    m.models.getDefault.mockResolvedValue({ ok: true, value: null });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    render(<App />);
    await waitForAppReady();

    // Wait for the chat-model-state to settle (loading → empty).
    await waitFor(() => {
      expect(headerModelStateBtn().textContent).toContain('连接模型');
    });

    // 1) 头部 model-state 按钮显示引导文案「连接模型」(aria-label + visible text).
    expect(headerModelStateBtn().getAttribute('aria-label')).toBe('连接模型');

    // 2) 对话区空状态 CTA 出现: 一个独立的「连接模型」按钮 + 说明文案.
    const ctaText = await screen.findByText('暂无可用模型，连接一个供应商开始对话。');
    expect(ctaText).toBeInTheDocument();
    expect(chatEmptyCtaBtn().textContent).toContain('连接模型');

    // 3) Composer 发送按钮被禁用 (modelAvailable=false).
    const send = await screen.findByRole('button', { name: '发送' });
    expect(send).toBeDisabled();
  });

  it('正常态: getAvailable 非空 + getDefault 有值 → 显示默认名，无 CTA，发送可用', async () => {
    const m = makeLorraMock();
    m.session.continueRecent.mockResolvedValue({ ok: true, value: { sessionId: 'sess-test' } });
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.models.getAvailable.mockResolvedValue(
      { ok: true, value: [
        {
          id: 'claude-x',
          name: 'Claude X',
          provider: 'anthropic',
          contextWindow: 8192,
          maxTokens: 1024,
          reasoning: false,
          enabled: true,
          default: true,
          available: true,
        },
      ] },
    );
    m.models.getDefault.mockResolvedValue({ ok: true, value: { providerId: 'anthropic', modelId: 'claude-x' } });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    render(<App />);
    await waitForAppReady();

    // Wait for chat-model-state to settle.
    await waitFor(() => {
      expect(headerModelStateBtn().textContent).toContain('Claude X');
    });

    // 1) 头部按钮的 aria-label 切到「打开模型供应商配置」 (spec-mandated affordance).
    expect(headerModelStateBtn().getAttribute('aria-label')).toBe('打开模型供应商配置');
    expect(headerModelStateBtn().textContent).toContain('Claude X');

    // 2) 不显示引导 CTA 文案.
    expect(screen.queryByText('暂无可用模型，连接一个供应商开始对话。')).toBeNull();
    expect(document.querySelector('.chat-empty-cta')).toBeNull();

    // 3) Composer 显示默认模型名 + 发送可用.
    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    expect(composer).toBeInTheDocument();
    // The model name appears both in the header button AND in the composer's
    // presence row — assert presence (both places) without assuming one DOM node.
    expect(document.querySelector('.composer-model-name')?.textContent).toBe('Claude X');
    const send = screen.getByRole('button', { name: '发送' });
    expect(send).toBeEnabled();
  });

  // Regression for "session history management": the sidebar should list
  // past sessions surfaced by the SDK's SessionManager (consumed via
  // lorra.session.list) and clicking one should drive session.open.
  it('会话侧边栏: list 有历史 → 渲染行 → 点行调 open', async () => {
    const m = makeLorraMock();
    m.session.continueRecent.mockResolvedValue({ ok: true, value: { sessionId: 'sess-test' } });
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.models.getAvailable.mockResolvedValue(
      { ok: true, value: [
        {
          id: 'claude-x',
          name: 'Claude X',
          provider: 'anthropic',
          contextWindow: 8192,
          maxTokens: 1024,
          reasoning: false,
          enabled: true,
          default: true,
          available: true,
        },
      ] },
    );
    m.models.getDefault.mockResolvedValue({ ok: true, value: { providerId: 'anthropic', modelId: 'claude-x' } });
    m.session.list.mockResolvedValue(
      { ok: true, value: [
        {
          id: 'past-1',
          cwd: '/test/workspace',
          path: '/test/workspace/.pi/sessions/past-1.jsonl',
          created: new Date('2026-07-29T10:00:00Z'),
          modified: new Date('2026-07-29T10:30:00Z'),
          messageCount: 4,
          firstMessage: '修复 Composer 输入清空',
        },
      ] },
    );
    m.session.open.mockResolvedValue({ ok: true, value: { sessionId: 'past-1' } });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = userEvent.setup();
    render(<App />);
    await waitForAppReady();

    const row = await screen.findByRole('button', { name: /修复 Composer 输入清空/ });
    expect(row).toBeInTheDocument();
    await user.click(row);
    expect(m.session.open).toHaveBeenCalledWith({ sessionId: 'past-1' });
  });

  it('实时事件: 用户与助手流式消息各显示一条可见气泡', async () => {
    const m = makeLorraMock();
    let emit: ((event: unknown) => void) | undefined;
    m.session.continueRecent.mockResolvedValue({ ok: true, value: { sessionId: 'sess-test' } });
    m.events.subscribe.mockImplementation((callback: (event: unknown) => void) => {
      emit = callback;
      return () => {};
    });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    render(<App />);
    await waitForAppReady();
    await waitFor(() => expect(emit).toBeTypeOf('function'));

    emit?.({
      sessionId: 'sess-test',
      eventId: 'user-1',
      seq: 1,
      ts: Date.now(),
      type: 'message.final',
      role: 'user',
      messageId: 'user-message-1',
      content: { text: '我的问题' },
    });
    emit?.({
      sessionId: 'sess-test',
      eventId: 'assistant-1',
      seq: 2,
      ts: Date.now(),
      type: 'message.partial',
      role: 'assistant',
      messageId: 'assistant-message-1',
      content: { text: '初步回答' },
    });
    emit?.({
      sessionId: 'sess-test',
      eventId: 'assistant-2',
      seq: 3,
      ts: Date.now(),
      type: 'message.partial',
      role: 'assistant',
      messageId: 'assistant-message-1',
      content: { text: '完整回答' },
    });
    emit?.({
      sessionId: 'sess-test',
      eventId: 'assistant-3',
      seq: 4,
      ts: Date.now(),
      type: 'message.final',
      role: 'assistant',
      messageId: 'assistant-message-1',
      content: { text: '最终回答' },
    });

    await waitFor(() => {
      expect(screen.getByText('我的问题')).toBeInTheDocument();
      expect(screen.getByText('最终回答')).toBeInTheDocument();
      expect(document.querySelectorAll('.message.user')).toHaveLength(1);
      expect(document.querySelectorAll('.message.assistant')).toHaveLength(1);
    });
  });

  // 6.10 缝隙修复：命令面板(Ctrl+P)列出 /review，选中须走生成链路并反馈，
  // 不再 no-op。
  it('命令面板 /review: 选中 → review.generate({kind:"daily"}) + 成功提示', async () => {
    const m = makeLorraMock();
    m.session.continueRecent.mockResolvedValue({ ok: true, value: { sessionId: 'sess-test' } });
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.models.getAvailable.mockResolvedValue(
      { ok: true, value: [
        {
          id: 'claude-x',
          name: 'Claude X',
          provider: 'anthropic',
          contextWindow: 8192,
          maxTokens: 1024,
          reasoning: false,
          enabled: true,
          default: true,
          available: true,
        },
      ] },
    );
    m.models.getDefault.mockResolvedValue({ ok: true, value: { providerId: 'anthropic', modelId: 'claude-x' } });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = userEvent.setup();
    render(<App />);
    await waitForAppReady();

    await user.keyboard('{Control>}p{/Control}');
    const reviewItem = await screen.findByText('/review');
    await user.click(reviewItem);

    await waitFor(() => expect(m.review.generate).toHaveBeenCalledWith({ kind: 'daily' }));
    expect(await screen.findByText('复盘已生成，可在今日页查看。')).toBeInTheDocument();
  });

  it('命令面板 /review 退化: model-unavailable → 互斥文案（不复用超时文案）', async () => {
    const m = makeLorraMock();
    m.session.continueRecent.mockResolvedValue({ ok: true, value: { sessionId: 'sess-test' } });
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.review.generate.mockResolvedValue(
      { ok: false, error: { code: 'model-unavailable', message: 'no model configured' } },
    );
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = userEvent.setup();
    render(<App />);
    await waitForAppReady();

    await user.keyboard('{Control>}p{/Control}');
    const reviewItem = await screen.findByText('/review');
    await user.click(reviewItem);

    const hint = await screen.findByText(/没有可用的模型提供方/);
    expect(hint).toBeInTheDocument();
    expect(screen.queryByText(/复盘生成超时/)).toBeNull();
  });
});

// 消息队列(2026-08-17 需求):agent 忙碌时发送 → 入队;空闲事件到达 → 队首自动发出;
// 「立即发送」→ abort 打断 + 直接 send。经 events.subscribe 推 session.status 事件
// 驱动 App 状态(与生产链路同源:SDK 事件 → EventRouter → wc.send → reducer)。
describe('消息队列(App 集成)', () => {
  let seq = 0;

  async function setupQueueApp() {
    const m = makeLorraMock();
    m.session.continueRecent.mockResolvedValue({ ok: true, value: { sessionId: 'sess-q' } });
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.models.getAvailable.mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'claude-x',
          name: 'Claude X',
          provider: 'anthropic',
          contextWindow: 8192,
          maxTokens: 1024,
          reasoning: false,
          enabled: true,
          default: true,
          available: true,
        },
      ],
    });
    m.models.getDefault.mockResolvedValue({
      ok: true,
      value: { providerId: 'anthropic', modelId: 'claude-x' },
    });
    let listener: ((event: unknown) => void) | undefined;
    m.events.subscribe.mockImplementation((cb: (event: unknown) => void) => {
      listener = cb;
      return () => {};
    });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = userEvent.setup();
    render(<App />);
    await waitForAppReady();
    await waitFor(() => expect(listener).toBeDefined());
    const pushStatus = (status: string) => {
      seq += 1;
      listener?.({
        type: 'session.status',
        sessionId: 'sess-q',
        eventId: `ev-${seq}`,
        seq,
        ts: seq,
        status,
      });
    };
    return { m, user, pushStatus };
  }

  it('busy 时发送 → 入队不直发;空闲事件到达 → 队首自动发出、队列清空', async () => {
    const { m, user, pushStatus } = await setupQueueApp();

    // 1) 推忙碌 → 停止按钮出现(busy 生效)
    pushStatus('streaming');
    await screen.findByRole('button', { name: /停止/ });

    // 2) 发送 → 入队(session.send 不被调),队列 UI 显示
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '排队消息一');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(m.session.send).not.toHaveBeenCalled();
    expect(await screen.findByText('排队消息一')).toBeInTheDocument();

    // 3) 空闲事件 → 队首自动发出,队列清空
    pushStatus('idle');
    await waitFor(() =>
      expect(m.session.send).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-q', text: '排队消息一' }),
      ),
    );
    await waitFor(() => expect(screen.queryByText('排队消息一')).toBeNull());
  });

  it('队列消息「立即发送」→ abort 打断 + 直接 send', async () => {
    const { m, user, pushStatus } = await setupQueueApp();

    pushStatus('streaming');
    await screen.findByRole('button', { name: /停止/ });

    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '等不及的消息');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('等不及的消息')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '立即发送' }));

    await waitFor(() => expect(m.session.abort).toHaveBeenCalledWith({ sessionId: 'sess-q' }));
    await waitFor(() =>
      expect(m.session.send).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-q', text: '等不及的消息' }),
      ),
    );
  });

  it('撤回:busy 时入队 → 点撤回 → 队列移除、空闲后不发', async () => {
    const { m, user, pushStatus } = await setupQueueApp();

    pushStatus('streaming');
    await screen.findByRole('button', { name: /停止/ });

    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '说错的话');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('说错的话')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤回' }));
    await waitFor(() => expect(screen.queryByText('说错的话')).toBeNull());

    pushStatus('idle');
    await new Promise((r) => setTimeout(r, 150));
    expect(m.session.send).not.toHaveBeenCalled();
  });
});
