import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditMechanism } from '../../src/main/pi-sdk-driver/edit-history/factory';
import type { GitEditHistory } from '../../src/main/pi-sdk-driver/edit-history/git-history';
import { runGit } from '../../src/main/pi-sdk-driver/edit-history/git-run';
import { SnapshotEditHistory } from '../../src/main/pi-sdk-driver/edit-history/snapshot-history';
import type { EditRecord } from '../../src/main/pi-sdk-driver/edit-records';

// git 提交需要身份;CI/开发机未必配了全局 user.name/email,测试内 stub 环境变量。
const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'lorra-test',
  GIT_AUTHOR_EMAIL: 'lorra-test@local',
  GIT_COMMITTER_NAME: 'lorra-test',
  GIT_COMMITTER_EMAIL: 'lorra-test@local',
};

// 让「git 二进制缺失」分支可测:环境变量开关转发到 runGit 桩。
vi.mock('../../src/main/pi-sdk-driver/edit-history/git-run', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/main/pi-sdk-driver/edit-history/git-run')>();
  return {
    ...actual,
    runGit: vi.fn(async (cwd: string, args: string[]) => {
      if (process.env.LORRA_GIT_MOCK_MISSING === '1') {
        return { ok: false, code: 'ENOENT', message: 'spawn git ENOENT' };
      }
      return actual.runGit(cwd, args);
    }),
  };
});

function makeRecord(over: Partial<EditRecord> = {}): EditRecord {
  return {
    id: 'call-1',
    sessionId: 's1',
    toolName: 'edit',
    fileId: 'docs/a.md',
    before: 'v1',
    ts: Date.now(),
    status: 'applied',
    kind: 'git',
    ...over,
  };
}

describe('createEditMechanism 工厂', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'lorra-mech-'));
    for (const [k, v] of Object.entries(GIT_IDENTITY)) vi.stubEnv(k, v);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(ws, { recursive: true, force: true }).catch(() => {});
  });

  it('非仓库 + git 可用 → git 机制:baseline commit + exclude 追加', async () => {
    await writeFile(path.join(ws, 'a.md'), 'hello');
    const mech = await createEditMechanism(ws);
    expect(mech.kind).toBe('git');

    const log = await runGit(ws, ['log', '--oneline']);
    expect(log.ok).toBe(true);
    if (log.ok) expect(log.stdout).toContain('lorra: baseline');

    const exclude = await readFile(path.join(ws, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.lorra-tmp');
  });

  it('已是 git 仓库 → snapshot 降级,不新增任何 commit', async () => {
    await writeFile(path.join(ws, 'a.md'), 'hello');
    expect((await runGit(ws, ['init'])).ok).toBe(true);
    expect((await runGit(ws, ['add', '-A'])).ok).toBe(true);
    expect((await runGit(ws, ['commit', '-m', 'user: original'])).ok).toBe(true);
    const before = await runGit(ws, ['rev-parse', 'HEAD']);

    const mech = await createEditMechanism(ws);
    expect(mech.kind).toBe('snapshot');

    const after = await runGit(ws, ['rev-parse', 'HEAD']);
    expect(after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.stdout).toBe(before.stdout);
  });

  it('git 二进制缺失(ENOENT) → snapshot', async () => {
    vi.stubEnv('LORRA_GIT_MOCK_MISSING', '1');
    const mech = await createEditMechanism(ws);
    expect(mech.kind).toBe('snapshot');
  });
});

describe('GitEditHistory', () => {
  let ws: string;
  let mech: GitEditHistory;

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'lorra-git-'));
    for (const [k, v] of Object.entries(GIT_IDENTITY)) vi.stubEnv(k, v);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(ws, 'docs'), { recursive: true });
    await writeFile(path.join(ws, 'docs', 'a.md'), 'v1');
    const created = await createEditMechanism(ws);
    expect(created.kind).toBe('git');
    mech = created as GitEditHistory;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(ws, { recursive: true, force: true }).catch(() => {});
  });

  it('finalize 提交编辑并回填 commit/parent', async () => {
    await writeFile(path.join(ws, 'docs', 'a.md'), 'v2');
    const record = makeRecord();
    const { commit, parentCommit } = await mech.finalize(record);

    expect(commit.length).toBe(40);
    expect(parentCommit.length).toBe(40);

    const log = await runGit(ws, ['log', '--oneline', '--all']);
    expect(log.ok).toBe(true);
    if (log.ok) expect(log.stdout).toContain('lorra: edit docs/a.md');

    // 提交内容 = v2(写盘后的版本),父提交内容 = v1
    const show = await runGit(ws, ['show', `${commit}:docs/a.md`]);
    expect(show.ok).toBe(true);
    if (show.ok) expect(show.stdout).toBe('v2');
    const parentShow = await runGit(ws, ['show', `${parentCommit}:docs/a.md`]);
    expect(parentShow.ok).toBe(true);
    if (parentShow.ok) expect(parentShow.stdout).toBe('v1');
  });

  it('revert 恢复到父提交版本并留下 revert commit', async () => {
    await writeFile(path.join(ws, 'docs', 'a.md'), 'v2');
    const record = makeRecord();
    const { commit, parentCommit } = await mech.finalize(record);
    record.commit = commit;
    record.parentCommit = parentCommit;

    await mech.revert(record);

    const content = await readFile(path.join(ws, 'docs', 'a.md'), 'utf8');
    expect(content).toBe('v1');
    const log = await runGit(ws, ['log', '--oneline']);
    expect(log.ok).toBe(true);
    if (log.ok) expect(log.stdout).toContain('lorra: revert docs/a.md');
  });

  it('guard:用户手动改动后拒绝复原', async () => {
    await writeFile(path.join(ws, 'docs', 'a.md'), 'v2');
    const record = makeRecord();
    const { commit, parentCommit } = await mech.finalize(record);
    record.commit = commit;
    record.parentCommit = parentCommit;

    // 用户手动改动(未提交)
    await writeFile(path.join(ws, 'docs', 'a.md'), 'manual edit');
    const guard = await mech.guardBeforeRevert(record);
    expect(guard).toBe('文件已被手动修改，无法复原');
  });

  it('guard:parent 提交已不存在(历史被改写)→ 拒绝', async () => {
    const record = makeRecord({ parentCommit: 'f'.repeat(40) });
    const guard = await mech.guardBeforeRevert(record);
    expect(guard).toBe('编辑记录对应的提交已不存在（历史被改写）');
  });
});

describe('SnapshotEditHistory', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'lorra-snap-'));
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true }).catch(() => {});
  });

  it('finalize no-op(空 hash),revert 原子写回 before', async () => {
    const mech = new SnapshotEditHistory(ws);
    const record = makeRecord({ before: 'v1' });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(ws, 'docs'), { recursive: true });
    await writeFile(path.join(ws, 'docs', 'a.md'), 'v2');

    const hashes = await mech.finalize(record);
    expect(hashes).toEqual({ commit: '', parentCommit: '' });

    await mech.revert(record);
    expect(await readFile(path.join(ws, 'docs', 'a.md'), 'utf8')).toBe('v1');
  });

  it('guardBeforeRevert 恒为空(无守卫)', async () => {
    const mech = new SnapshotEditHistory(ws);
    expect(await mech.guardBeforeRevert(makeRecord())).toBe('');
  });
});
