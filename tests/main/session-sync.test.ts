import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../src/shared/result';
import { syncWorkspaceSessions } from '../../src/main/ofk/session-sync';
import { syncSessionFile, writeSessionConcept } from '../../src/main/ofk/session-writer';
import { readConcept, sessionConceptPath } from '../../src/main/ofk/ofk-bundle';
import { readSettings } from '../../src/main/workspace/settings';
import { loadPlugins } from '../../src/main/ofk/plugin-loader';
import { createBuiltinCollectors } from '../../src/main/ofk/builtin-collectors';
import { readSyncState, syncStatePath } from '../../src/main/ofk/sync-state';
import { FACTS_SCHEMA_VERSION, factIdOf, type SessionFact } from '../../src/shared/facts-schema';

// Requirement(plan S3/D2):pi 冷路径记账增量——水位命中 + 概念在位 → 不读不写;
// 概念缺失 → 强制重提;syncSessionFile Err → 不记账下轮重试;无变化 → 不写盘。
// syncWorkspaceSessions 的数据源插件段 mock 为空,聚焦 pi 遍历段。

vi.mock('../../src/main/ofk/session-writer', () => ({
  syncSessionFile: vi.fn(),
  writeSessionConcept: vi.fn(),
}));
vi.mock('../../src/main/ofk/ofk-bundle', () => ({
  readConcept: vi.fn(),
  sessionConceptPath: vi.fn(),
}));
vi.mock('../../src/main/workspace/settings', () => ({
  readSettings: vi.fn(),
}));
vi.mock('../../src/main/ofk/plugin-loader', () => ({
  loadPlugins: vi.fn(),
}));
vi.mock('../../src/main/ofk/builtin-collectors', () => ({
  createBuiltinCollectors: vi.fn(),
}));

function makeFact(sessionRef: string): SessionFact {
  const content: Omit<SessionFact, 'factId'> = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: 'pi-sdk',
    runtime: 'pi-sdk',
    agentId: 'pi-sdk',
    sessionRef,
    workspace: 'C:\\work\\demo',
    scope: 'workspace',
    start: new Date(2026, 7, 8, 9).getTime(),
    end: new Date(2026, 7, 8, 9, 1).getTime(),
    activeMs: 60_000,
    title: 't',
    summaryRef: null,
    tokens: 1,
    model: 'm',
    tools: [],
    unfinished: false,
    containsTodo: false,
    privacy: 'public_safe',
  };
  return { factId: factIdOf(content), ...content };
}

describe('session-sync 冷路径增量', () => {
  let userdata: string;
  let wsDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-session-sync-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    wsDir = path.join(userdata, '.lorra', 'sessions', 'ws1');
    mkdirSync(wsDir, { recursive: true });
    jsonlPath = path.join(wsDir, 'sess.jsonl');
    writeFileSync(jsonlPath, '{"a":1}\n', 'utf8');

    vi.mocked(readSettings).mockResolvedValue({ recentWorkspaces: [] });
    vi.mocked(loadPlugins).mockResolvedValue([]);
    vi.mocked(createBuiltinCollectors).mockReturnValue([]);
    vi.mocked(sessionConceptPath).mockImplementation(
      (fact: SessionFact) => `sessions/${fact.sessionRef}.md`,
    );
    vi.mocked(syncSessionFile).mockReset();
    vi.mocked(syncSessionFile).mockResolvedValue(ok(makeFact('abc')));
    vi.mocked(readConcept).mockReset();
    vi.mocked(readConcept).mockResolvedValue(ok('concept-content'));
    vi.mocked(writeSessionConcept).mockResolvedValue(ok());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('首次冷同步(无水位)→ 全量 sync + 水位记录', async () => {
    await syncWorkspaceSessions();
    expect(syncSessionFile).toHaveBeenCalledTimes(1);
    expect(syncSessionFile).toHaveBeenCalledWith(jsonlPath, 'ws1');
    const state = await readSyncState();
    const stat = statSync(jsonlPath);
    expect(state.files[jsonlPath]).toEqual({
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      conceptRel: 'sessions/abc.md',
    });
  });

  it('水位命中 + 概念存在 → 二次不重读且不写盘', async () => {
    await syncWorkspaceSessions();
    vi.mocked(syncSessionFile).mockClear();
    const stateMtime = statSync(syncStatePath()).mtimeMs;
    await syncWorkspaceSessions();
    expect(syncSessionFile).not.toHaveBeenCalled();
    expect(statSync(syncStatePath()).mtimeMs).toBe(stateMtime); // dirty-check
  });

  it('水位命中 + 概念缺失 → 强制重提', async () => {
    await syncWorkspaceSessions();
    vi.mocked(readConcept).mockResolvedValue(ok(null)); // 概念被删
    vi.mocked(syncSessionFile).mockClear();
    await syncWorkspaceSessions();
    expect(syncSessionFile).toHaveBeenCalledTimes(1);
  });

  it('mtime 变化(同 size)→ 重提;size 变化 → 重提且水位更新为新值', async () => {
    await syncWorkspaceSessions();
    // 同字节数重写:mtime 变化、size 不变
    writeFileSync(jsonlPath, '{"a":2}\n', 'utf8');
    vi.mocked(syncSessionFile).mockClear();
    await syncWorkspaceSessions();
    expect(syncSessionFile).toHaveBeenCalledTimes(1);

    // 变长重写:size 变化,水位更新为新 stat
    writeFileSync(jsonlPath, '{"longer":true}\n', 'utf8');
    vi.mocked(syncSessionFile).mockClear();
    await syncWorkspaceSessions();
    expect(syncSessionFile).toHaveBeenCalledTimes(1);
    const state = await readSyncState();
    const stat = statSync(jsonlPath);
    expect(state.files[jsonlPath].size).toBe(stat.size);
    expect(state.files[jsonlPath].mtimeMs).toBe(stat.mtimeMs);
  });

  it('syncSessionFile Err → 不记账,下轮重试', async () => {
    vi.mocked(syncSessionFile).mockResolvedValue(
      err({ code: 'session-header-missing', message: 'no header' }),
    );
    await syncWorkspaceSessions();
    const state = await readSyncState();
    expect(state.files[jsonlPath]).toBeUndefined();

    // 修复后下轮重提
    vi.mocked(syncSessionFile).mockResolvedValue(ok(makeFact('abc')));
    await syncWorkspaceSessions();
    expect(syncSessionFile).toHaveBeenCalledTimes(2);
    const after = await readSyncState();
    expect(after.files[jsonlPath]).toBeDefined();
  });

  it('水位命中 + 概念读取 Err(路径非法)→ 重提(fail-open)', async () => {
    await syncWorkspaceSessions();
    vi.mocked(readConcept).mockResolvedValue(err({ code: 'ofk-path-invalid', message: 'bad' }));
    vi.mocked(syncSessionFile).mockClear();
    await syncWorkspaceSessions();
    expect(syncSessionFile).toHaveBeenCalledTimes(1);
  });
});
