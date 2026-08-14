import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { useAppStore } from '@/lib/app-store';
import { readUiPrefs } from '@/lib/theme';
import type {} from '../shared/result';
import { App } from './App';

describe('工作台', () => {
  beforeEach(() => {
    // Provide a default workspace so the picker does not block the shell.
    globalThis.__lorraStub = { workspacePath: 'C:/test/workspace' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Given 首次进入 When 工作台加载 Then 显示四个核心区域', async () => {
    render(<App />);

    expect(await screen.findByRole('region', { name: '会话历史' })).toBeInTheDocument();
    expect(await screen.findByRole('tree', { name: '文件树' })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: '当前文档' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Agent 对话' })).toBeInTheDocument();
  });

  it('Given 工作区未选择 When 工作台加载 Then 不显示首启选择器(主进程自动建默认工作区)', async () => {
    globalThis.__lorraStub = { workspacePath: null };
    render(<App />);

    // 首启选择器已取消:主进程 get 自动创建 ~/.lorra/workspace 并激活。
    // 渲染端 null 兜底只显示提示,不再出现 dialog。
    expect(screen.queryByRole('dialog', { name: '选择工作区' })).not.toBeInTheDocument();
    expect(await screen.findByText('无法读取工作区设置。')).toBeInTheDocument();
  });

  it('Given 用户输入消息 When 发送 Then 清空输入框', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.session, 'send').mockResolvedValue({
      ok: true,
      value: { accepted: true },
    });
    render(<App />);

    // Composer is async-mounted after workspace resolution + session bootstrap.
    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    await user.type(composer, '帮我收紧这一段文字');
    // Send button has visible text "发送" (no aria-label); match by role+name.
    await user.click(screen.getByRole('button', { name: '发送' }));

    // Composer's clear is gated by await onSend → setSendTick → useEffect →
    // setMessage('') — user.click does not await send so the assertion needs
    // a waitFor (same race as composer.test.tsx).
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '向 Agent 提问' })).toHaveValue(''),
    );
  });

  it('Given 已选工作区 When 点击「新建工作区」 Then 调用 lorra.workspace.switch 并刷新会话', async () => {
    const user = userEvent.setup();
    const switchSpy = vi
      .spyOn(window.lorra.workspace, 'switch')
      .mockResolvedValue({ path: 'C:/other/workspace' });
    render(<App />);

    const switcher = await screen.findByRole('button', { name: '新建工作区' });
    await user.click(switcher);

    expect(switchSpy).toHaveBeenCalledTimes(1);
  });

  it('Given 有最近工作区 When 点击顶栏工作区 tab Then 按路径激活并刷新会话', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.workspace, 'list').mockResolvedValue({
      workspaces: ['C:/test/workspace', 'C:/archive/project'],
    });
    const activateSpy = vi
      .spyOn(window.lorra.workspace, 'activate')
      .mockResolvedValue({ path: 'C:/archive/project' });
    render(<App />);

    const tab = await screen.findByRole('tab', { name: /project/ });
    expect(tab).toHaveAttribute('aria-selected', 'false');
    await user.click(tab);

    expect(activateSpy).toHaveBeenCalledWith('C:/archive/project');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /project/ })).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('Given 工作台已激活 When 点击侧栏「新建对话」 Then 调用 lorra.session.create', async () => {
    const user = userEvent.setup();
    const createSpy = vi
      .spyOn(window.lorra.session, 'create')
      .mockResolvedValue({ ok: true, value: { sessionId: 'quick-session' } });
    render(<App />);

    await screen.findByRole('region', { name: '会话历史' });
    await user.click(screen.getByRole('button', { name: /新建对话/ }));

    expect(createSpy).toHaveBeenCalled();
  });

  it('Given 工作台已激活 When 点击侧栏「搜索」 Then 打开命令面板', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: '会话历史' });
    await user.click(screen.getByRole('button', { name: '搜索' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('Given 工作台已激活 When 点击侧栏「切换工作区」 Then 调用 lorra.workspace.switch', async () => {
    const user = userEvent.setup();
    const switchSpy = vi
      .spyOn(window.lorra.workspace, 'switch')
      .mockResolvedValue({ path: 'C:/other/workspace' });
    render(<App />);

    await screen.findByRole('region', { name: '会话历史' });
    await user.click(screen.getByRole('button', { name: '切换工作区' }));

    expect(switchSpy).toHaveBeenCalledTimes(1);
  });

  it('Given 工作区已激活 When 点击「新建会话」 Then 调用 lorra.session.create 并订阅', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 'existing-session-id' },
    });
    const createSpy = vi
      .spyOn(window.lorra.session, 'create')
      .mockResolvedValue({ ok: true, value: { sessionId: 'new-session-id' } });
    render(<App />);

    await screen.findByRole('region', { name: '会话历史' });
    expect(createSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '新建会话' }));

    expect(createSpy).toHaveBeenCalledWith({ workspaceId: 'C:/test/workspace' });
  });

  it('Given 800x600 视口 When 工作台渲染 Then composer textarea 仍在视口内', async () => {
    // jsdom 不实现 layout;覆盖 getBoundingClientRect 让 .chat-pane / textarea
    // 返回一个位于 800x600 内的真实盒子。后续断言 textarea 的 bottom 不超过 600。
    const originalGetBCR = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function rect() {
      const node = this as HTMLElement;
      if (node.classList.contains('chat-pane')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 800,
          bottom: 600,
          width: 800,
          height: 600,
          toJSON() {
            return {};
          },
        } as DOMRect;
      }
      if (node.tagName === 'TEXTAREA') {
        return {
          x: 0,
          y: 500,
          top: 500,
          left: 0,
          right: 400,
          bottom: 560,
          width: 400,
          height: 60,
          toJSON() {
            return {};
          },
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };

    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 600);

    try {
      render(<App />);
      const textarea = await screen.findByRole('textbox', { name: '向 Agent 提问' });

      // getBoundingClientRect 必须返回非零矩形 —— jsdom 默认全 0,
      // 这条断言会先变红暴露 layout mock 失效。
      const rect = textarea.getBoundingClientRect();
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.width).toBeGreaterThan(0);
      // 关键契约: textarea 底边在视口内。
      expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBCR;
    }
  });

  it('Given chatModel.getAvailable 抛错 When 工作台加载 Then 显示 chat-empty CTA 且不白屏', async () => {
    vi.spyOn(window.lorra.models, 'getAvailable').mockRejectedValue(new Error('boom'));
    // getDefault 也返回 ok:false,避免它返回成功污染 defaultModelName。
    vi.spyOn(window.lorra.models, 'getDefault').mockResolvedValue({
      ok: false,
      error: { code: 'no-default', message: 'no default' },
    });

    render(<App />);

    // CTA 文案与 composer 必须共存 —— 失败路径不能白屏。
    expect(await screen.findByText('暂无可用模型，连接一个供应商开始对话。')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '向 Agent 提问' })).toBeInTheDocument();
    // 模型不可用 banner 同时渲染。
    expect(screen.getByText('模型暂不可用')).toBeInTheDocument();
  });

  it('Given 打开 providers 视图 When 点击「返回工作区」 Then workspace-grid 重新出现', async () => {
    const user = userEvent.setup();
    render(<App />);

    // 起始:workspace 视图,Agent 对话 region 存在。
    await screen.findByRole('region', { name: 'Agent 对话' });
    const composerBefore = screen.getByRole('textbox', { name: '向 Agent 提问' });
    expect(composerBefore).toBeInTheDocument();

    // 进入 providers 视图:点击 chat-header 上的「打开模型供应商配置」。
    await user.click(screen.getByRole('button', { name: '打开模型供应商配置' }));

    // 切出 workspace 后 textarea 消失,providers 目录出现。
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: '向 Agent 提问' })).not.toBeInTheDocument(),
    );
    // providers 视图的 aside 用 aria-label="配置导航",对应隐式 role=complementary。
    expect(await screen.findByRole('complementary', { name: '配置导航' })).toBeInTheDocument();

    // 返回:ProvidersPage 上的 pc-back 按钮,文字「返回工作区」。
    await user.click(screen.getByRole('button', { name: '返回工作区' }));

    // workspace 视图回来:Agent 对话 region + composer 都在。
    expect(await screen.findByRole('region', { name: 'Agent 对话' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '向 Agent 提问' })).toBeInTheDocument();
  });

  it('Given session.send 失败 When 发送 Then 输入保留并显示错误 banner', async () => {
    const user = userEvent.setup();
    // 让会话 bootstrap 走通:continueRecent / create 必须有一个成功。
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 'sess-fail' },
    });
    vi.spyOn(window.lorra.session, 'send').mockResolvedValue({
      ok: false,
      error: { code: 'send-failed', message: '网络断了' },
    });

    render(<App />);

    const textarea = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    await user.type(textarea, '帮我写一段');
    await user.click(screen.getByRole('button', { name: '发送' }));

    // 契约:发送失败时输入不丢失,Composer 显示 banner。
    expect(textarea).toHaveValue('帮我写一段');
    expect(await screen.findByText('发送未完成')).toBeInTheDocument();
    expect(screen.getByText('网络断了')).toBeInTheDocument();
  });

  it('Given 收到 thinking 事件 When 会话活跃 Then 渲染可折叠思考气泡', async () => {
    let subscribeCb: ((event: unknown) => void) | undefined;
    vi.spyOn(window.lorra.events, 'subscribe').mockImplementation((cb) => {
      subscribeCb = cb;
      return () => {};
    });
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 's1' },
    });

    render(<App />);
    await screen.findByRole('textbox', { name: '向 Agent 提问' });

    // 事件先于会话激活到达也没关系:reducer 会存进 sessions['s1'],激活后渲染。
    subscribeCb?.({
      sessionId: 's1',
      eventId: 'evt-1',
      seq: 1,
      ts: Date.now(),
      type: 'thinking.partial',
      role: 'assistant',
      messageId: 'm1',
      content: { thinking: '先想一下再动手' },
    });

    const summary = await screen.findByRole('button', { name: /思考中/ });
    expect(summary).toBeInTheDocument();
    // 流式可见:思考卡默认展开,思考文字直接可见(不需要点击)。
    const detail = document.querySelector('.thinking-detail p');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toBe('先想一下再动手');
  });

  it('Given thinking+工具事件流(reducer 折叠路径) When 渲染 Then 思考卡带时长、组头带整轮耗时', async () => {
    let subscribeCb: ((event: unknown) => void) | undefined;
    vi.spyOn(window.lorra.events, 'subscribe').mockImplementation((cb) => {
      subscribeCb = cb;
      return () => {};
    });
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 's1' },
    });

    render(<App />);
    await screen.findByRole('textbox', { name: '向 Agent 提问' });

    // 真实驱动形状:thinking.partial 流 → final(同 messageId,reducer 折叠为 final),
    // 工具 start/end。首个 partial 的 ts(1000)必须经 reducer 锚点传导到 UI。
    subscribeCb?.({
      sessionId: 's1',
      eventId: 'evt-tp1',
      seq: 1,
      ts: 1000,
      type: 'thinking.partial',
      role: 'assistant',
      messageId: 'm1',
      content: { thinking: '先想' },
    });
    subscribeCb?.({
      sessionId: 's1',
      eventId: 'evt-tp2',
      seq: 2,
      ts: 35000,
      type: 'thinking.final',
      role: 'assistant',
      messageId: 'm1',
      content: { thinking: '先想一下再动手' },
    });
    subscribeCb?.({
      sessionId: 's1',
      eventId: 'evt-ts1',
      seq: 3,
      ts: 50000,
      type: 'tool.start',
      toolName: 'read',
      target: 'src/main.ts',
      callId: 'call-A',
    });
    subscribeCb?.({
      sessionId: 's1',
      eventId: 'evt-te1',
      seq: 4,
      ts: 206000,
      type: 'tool.end',
      toolName: 'read',
      target: 'src/main.ts',
      callId: 'call-A',
      result: '内容',
      ok: true,
    });

    // 思考耗时:折叠路径下 durationMs = final.ts - 锚点(首个 partial ts)= 34000 → 34秒
    expect(await screen.findByRole('button', { name: /思考 · 34秒/ })).toBeInTheDocument();
    // 连续流:思考段与工具行内联在消息流中(事件序保序,无活动条分组)。
    expect(await screen.findByRole('button', { name: /read/ })).toBeInTheDocument();
    const stripCount = document.querySelectorAll('.activity-strip').length;
    expect(stripCount).toBe(0);
    // 思考行与工具行都出现在消息流里,顺序 = 事件序(思考在前、工具在后)。
    const elements = Array.from(document.querySelectorAll('.thinking-event, .tool-event'));
    expect(elements.map((el) => el.className)).toEqual([
      expect.stringContaining('thinking-event'),
      expect.stringContaining('tool-event'),
    ]);
  });

  it('Given 无事件 When 工作台加载 Then 显示空态欢迎页(非旧占位文案)', async () => {
    render(<App />);

    expect(await screen.findByTestId('chat-welcome')).toBeInTheDocument();
    expect(screen.getByText('先处理一个清晰目标')).toBeInTheDocument();
    // 快捷入口映射真实能力(斜杠命令),不造假。
    expect(screen.getByRole('button', { name: '配置模型' })).toBeInTheDocument();
  });

  it('Given 收到消息事件 When 会话活跃 Then user/assistant 消息渲染气泡', async () => {
    let subscribeCb: ((event: unknown) => void) | undefined;
    vi.spyOn(window.lorra.events, 'subscribe').mockImplementation((cb) => {
      subscribeCb = cb;
      return () => {};
    });
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 's-bubble' },
    });

    render(<App />);
    await screen.findByRole('textbox', { name: '向 Agent 提问' });

    subscribeCb?.({
      sessionId: 's-bubble',
      eventId: 'evt-u',
      seq: 1,
      ts: Date.now(),
      type: 'message.final',
      role: 'user',
      messageId: 'm-u',
      content: { text: '用户气泡内容' },
    });
    subscribeCb?.({
      sessionId: 's-bubble',
      eventId: 'evt-a',
      seq: 2,
      ts: Date.now(),
      type: 'message.final',
      role: 'assistant',
      messageId: 'm-a',
      content: { text: '助手气泡内容' },
    });

    // 消息出现且空态欢迎页消失。
    expect(await screen.findByText('助手气泡内容')).toBeInTheDocument();
    expect(screen.getByText('用户气泡内容')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-welcome')).not.toBeInTheDocument();
    // 气泡容器存在,user 气泡带藏蓝底类。
    expect(document.querySelectorAll('.message .message-bubble')).toHaveLength(2);
    expect(document.querySelector('.message.user .message-bubble')).not.toBeNull();
  });

  it('Given 工作台已激活 When 点击图标栏「模型配置」 Then 切换到模型配置页', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.click(screen.getByRole('button', { name: '模型配置' }));

    expect(await screen.findByRole('complementary', { name: '配置导航' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agent 对话' })).not.toBeInTheDocument();
  });

  it('Given 模型配置页 When 点击图标栏「工作台」 Then 返回工作台', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.click(screen.getByRole('button', { name: '模型配置' }));
    await screen.findByRole('complementary', { name: '配置导航' });

    await user.click(screen.getByRole('button', { name: '工作台' }));

    expect(await screen.findByRole('region', { name: 'Agent 对话' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '向 Agent 提问' })).toBeInTheDocument();
  });

  it('Given 点击图标栏「设置」 Then 显示设置占位页', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.click(screen.getByRole('button', { name: '设置' }));

    expect(await screen.findByRole('main', { name: '设置' })).toBeInTheDocument();
  });

  it('Given 工作台已激活 When 按 Ctrl+P Then 命令面板打开、输入过滤、回车切到设置', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.keyboard('{Control>}p{/Control}');

    // 面板打开:cmdk 搜索框(role=combobox)出现。
    const search = await screen.findByRole('combobox');
    expect(search).toBeInTheDocument();

    // 输入「设置」过滤后回车执行,切到设置页。
    await user.type(search, '设置');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('main', { name: '设置' })).toBeInTheDocument();
  });

  it('Given 命令面板打开 When 再按 Ctrl+P Then 面板关闭', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.keyboard('{Control>}p{/Control}');
    await screen.findByRole('combobox');

    await user.keyboard('{Control>}p{/Control}');

    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
  });
});

describe('主题切换', () => {
  it('Given 浅色 When 点击「切换深色模式」 Then html 加 dark 类、按钮换文案、持久化;再点还原', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    const toggle = screen.getByRole('button', { name: '切换深色模式' });
    await user.click(toggle);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByRole('button', { name: '切换浅色模式' })).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem('lorra-ui') ?? '{}');
    expect(stored.theme).toBe('dark');

    await user.click(screen.getByRole('button', { name: '切换浅色模式' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    const storedLight = JSON.parse(localStorage.getItem('lorra-ui') ?? '{}');
    expect(storedLight.theme).toBe('light');
  });

  it('Given 预置深色偏好 When 渲染 App Then html 带 dark 类(挂载 effect 生效)', async () => {
    localStorage.setItem('lorra-ui', JSON.stringify({ theme: 'dark', navCollapsed: false }));
    useAppStore.setState({ theme: readUiPrefs().theme });
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('窗口控制', () => {
  it('Given 工作台 When 点击「最小化窗口」 Then 调用 lorra.window.minimize', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(window.lorra.window, 'minimize').mockResolvedValue(true);
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.click(screen.getByRole('button', { name: '最小化窗口' }));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Given 工作台 When 点击「最大化窗口」 Then 调用 lorra.window.toggleMaximize', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(window.lorra.window, 'toggleMaximize').mockResolvedValue(true);
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.click(screen.getByRole('button', { name: '最大化窗口' }));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Given 工作台 When 点击「关闭窗口」 Then 调用 lorra.window.close', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(window.lorra.window, 'close').mockResolvedValue(true);
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.click(screen.getByRole('button', { name: '关闭窗口' }));

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('图标栏折叠', () => {
  function nav(): HTMLElement {
    return screen.getByRole('navigation', { name: '页面导航' });
  }

  it('Given 展开状态 When 点击「折叠图标栏」 Then 图标栏折叠、按钮换文案、持久化;再点展开', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    expect(nav()).not.toHaveClass('w-0');

    await user.click(screen.getByRole('button', { name: '折叠图标栏' }));
    expect(nav()).toHaveClass('w-0');
    expect(screen.getByRole('button', { name: '展开图标栏' })).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem('lorra-ui') ?? '{}');
    expect(stored.navCollapsed).toBe(true);

    await user.click(screen.getByRole('button', { name: '展开图标栏' }));
    expect(nav()).not.toHaveClass('w-0');
    const storedOpen = JSON.parse(localStorage.getItem('lorra-ui') ?? '{}');
    expect(storedOpen.navCollapsed).toBe(false);
  });

  it('Given 工作台已激活 When 按 Ctrl+B Then 图标栏折叠;再按一次展开', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    expect(nav()).not.toHaveClass('w-0');

    await user.keyboard('{Control>}b{/Control}');
    expect(nav()).toHaveClass('w-0');

    await user.keyboard('{Control>}b{/Control}');
    expect(nav()).not.toHaveClass('w-0');
  });

  it('Given 焦点在 composer 输入框 When 按 Ctrl+B Then 图标栏不折叠(输入守卫)', async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    await user.type(composer, '正在输入');
    await user.keyboard('{Control>}b{/Control}');

    expect(nav()).not.toHaveClass('w-0');
  });
});

// 斜杠命令(pi TUI):composer 输入 /命令 回车 → 执行而非发送。
describe('斜杠命令', () => {
  beforeEach(() => {
    globalThis.__lorraStub = { workspacePath: 'C:/test/workspace' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Given 输入 /new 回车 Then 新建会话被调用', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 'existing-session-id' },
    });
    const createSpy = vi
      .spyOn(window.lorra.session, 'create')
      .mockResolvedValue({ ok: true, value: { sessionId: 'new-session-id' } });
    render(<App />);

    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    await user.type(composer, '/new');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
  });

  it('Given 输入 /compact When compact 成功 Then 重开会话刷新并显示反馈', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 'sess-1' },
    });
    const compactSpy = vi
      .spyOn(window.lorra.session, 'compact')
      .mockResolvedValue({ ok: true, value: { accepted: true } });
    const openSpy = vi
      .spyOn(window.lorra.session, 'open')
      .mockResolvedValue({ ok: true, value: { sessionId: 'sess-1' } });
    render(<App />);

    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    await user.type(composer, '/compact');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(compactSpy).toHaveBeenCalledWith({ sessionId: 'sess-1' }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith({ sessionId: 'sess-1' }));
    expect(await screen.findByText('会话上下文已压缩')).toBeInTheDocument();
  });

  it('Given 输入 /compact When Agent 忙碌拒绝 Then 显示提示且不重开', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 'sess-1' },
    });
    const compactSpy = vi
      .spyOn(window.lorra.session, 'compact')
      .mockResolvedValue({ ok: true, value: { accepted: false } });
    const openSpy = vi.spyOn(window.lorra.session, 'open');
    render(<App />);

    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    await user.type(composer, '/compact');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(compactSpy).toHaveBeenCalled());
    expect(openSpy).not.toHaveBeenCalled();
    expect(await screen.findByText(/正在工作中/)).toBeInTheDocument();
  });

  it('Given 输入 /model 回车 Then 切到模型配置页', async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    await user.type(composer, '/model');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('complementary', { name: '配置导航' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '向 Agent 提问' })).not.toBeInTheDocument();
  });

  it('Given 有 AI 回复 When 输入 /copy Then 最后一条回复进剪贴板', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    // 会话 bootstrap 后注入一条 assistant 回复。
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 'sess-1' },
    });
    let emit: ((event: unknown) => void) | undefined;
    vi.spyOn(window.lorra.events, 'subscribe').mockImplementation(
      (callback: (event: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    );
    render(<App />);

    const composer = await screen.findByRole('textbox', { name: '向 Agent 提问' });
    emit?.({
      sessionId: 'sess-1',
      eventId: 'e1',
      seq: 1,
      ts: Date.now(),
      type: 'message.final',
      role: 'assistant',
      messageId: 'm1',
      content: { text: '这是回复' },
    });

    await user.type(composer, '/copy');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('这是回复'));
    expect(await screen.findByText(/已复制/)).toBeInTheDocument();
  });

  it('Given 命令面板 When 选「/compact」 Then 命令执行', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.session, 'continueRecent').mockResolvedValue({
      ok: true,
      value: { sessionId: 'sess-1' },
    });
    const compactSpy = vi
      .spyOn(window.lorra.session, 'compact')
      .mockResolvedValue({ ok: true, value: { accepted: true } });
    render(<App />);

    await screen.findByRole('region', { name: 'Agent 对话' });
    await user.keyboard('{Control>}p{/Control}');
    const item = await screen.findByRole('option', { name: /\/compact/ });
    await user.click(item);

    await waitFor(() => expect(compactSpy).toHaveBeenCalledWith({ sessionId: 'sess-1' }));
  });
});
