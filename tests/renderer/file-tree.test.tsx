import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTree } from '../../src/renderer/file-tree';

type TreeNode = { id: string; name: string; type: 'file' | 'dir'; hasChildren: boolean };

const FIXTURE: TreeNode[] = [
  { id: 'd-git', name: '.git', type: 'dir', hasChildren: true },
  { id: 'd-pi', name: '.pi', type: 'dir', hasChildren: true },
  { id: 'f-env', name: '.env', type: 'file', hasChildren: false },
  { id: 'd-src', name: 'src', type: 'dir', hasChildren: true },
  { id: 'f-readme', name: 'README.md', type: 'file', hasChildren: false },
];

const CHILDREN: Record<string, TreeNode[]> = {
  'd-src': [
    { id: 'f-a', name: 'a.ts', type: 'file', hasChildren: false },
    { id: 'f-hidden', name: '.hidden.ts', type: 'file', hasChildren: false },
  ],
  'd-git': [{ id: 'f-config', name: 'config', type: 'file', hasChildren: false }],
};

// 挂载时 window.lorra.fs.tree 被调用:根目录返回 FIXTURE,展开返回 CHILDREN。
const treeMock = vi.fn(async (args: { directoryId: string }) => {
  if (args.directoryId === 'ws-root') return { ok: true, value: FIXTURE };
  return { ok: true, value: CHILDREN[args.directoryId] ?? [] };
});

beforeEach(() => {
  Object.defineProperty(window, 'lorra', {
    value: { fs: { tree: treeMock } },
    writable: true,
    configurable: true,
  });
  treeMock.mockClear();
});

afterEach(() => {
  cleanup();
});

async function renderTree(showHiddenFiles = false, onToggleHidden?: () => void) {
  render(
    <FileTree
      rootId="ws-root"
      selectedFileId={null}
      onSelect={() => {}}
      showHiddenFiles={showHiddenFiles}
      onToggleHidden={onToggleHidden}
    />,
  );
  await screen.findByRole('tree');
}

describe('FileTree 隐藏项()', () => {
  it('默认隐藏 . 开头项,普通条目保留', async () => {
    await renderTree(false);
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.queryByText('.git')).toBeNull();
    expect(screen.queryByText('.pi')).toBeNull();
    expect(screen.queryByText('.env')).toBeNull();
  });

  it('showHiddenFiles=true 时显示隐藏项', async () => {
    await renderTree(true);
    expect(screen.getByText('.git')).toBeInTheDocument();
    expect(screen.getByText('.pi')).toBeInTheDocument();
    expect(screen.getByText('.env')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('子目录展开后同样过滤隐藏项', async () => {
    await renderTree(false);
    await userEvent.click(screen.getByText('src'));
    expect(await screen.findByText('a.ts')).toBeInTheDocument();
    expect(screen.queryByText('.hidden.ts')).toBeNull();
  });

  it('开关按钮点击触发 onToggleHidden', async () => {
    const onToggleHidden = vi.fn();
    await renderTree(false, onToggleHidden);
    const toggle = screen.getByRole('button', { name: '显示隐藏项' });
    await userEvent.click(toggle);
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
  });

  it('showHiddenFiles=true 时按钮文案切到「隐藏隐藏项」', async () => {
    await renderTree(true, () => {});
    expect(screen.getByRole('button', { name: '隐藏隐藏项' })).toBeInTheDocument();
  });
});
