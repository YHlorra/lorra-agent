import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

/**
 * OFK 知识文档层真实执行冒烟(2026-08-13 证明批,P5 迁移 + 「查看文档」链路)。
 *
 * 不依赖测试夹具:手工 SQL 播种一个 **v1 legacy memory.db**(无 ofk_ref 列、
 * 无 corpus/event_log/entries_fts),内建:
 * 1 条 >1024 字节 active 长条目(待迁移)、1 条短 active 条目、
 * 1 条 >1024 字节 superseded 长条目(必须不被迁移)。
 * 然后启动真实 Electron(隔离 profile:LORRA_E2E_USERDATA → mkdtemp 一次性目录)
 * → 打开记忆页(触发真实 MemoryStore.open → P5 迁移)→ 断言:
 * - bundle 生成 memory/<entryId>.md(type: Memory + 完整内容 + process:lorra-migration/1)
 * - 条目变摘要+指针(ofk_ref 置位、content 含「完整内容见」)
 * - 记忆页该条目显示「查看文档」按钮 → 点击 → 文档视图渲染完整内容
 * - 「返回条」→ 切回条目视图(选中态保持)
 * - superseded 长条目原样保留(ofk_ref IS NULL、content 未变)
 * 绝不允许碰真实 ~/.lorra(隔离保证同 app.spec/skills-page.spec)。
 */

const LONG_MARKER = '长条目独特内容标记';
const LONG_BODY = `第一段说明。\n\n${LONG_MARKER}${'x'.repeat(1_000)}\n\n结尾段。`;

/** v1 legacy 库(2026-08-10 口径:有 tags 列、无 ofk_ref 列)。 */
function seedLegacyDb(dbPath: string): { migrateId: string; shortId: string; archivedId: string } {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE corpus (
    corpus_id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL
  );
  INSERT INTO corpus (kind, label) VALUES
    ('hard_policy','硬性规则'),('soft_preference','软性偏好'),
    ('procedural_experience','经验教训'),('run_bound_feedback','运行反馈'),
    ('working_context','工作上下文'),('knowledge','知识页'),
    ('user_profile','用户档案'),('event','事件记录');
  CREATE TABLE entries (
    entry_id TEXT PRIMARY KEY,
    corpus_kind TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    producer TEXT NOT NULL,
    source TEXT NOT NULL,
    scope TEXT NOT NULL,
    workspace TEXT,
    evidence TEXT NOT NULL,
    basis TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    supersedes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    confirmed_at INTEGER
  );
  CREATE TABLE event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    entry_id TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT
  );`);
  const insert = raw.prepare(
    `INSERT INTO entries (entry_id, corpus_kind, schema_version, title, content, tags, producer, source, scope, workspace, evidence, basis, lifecycle, supersedes, created_at, updated_at, confirmed_at)
     VALUES (?, 'working_context', 1, ?, ?, '[]', 'legacy', 'agent-proposal', 'workspace', 'C:\\\\work\\\\demo', 'user-stated', 'legacy seed', ?, NULL, ?, ?, ?)`,
  );
  const migrateId = 'm'.repeat(64);
  const shortId = 's'.repeat(64);
  const archivedId = 'a'.repeat(64);
  insert.run(migrateId, '待迁移长条目', LONG_BODY, 'active', 1, 1, 1);
  insert.run(shortId, '普通条目', '简短内容', 'active', 2, 2, 2);
  insert.run(archivedId, '已归档长条目', LONG_BODY, 'superseded', 3, 3, 3);
  raw.exec(`CREATE VIRTUAL TABLE entries_fts USING fts5(
    title, content, entry_id UNINDEXED, tokenize='trigram', detail='none'
  );
  INSERT INTO entries_fts (title, content, entry_id) SELECT title, content, entry_id FROM entries;
  INSERT INTO event_log (ts, entry_id, event, detail) VALUES
    (1, '${migrateId}', 'recorded', NULL),
    (2, '${shortId}', 'recorded', NULL),
    (3, '${archivedId}', 'recorded', NULL);`);
  raw.close();
  return { migrateId, shortId, archivedId };
}

test.describe('OFK P5 真实执行(隔离 profile)', () => {
  test('legacy 库 open 迁移 + 记忆页「查看文档」链路 + 返回条切回', async () => {
    test.setTimeout(180_000);
    const userData = await mkdtemp(path.join(tmpdir(), 'lorra-ofk-e2e-'));
    const dbPath = path.join(userData, '.lorra', 'memory', 'memory.db');
    await mkdir(path.join(userData, '.lorra', 'memory'), { recursive: true });
    const { migrateId, archivedId } = seedLegacyDb(dbPath);

    const app = await electron.launch({
      args: [path.join(repoRoot, '.vite/build/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PI_OFFLINE: '1',
        ANTHROPIC_AUTH_TOKEN: '',
        LORRA_E2E_USERDATA: userData,
      },
    });

    try {
      const win = await app.firstWindow({ timeout: 60_000 });
      await win.waitForLoadState('domcontentloaded');
      await win
        .getByRole('region', { name: '会话历史' })
        .waitFor({ state: 'visible', timeout: 60_000 });

      // 进记忆页(图标栏「记忆」按钮)→ 触发真实 store open + P5 迁移。
      await win.getByRole('button', { name: '记忆' }).click();
      await win.getByTestId('memory-page').waitFor({ timeout: 30_000 });

      // ① 迁移后的条目行可见(标题命中,数据来自真实 db)。
      const row = win.locator(`[data-testid="memory-entry"][data-entry-id="${migrateId}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();

      // ② 条目详情 = 摘要 + 指针(查看文档按钮出现)。
      const docLink = win.locator('[data-testid="memory-doc-link"]');
      await expect(docLink).toBeVisible({ timeout: 15_000 });

      // ③ 点击「查看文档」→ 文档视图渲染 OFK memory/<id>.md 完整内容。
      await docLink.click();
      const docView = win.locator('[data-testid="memory-doc-view"]');
      await expect(docView).toBeVisible({ timeout: 15_000 });
      await expect(docView).toContainText(LONG_MARKER, { timeout: 15_000 });

      // ④ 返回条 → 切回条目视图(选中态保持,查看文档按钮复现)。
      await win.locator('[data-testid="memory-doc-back"]').click();
      await expect(win.locator('[data-testid="memory-doc-view"]')).toHaveCount(0);
      await expect(docLink).toBeVisible();

      // ⑤ 磁盘证据:概念文档生成 + 内容完整 + frontmatter 契约。
      const docPath = path.join(userData, '.lorra', 'knowledge', 'memory', `${migrateId}.md`);
      expect(existsSync(docPath)).toBe(true);
      const doc = await readFile(docPath, 'utf8');
      expect(doc).toContain('type: Memory');
      expect(doc).toContain('process:lorra-migration/1');
      expect(doc).toContain(LONG_MARKER);

      // ⑥ db 证据:迁移条目 = 摘要+指针;superseded 长条目原样(未迁移)。
      const raw = new DatabaseSync(dbPath);
      try {
        const migrated = raw
          .prepare('SELECT content, ofk_ref, lifecycle FROM entries WHERE entry_id = ?')
          .get(migrateId) as { content: string; ofk_ref: string; lifecycle: string };
        expect(migrated.lifecycle).toBe('active');
        expect(migrated.ofk_ref).toBe(`/memory/${migrateId}.md`);
        expect(migrated.content).toContain('完整内容见');
        expect(migrated.content).toContain(`/memory/${migrateId}.md`);
        const archived = raw
          .prepare('SELECT content, ofk_ref, lifecycle FROM entries WHERE entry_id = ?')
          .get(archivedId) as { content: string; ofk_ref: string | null; lifecycle: string };
        expect(archived.lifecycle).toBe('superseded');
        expect(archived.ofk_ref).toBeNull();
        expect(archived.content).toBe(LONG_BODY); // 完整原样,未被改写
        // bundle memory/ 目录下恰好 1 个文档(只有 active 长条目被迁移)
        const memoryDir = path.join(userData, '.lorra', 'knowledge', 'memory');
        expect(await readdir(memoryDir)).toEqual([`${migrateId}.md`]);
      } finally {
        raw.close();
      }

      // 视觉留证(工作区纪律:.smoke 内)。
      await win.screenshot({
        path: path.join(repoRoot, '.smoke', 'ofk-e2e-final.png'),
        fullPage: true,
      });
    } finally {
      await app.close();
      await rm(userData, { recursive: true, force: true });
    }
  });
});
