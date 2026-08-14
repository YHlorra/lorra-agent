// T2 from tests/integration/PLAN.md — readWorkspaceRealpath 真跑。
//
// realpath 是 Node 原生 fs,在 Node 和 Electron 行为一致,不依赖 Electron runtime。
// 跑在 vitest 里(node env,无 jsdom)就够了,不需要起 Electron / Playwright。
//
// 覆盖:
// - :workspace 路径不透明,所有 fs 调用前 resolve 到 realpath
// - workspace-realpath.ts 5 行 wrapper 是否正确转发 fs.realpath(整合校验,
// 真实 case 覆盖在 unit 测试;此处覆盖 OS 层)
//
// 安全边界(PLAN.md):
// - 所有目录都在 os.tmpdir 下,前缀 lorra-iso-
// - 永远不引用项目树路径
// - 测试结束清理 tmpdir + symlink
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkspaceRealpath } from '../../src/main/pi-sdk-driver/workspace-realpath';

describe('workspace-realpath (real fs, no mocks)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lorra-iso-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the realpath of an existing dir (no symlink involved)', async () => {
    const ws = path.join(root, 'workspace');
    await mkdir(ws, { recursive: true });

    const got = await readWorkspaceRealpath(ws);
    expect(got).toBe(await realpath(ws));
  });

  it('resolves a symlink that points back at the workspace root', async () => {
    const ws = path.join(root, 'workspace');
    await mkdir(ws, { recursive: true });
    const link = path.join(root, 'link-in');
    await symlink(ws, link, 'dir');

    const got = await readWorkspaceRealpath(link);
    expect(got).toBe(await realpath(ws));
  });

  it('resolves a symlink that points OUTSIDE the workspace to a different realpath', async () => {
    const ws = path.join(root, 'workspace');
    const other = path.join(root, 'elsewhere');
    await mkdir(ws, { recursive: true });
    await mkdir(other, { recursive: true });
    const link = path.join(root, 'sneaky');
    await symlink(other, link, 'dir');

    const wsReal = await readWorkspaceRealpath(ws);
    const linkReal = await readWorkspaceRealpath(link);
    expect(wsReal).not.toBe(linkReal);
  });

  it('propagates ENOENT when the path does not exist', async () => {
    const ghost = path.join(root, 'never-created');
    await expect(readWorkspaceRealpath(ghost)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
