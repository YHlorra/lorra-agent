// 文件树隐藏项 分层契约(+ 隐藏项开关)
//
// 产品行为(起):文件树默认隐藏 `.git`、`.pi`、`.env*` 等隐藏项,
// 标题栏眼睛开关可展开,偏好持久化到 settings.json。
//
// 分层:readTree(本文件被测对象)是数据层,恒返回全部条目(不过滤);
// 过滤是表现层职责(renderer/file-tree.tsx 按 showHiddenFiles 过滤,
// 行为由 tests/renderer/file-tree.test.tsx 锁定)。本测试锁定数据层契约——
// 如果哪天有人「贴心地」在 readTree 里加 name.startsWith('.') && skip,
// 本测试会变红(表现层开关将失去数据源)。
//
// 跑法:vitest node env(无 jsdom),不需要 Electron / Playwright。
// 安全边界同 workspace-realpath.test.ts:所有目录都在 os.tmpdir 下,
// 前缀 lorra-iso-;测试结束清理 tmpdir。
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPathRegistry, readTree, workspaceRootId } from '../../src/main/fs/path-resolve';

describe('readTree 默认包含隐藏项( )', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lorra-iso-'));
    clearPathRegistry();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    clearPathRegistry();
  });

  it('Given 根目录含 .git/.pi/.env 等子目录 When 调用 readTree Then 这些隐藏条目都出现在返回数组中', async () => {
    // fixture:.git/、.pi/、.env、.vscode/ + 一个普通目录 src/ + 一个普通文件 README.md
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.pi'));
    await mkdir(path.join(root, '.env'));
    await mkdir(path.join(root, '.vscode'));
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'src', 'foo'));

    const nodes = await readTree(workspaceRootId(), root);

    const names = nodes.map((n) => n.name);
    // 所有隐藏项都包含(无过滤)
    expect(names).toContain('.git');
    expect(names).toContain('.pi');
    expect(names).toContain('.env');
    expect(names).toContain('.vscode');
    // 普通条目仍在
    expect(names).toContain('src');
  });

  it('Given 工作区只有隐藏项(无普通文件) When 调用 readTree Then 仍全部列出,不当作空工作区', async () => {
    // fixture:只有一个 .git 目录(类比刚 git init 的项目)
    await mkdir(path.join(root, '.git'));

    const nodes = await readTree(workspaceRootId(), root);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe('.git');
    expect(nodes[0]?.type).toBe('dir');
  });

  it('Given 隐藏目录含子文件 When 展开 When 调用 readTree(child) Then 递归子项也返回', async () => {
    // 测 readTree 对隐藏目录的递归不打折
    await mkdir(path.join(root, '.pi'));
    await mkdir(path.join(root, '.pi', 'sessions'));
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.git', 'hooks'));

    // 先列根,得到 .pi 的 id
    const root1 = await readTree(workspaceRootId(), root);
    const piNode = root1.find((n) => n.name === '.pi');
    const gitNode = root1.find((n) => n.name === '.git');
    // 递归 .pi 的子项
    if (!piNode) throw new Error('缺少 .pi 节点');
    const piChildren = await readTree(piNode.id, root);
    expect(piChildren.map((n) => n.name)).toContain('sessions');

    // 递归 .git 的子项
    if (!gitNode) throw new Error('缺少 .git 节点');
    const gitChildren = await readTree(gitNode.id, root);
    expect(gitChildren.map((n) => n.name)).toContain('hooks');
  });
});
