import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOpencodeCollector,
  OPENCODE_RUNTIME,
  opencodeDataDir,
} from '../../src/main/ofk/builtin-collectors/opencode';
import { readSyncState, updateSyncState } from '../../src/main/ofk/sync-state';

// Requirement(plan S4/D3):opencode 增量——查询 time_updated > 水位;
// collect 内水位前移(sources.opencode = max(time_updated));
// 水位回退 → 旧行重现(验证查询语义 + 写失败自愈)。

function createSessionTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE session (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      parent_id text,
      slug text NOT NULL,
      directory text NOT NULL,
      title text NOT NULL,
      version text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      tokens_input integer,
      tokens_output integer,
      tokens_reasoning integer,
      model text
    )`);
}

function insertRow(
  db: DatabaseSync,
  row: { id: string; timeCreated: number; timeUpdated: number; title?: string },
): void {
  const insert = db.prepare(
    `INSERT INTO session
      (id, project_id, slug, directory, title, version, time_created, time_updated,
       tokens_input, tokens_output, tokens_reasoning, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    row.id,
    'global',
    'slug',
    'E:/work/demo',
    row.title ?? '会话',
    '1.14.28',
    row.timeCreated,
    row.timeUpdated,
    100,
    200,
    50,
    JSON.stringify({ id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'max' }),
  );
}

describe('opencode-collector 增量', () => {
  let home: string;
  let userdata: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-oc-home-'));
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-oc-userdata-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    const ocDir = path.join(home, '.local', 'share', 'opencode');
    mkdirSync(ocDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(userdata, { recursive: true, force: true });
  });

  function openDb(): DatabaseSync {
    return new DatabaseSync(path.join(opencodeDataDir(), 'opencode.db'));
  }

  it('首次 collect 全量 + sources.opencode = max(time_updated)', async () => {
    const db = openDb();
    createSessionTable(db);
    insertRow(db, { id: 'r1', timeCreated: 1000, timeUpdated: 2000 });
    insertRow(db, { id: 'r2', timeCreated: 1500, timeUpdated: 3000 });
    db.close();

    const collector = createOpencodeCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    const facts = result.unwrapOr([]);
    expect(facts.map((f) => f.sessionRef)).toEqual(['opencode-r1', 'opencode-r2']);
    const state = await readSyncState();
    expect(state.sources[OPENCODE_RUNTIME]).toBe(3000);
  });

  it('插入新行(更大 time_updated)→ 二次 collect 只返回新行', async () => {
    const db = openDb();
    createSessionTable(db);
    insertRow(db, { id: 'r1', timeCreated: 1000, timeUpdated: 2000 });
    db.close();

    const collector = createOpencodeCollector();
    const first = await collector.collect();
    expect(first.unwrapOr([])).toHaveLength(1);

    const db2 = openDb();
    insertRow(db2, { id: 'r3', timeCreated: 2500, timeUpdated: 4000 });
    db2.close();

    const second = await collector.collect();
    expect(second.isOk()).toBe(true);
    const facts = second.unwrapOr([]);
    expect(facts.map((f) => f.sessionRef)).toEqual(['opencode-r3']);
    const state = await readSyncState();
    expect(state.sources[OPENCODE_RUNTIME]).toBe(4000);
  });

  it('水位回退(写失败自愈)→ 旧行重现', async () => {
    const db = openDb();
    createSessionTable(db);
    insertRow(db, { id: 'r1', timeCreated: 1000, timeUpdated: 2000 });
    insertRow(db, { id: 'r2', timeCreated: 1500, timeUpdated: 3000 });
    db.close();

    const collector = createOpencodeCollector();
    await collector.collect();
    expect((await readSyncState()).sources[OPENCODE_RUNTIME]).toBe(3000);

    // 模拟 session-sync 写概念失败后的回退:水位回到失败行之下(3000 → 2999)
    await updateSyncState((s) => {
      s.sources[OPENCODE_RUNTIME] = Math.min(s.sources[OPENCODE_RUNTIME], 3000 - 1);
    });

    const again = await collector.collect();
    const facts = again.unwrapOr([]);
    // time_updated > 2999 → r2 重取,水位前移回 3000
    expect(facts.map((f) => f.sessionRef)).toEqual(['opencode-r2']);
    expect((await readSyncState()).sources[OPENCODE_RUNTIME]).toBe(3000);
  });

  it('无水位(空态)→ 0 起全量;watermark 缺失键不报错', async () => {
    // 直接写一个只有 files 的旧态(无 sources 键)验证 ?? 0 语义
    const db = openDb();
    createSessionTable(db);
    insertRow(db, { id: 'r1', timeCreated: 1000, timeUpdated: 2000 });
    db.close();

    const collector = createOpencodeCollector();
    const result = await collector.collect();
    expect(result.unwrapOr([])).toHaveLength(1);
  });
});
