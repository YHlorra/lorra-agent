import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchWorkspaceFiles } from '../../src/main/fs/fs-search';

describe('searchWorkspaceFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lorra-search-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function fixture(): Promise<void> {
    await writeFile(path.join(root, 'README.md'), 'x');
    await writeFile(path.join(root, 'spec.md'), 'x');
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'prd.md'), 'x');
    await writeFile(path.join(root, 'docs', 'notes.txt'), 'x');
    // 隐藏项
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), 'x');
    await mkdir(path.join(root, '.pi'));
    await writeFile(path.join(root, '.pi', 'session.jsonl'), 'x');
    await writeFile(path.join(root, '.env'), 'x');
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules', 'pkg.md'), 'x');
    // 深层(深度 5,应被截断)
    await mkdir(path.join(root, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    await writeFile(path.join(root, 'a', 'b', 'c', 'd', 'e', 'deep.md'), 'x');
  }

  it('文件名包含查询即命中,fileId 为相对路径(/ 分隔)', async () => {
    await fixture();
    const results = await searchWorkspaceFiles(root, 'prd');
    expect(results).toEqual([{ fileId: 'docs/prd.md', name: 'prd.md' }]);
  });

  it('跳过 .git/.pi/node_modules/隐藏项(含 .env 文件)', async () => {
    await fixture();
    const results = await searchWorkspaceFiles(root, '');
    const ids = results.map((r) => r.fileId);
    expect(ids).toContain('README.md');
    expect(ids).toContain('docs/prd.md');
    expect(ids).not.toContain('.git/config');
    expect(ids).not.toContain('.pi/session.jsonl');
    expect(ids).not.toContain('node_modules/pkg.md');
    expect(ids).not.toContain('.env');
  });

  it('大小写不敏感', async () => {
    await fixture();
    const results = await searchWorkspaceFiles(root, 'README');
    expect(results.map((r) => r.fileId)).toContain('README.md');
    const lower = await searchWorkspaceFiles(root, 'readme');
    expect(lower.map((r) => r.fileId)).toContain('README.md');
  });

  it('深度超过 4 的文件不返回', async () => {
    await fixture();
    const results = await searchWorkspaceFiles(root, 'deep');
    expect(results).toEqual([]);
  });

  it('limit 截断收集', async () => {
    await fixture();
    const results = await searchWorkspaceFiles(root, '', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('空查询返回全部(限制内)', async () => {
    await fixture();
    const results = await searchWorkspaceFiles(root, '');
    expect(results.length).toBeGreaterThanOrEqual(3);
  });
});
