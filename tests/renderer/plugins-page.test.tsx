import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/lib/app-store';
import { PluginsPage } from '../../src/renderer/plugins-page';
import { installLorraMock, type LorraMock } from './lorra-test-helpers';

// 插件页(plan S5):Segmented Control 三态 + MCP/Plugins 高密度列表 + 导入/新建。

let mock: LorraMock;

function okXray(plugins: unknown[] = [], mcps: unknown[] = []) {
  return { ok: true as const, value: { plugins, mcps, root: '/root', workspacePath: '/ws' } };
}

describe('plugins-page', () => {
  beforeEach(() => {
    mock = installLorraMock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ page: 'workspace' });
  });

  it('渲染 Segmented Control 三态，默认 Skills 态', async () => {
    render(<PluginsPage />);
    const tabs = screen.getAllByTestId('plugins-tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent('技能');
    expect(tabs[1]).toHaveTextContent('MCP');
    expect(tabs[2]).toHaveTextContent('插件');
    // 默认 Skills 态 → SkillsPage 内部根存在。
    await waitFor(() => expect(screen.getByTestId('skills-page')).toBeInTheDocument());
    // 2026-08-15:外壳与内嵌 Skills 态均不再渲染返回钮,导航由左侧栏承担。
    expect(screen.queryByRole('button', { name: '返回工作台' })).toBeNull();
  });

  it('切到 MCP 态显示 MCP 列表与状态徽章', async () => {
    mock.agentPlugins.xray.mockResolvedValue(okXray([], [{ id: 'svc1', type: 'stdio', origin: 'plugin', pluginName: 'p1', config: { type: 'stdio', command: 'x' }, enabled: true, health: 'unverified', issues: [] }]));
    render(<PluginsPage />);
    await userEvent.click(screen.getAllByTestId('plugins-tab')[1]);
    await waitFor(() => expect(screen.getByTestId('plugins-mcp-table')).toBeInTheDocument());
    expect(screen.getByTestId('plugins-mcp-row')).toHaveTextContent('svc1');
    expect(screen.getByTestId('plugins-mcp-row')).toHaveTextContent('stdio');
  });

  it('MCP 空态文案', async () => {
    mock.agentPlugins.xray.mockResolvedValue(okXray([], []));
    render(<PluginsPage />);
    await userEvent.click(screen.getAllByTestId('plugins-tab')[1]);
    await waitFor(() => expect(screen.getByText('还没有 MCP 服务器')).toBeInTheDocument());
  });

  it('切到 Plugins 态显示插件列表 + 导入/新建按钮', async () => {
    mock.agentPlugins.xray.mockResolvedValue(okXray([{ name: 'hello', path: '/hello', skillCount: 1, mcpCount: 0, enabled: true, issues: [] }], []));
    render(<PluginsPage />);
    await userEvent.click(screen.getAllByTestId('plugins-tab')[2]);
    await waitFor(() => expect(screen.getByTestId('plugins-plugin-table')).toBeInTheDocument());
    expect(screen.getByTestId('plugins-plugin-row')).toHaveTextContent('hello');
    expect(screen.getByTestId('plugins-import')).toBeInTheDocument();
    expect(screen.getByTestId('plugins-create')).toBeInTheDocument();
  });

  it('导入弹层：输入路径 → 确认走 importFolder IPC', async () => {
    mock.agentPlugins.xray.mockResolvedValue(okXray([], []));
    render(<PluginsPage />);
    await userEvent.click(screen.getAllByTestId('plugins-tab')[2]);
    await waitFor(() => expect(screen.getByTestId('plugins-import')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('plugins-import'));
    await userEvent.type(screen.getByTestId('plugins-import-source'), '/some/plugin');
    await userEvent.click(screen.getByTestId('plugins-import-confirm'));
    await waitFor(() => expect(mock.agentPlugins.importFolder).toHaveBeenCalledWith('/some/plugin'));
  });

  it('新建弹层：输入名 → 确认走 create IPC', async () => {
    mock.agentPlugins.xray.mockResolvedValue(okXray([], []));
    render(<PluginsPage />);
    await userEvent.click(screen.getAllByTestId('plugins-tab')[2]);
    await waitFor(() => expect(screen.getByTestId('plugins-create')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('plugins-create'));
    await userEvent.type(screen.getByTestId('plugins-create-name'), 'my-plugin');
    await userEvent.click(screen.getByTestId('plugins-create-confirm'));
    await waitFor(() => expect(mock.agentPlugins.create).toHaveBeenCalledWith('my-plugin'));
  });
});

