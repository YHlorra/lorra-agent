/**
 * 设置页黑盒测试(/ PRD 设置节):分组导航、主题/折叠/语言开关、
 * 隐藏文件开关、最近工作区移除、关于组、settings.get 失败退化。
 * 断言用中文字面量(默认 zh 环境),与 t 词条一致。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { useAppStore } from '../../src/renderer/lib/app-store';
import { SettingsPage } from '../../src/renderer/settings-page';

beforeEach(() => {
  useAppStore.setState({
    page: 'workspace',
    theme: 'light',
    navCollapsed: false,
    language: 'zh',
    showHiddenFiles: false,
    defaultHideThinking: false,
  });
  globalThis.__lorraStub = { workspacePath: 'C:/ws/active' };
});

afterEach(() => {
  cleanup();
  globalThis.__lorraStub = undefined;
  vi.restoreAllMocks();
});

describe('设置页:分组导航', () => {
  it('渲染三组导航(外观/工作区/关于),默认展示外观组', () => {
    render(<SettingsPage />);

    expect(screen.getByRole('button', { name: '外观' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '工作区' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关于' })).toBeInTheDocument();

    // 默认外观组:主题行可见,工作区内容不可见。
    expect(screen.getByText('主题')).toBeInTheDocument();
    expect(screen.queryByText('最近工作区')).not.toBeInTheDocument();
  });

  it('点击「工作区」导航切换右面板内容', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(screen.getByRole('button', { name: '工作区' }));

    expect(screen.getByText('最近工作区')).toBeInTheDocument();
    expect(screen.queryByText('主题')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '关于' }));
    expect(screen.getByText('版本')).toBeInTheDocument();
    expect(screen.queryByText('最近工作区')).not.toBeInTheDocument();
  });
});

describe('设置页:外观组', () => {
  it('主题行点击「深色」:settings.set 不被调用,html.dark class 翻转(主题走 store)', async () => {
    const user = userEvent.setup();
    const settingsSet = vi.spyOn(window.lorra.settings, 'set');
    useAppStore.setState({ page: 'settings' });
    render(<App />);

    // App 挂载完成(设置页出现)。
    const darkChoice = await screen.findByRole('radio', { name: '深色' });
    // 挂载时 settings.get 读真源会经 store 回写一次同值(设计如此);清掉基线,
    // 断言「主题切换不走 settings IPC」。
    settingsSet.mockClear();
    await user.click(darkChoice);

    expect(useAppStore.getState().theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(settingsSet).not.toHaveBeenCalled();
  });

  it('语言行点「English」:settings.set 以 {language:"en"} 被调,页面文案变英文', async () => {
    const user = userEvent.setup();
    const settingsSet = vi.spyOn(window.lorra.settings, 'set');
    render(<SettingsPage />);

    await user.click(screen.getByRole('radio', { name: 'English' }));

    expect(settingsSet).toHaveBeenCalledWith({ language: 'en' });
    expect(useAppStore.getState().language).toBe('en');
    // 全页文案即时切换:导航与行标题变英文。
    expect(await screen.findByRole('button', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.queryByText('主题')).not.toBeInTheDocument();

    // 切回中文。
    await user.click(screen.getByRole('radio', { name: '中文' }));
    expect(settingsSet).toHaveBeenLastCalledWith({ language: 'zh' });
    expect(screen.getByText('主题')).toBeInTheDocument();
  });

  it('折叠图标栏开关:点击翻转 store 且持久化到 localStorage', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    const toggle = screen.getByRole('switch', { name: '折叠图标栏' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);

    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(useAppStore.getState().navCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem('lorra-ui') ?? '{}').navCollapsed).toBe(true);
  });

  it('默认隐藏思考链开关:点击调 settings.set({defaultHideThinking}) 且 store 翻转', async () => {
    const user = userEvent.setup();
    const settingsSet = vi.spyOn(window.lorra.settings, 'set');
    render(<SettingsPage />);

    const toggle = screen.getByRole('switch', { name: '默认隐藏思考链' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);

    expect(settingsSet).toHaveBeenCalledWith({ defaultHideThinking: true });
    expect(useAppStore.getState().defaultHideThinking).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

describe('设置页:工作区组', () => {
  it('隐藏文件开关:点击调 settings.set({showHiddenFiles})', async () => {
    const user = userEvent.setup();
    const settingsSet = vi.spyOn(window.lorra.settings, 'set');
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '工作区' }));

    const toggle = screen.getByRole('switch', { name: '显示隐藏文件' });
    await user.click(toggle);

    expect(settingsSet).toHaveBeenCalledWith({ showHiddenFiles: true });
    expect(useAppStore.getState().showHiddenFiles).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('最近工作区:渲染路径 basename,激活项(首项)无移除按钮,其余项点「移除」调 workspace.remove 并刷新列表', async () => {
    const user = userEvent.setup();
    const listSpy = vi
      .spyOn(window.lorra.workspace, 'list')
      .mockResolvedValue({ workspaces: ['C:/ws/active', 'C:/ws/old'] });
    const removeSpy = vi
      .spyOn(window.lorra.workspace, 'remove')
      .mockResolvedValue({ workspaces: ['C:/ws/active'] });
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '工作区' }));

    expect(listSpy).toHaveBeenCalled();
    // 激活项:basename + 「当前」徽标,无移除按钮。
    expect(await screen.findByText('active')).toBeInTheDocument();
    expect(screen.getByText('当前')).toBeInTheDocument();
    expect(screen.getByText('old')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '移除' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '移除' }));
    expect(removeSpy).toHaveBeenCalledWith('C:/ws/old');
    // 用 remove 返回值刷新列表:old 消失,当前仍在。
    expect(await screen.findByText('active')).toBeInTheDocument();
    expect(screen.queryByText('old')).not.toBeInTheDocument();
  });

  it('移除失败:保留列表并内联错误文案', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.workspace, 'list').mockResolvedValue({
      workspaces: ['C:/ws/active', 'C:/ws/old'],
    });
    vi.spyOn(window.lorra.workspace, 'remove').mockRejectedValue(new Error('boom'));
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '工作区' }));
    await screen.findByText('old');

    await user.click(screen.getByRole('button', { name: '移除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('移除「old」失败，请重试');
    // 列表保留。
    expect(screen.getByText('old')).toBeInTheDocument();
  });
});

describe('设置页:关于组', () => {
  it('显示 app.info 返回的版本号', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.app, 'info').mockResolvedValue({ version: '2.0.0', name: 'lorra' });
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '关于' }));

    expect(await screen.findByText('2.0.0')).toBeInTheDocument();
    expect(screen.getByText('版本')).toBeInTheDocument();
    // 快捷键只读清单来自 SHORTCUTS 常量。
    expect(screen.getByText('快捷键')).toBeInTheDocument();
  });
});

describe('设置页:退化路径', () => {
  it('settings.get 返回失败:页面用默认值渲染,不白屏', async () => {
    vi.spyOn(window.lorra.settings, 'get').mockResolvedValue({
      ok: false,
      error: { code: 'settings-error', message: 'boom' },
    });
    render(<SettingsPage />);

    // 默认 zh + 浅色 + 未折叠:外观组完整渲染。
    expect(screen.getByRole('button', { name: '外观' })).toBeInTheDocument();
    expect(screen.getByText('主题')).toBeInTheDocument();
    const lightChoice = screen.getByRole('radio', { name: '浅色' });
    expect(lightChoice.getAttribute('aria-checked')).toBe('true');
  });
});

describe('设置页:数据源组（）', () => {
  it('导航含「数据源」;点击后渲染四个开关 + 插件空态', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
    });
    render(<SettingsPage />);

    await user.click(screen.getByRole('button', { name: '数据源' }));

    expect(screen.getByRole('switch', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'OpenCode' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Oh My Pi' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Workbuddy' })).toBeInTheDocument();
    // 插件空态
    expect(screen.getByText(/暂无自定义插件/)).toBeInTheDocument();
  });

  it('挂载水合:settings.get 返回已启用源 → 开关回显 checked(重启后不丢)', async () => {
    const user = userEvent.setup();
    const settingsSet = vi.spyOn(window.lorra.settings, 'set');
    vi.spyOn(window.lorra.settings, 'get').mockResolvedValue({
      ok: true,
      value: {
        showHiddenFiles: false,
        language: 'zh',
        defaultHideThinking: false,
        compileModel: null,
        dataSources: { claudeCode: false, opencode: false, ohMyPi: true, workbuddy: false },
        tags: ['工作', '写作'],
      },
    });
    // 预置 store 为全关(模拟刚启动未水合)
    useAppStore.setState({
      dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
    });
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '数据源' }));

    const ohMyPi = screen.getByRole('switch', { name: 'Oh My Pi' });
    await waitFor(() => expect(ohMyPi.getAttribute('aria-checked')).toBe('true'));
    // 未启用的源保持 off
    expect(
      screen.getByRole('switch', { name: 'Claude Code' }).getAttribute('aria-checked'),
    ).toBe('false');
    // 水合不触发任何 settings.set 写回(纯读取)
    expect(window.lorra.settings.set).not.toHaveBeenCalled();
  });

  it('开关切换 → settings.set 收到 { dataSources: { claudeCode: true } },store 翻转', async () => {
    const user = userEvent.setup();
    const settingsSet = vi.spyOn(window.lorra.settings, 'set');
    useAppStore.setState({
      dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
    });
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '数据源' }));

    await user.click(screen.getByRole('switch', { name: 'Claude Code' }));

    expect(settingsSet).toHaveBeenCalledWith({ dataSources: { claudeCode: true } });
    expect(useAppStore.getState().dataSources.claudeCode).toBe(true);
    expect(useAppStore.getState().dataSources.opencode).toBe(false);
  });

  it('插件清单:status error 的插件显示错误文案', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.plugins, 'list').mockResolvedValue({
      ok: true,
      value: {
        plugins: [
          { name: 'bad', runtime: 'r', description: '坏插件', status: 'error', error: 'plugin.json 读取失败' },
        ],
      },
    });
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '数据源' }));

    expect(await screen.findByText('坏插件')).toBeInTheDocument();
    expect(await screen.findByText(/plugin\.json 读取失败/)).toBeInTheDocument();
  });
});

describe('设置页:开源项目页', () => {
  const LICENSE_FIXTURES = [
    {
      name: 'react',
      version: '19.2.8',
      license: 'MIT',
      homepage: 'https://react.dev/',
      repository: 'https://github.com/react/react',
    },
    {
      name: 'mermaid',
      version: '11.16.1',
      license: 'Apache-2.0',
      homepage: 'https://mermaid.js.org/',
      repository: 'https://github.com/mermaid-js/mermaid',
    },
  ];

  /** 打开关于组 → 点「查看」进入开源项目页。 */
  async function openLicensesPage(user: ReturnType<typeof userEvent.setup>) {
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '关于' }));
    await user.click(screen.getByRole('button', { name: '查看' }));
  }

  it('关于组含「开源项目」入口;进入后渲染列表与仓库/包链接', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.app, 'licenses').mockResolvedValue(LICENSE_FIXTURES);
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '关于' }));

    // 入口行:标题 + 描述 + 查看按钮
    expect(screen.getByText('开源项目')).toBeInTheDocument();
    expect(screen.getByText('lorra 使用的开源软件与许可协议')).toBeInTheDocument();
    const viewButton = screen.getByRole('button', { name: '查看' });
    await user.click(viewButton);

    // 列表渲染两个项目:名称 + 版本·协议 + 双链接
    expect(await screen.findByText('react')).toBeInTheDocument();
    expect(screen.getByText('mermaid')).toBeInTheDocument();
    expect(screen.getByText('MIT')).toBeInTheDocument();
    expect(screen.getByText('Apache-2.0')).toBeInTheDocument();

    const repoLinks = screen.getAllByRole('link', { name: '仓库' });
    const reactRepo = repoLinks.find((l) => l.getAttribute('href') === 'https://github.com/react/react');
    expect(reactRepo).toBeDefined();
    const pkgLinks = screen.getAllByRole('link', { name: '包地址' });
    const reactPkg = pkgLinks.find((l) => l.getAttribute('href') === 'https://www.npmjs.com/package/react');
    expect(reactPkg).toBeDefined();
    expect(reactPkg).toHaveAttribute('target', '_blank');
  });

  it('搜索过滤:输入「react」只剩 react 行;无匹配显示空态', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.app, 'licenses').mockResolvedValue(LICENSE_FIXTURES);
    await openLicensesPage(user);
    await screen.findByText('react');

    await user.type(screen.getByRole('searchbox', { name: '搜索开源项目' }), 'react');

    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.queryByText('mermaid')).not.toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: '搜索开源项目' }));
    await user.type(screen.getByRole('searchbox', { name: '搜索开源项目' }), 'zzz');

    expect(screen.getByText('未找到匹配的项目')).toBeInTheDocument();
  });

  it('点击「返回」回到关于组:版本行可见,列表消失', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.app, 'licenses').mockResolvedValue(LICENSE_FIXTURES);
    await openLicensesPage(user);
    await screen.findByText('react');

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(screen.getByText('版本')).toBeInTheDocument();
    expect(screen.queryByText('react')).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: '搜索开源项目' })).not.toBeInTheDocument();
  });

  it('app.licenses 失败:显示「加载失败」错误态(role=alert),不崩溃', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.app, 'licenses').mockRejectedValue(new Error('boom'));
    await openLicensesPage(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('加载失败');
    expect(screen.getByText('加载失败')).toBeInTheDocument();
  });
});

describe('设置页:标签组(2026-08-14 今日页标签管理)', () => {
  it('导航含「标签」;点击后渲染 chip 列表(settings.get 真源)', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.lorra.settings, 'get').mockResolvedValue({
      ok: true,
      value: {
        showHiddenFiles: false,
        language: 'zh',
        defaultHideThinking: false,
        compileModel: null,
        dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
        tags: ['工作', '写作'],
      },
    });
    render(<SettingsPage />);

    expect(screen.getByRole('button', { name: '标签' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '标签' }));

    expect(await screen.findByTestId('settings-tags')).toBeInTheDocument();
    expect(screen.getAllByTestId('tag-chip')).toHaveLength(2);
    expect(screen.getByTestId('tag-input')).toBeInTheDocument();
    expect(screen.getByTestId('tag-add')).toBeInTheDocument();
  });

  it('添加标签:输入 + 点击添加 → settings.set({tags}) + chip 出现;trim 空/重复忽略', async () => {
    const user = userEvent.setup();
    const settingsSet = vi.spyOn(window.lorra.settings, 'set');
    vi.spyOn(window.lorra.settings, 'get').mockResolvedValue({
      ok: true,
      value: {
        showHiddenFiles: false,
        language: 'zh',
        defaultHideThinking: false,
        compileModel: null,
        dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
        tags: ['工作'],
      },
    });
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '标签' }));
    await screen.findByTestId('settings-tags');

    await user.type(screen.getByTestId('tag-input'), ' 写作 ');
    await user.click(screen.getByTestId('tag-add'));
    expect(settingsSet).toHaveBeenCalledWith({ tags: ['工作', '写作'] });
    expect(await screen.findByText('写作')).toBeInTheDocument();

    // 重复添加 → 忽略(不触发 set)
    settingsSet.mockClear();
    await user.type(screen.getByTestId('tag-input'), '工作');
    await user.click(screen.getByTestId('tag-add'));
    expect(settingsSet).not.toHaveBeenCalled();

    // 空输入 → 忽略
    settingsSet.mockClear();
    await user.type(screen.getByTestId('tag-input'), '   ');
    await user.click(screen.getByTestId('tag-add'));
    expect(settingsSet).not.toHaveBeenCalled();
  });

  it('删除标签:chip × → settings.set({tags}) 且 chip 消失', async () => {
    const user = userEvent.setup();
    const settingsSet = vi.spyOn(window.lorra.settings, 'set');
    vi.spyOn(window.lorra.settings, 'get').mockResolvedValue({
      ok: true,
      value: {
        showHiddenFiles: false,
        language: 'zh',
        defaultHideThinking: false,
        compileModel: null,
        dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
        tags: ['工作', '写作'],
      },
    });
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: '标签' }));
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByRole('button', { name: '删除标签「写作」' }));
    expect(settingsSet).toHaveBeenCalledWith({ tags: ['工作'] });
    expect(screen.queryByText('写作')).not.toBeInTheDocument();
    expect(screen.getByText('工作')).toBeInTheDocument();
  });
});
