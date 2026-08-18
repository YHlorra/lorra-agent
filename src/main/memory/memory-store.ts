import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  MemoryEntry,
  MemoryEvent,
  MemoryEventKind,
  MemoryEvidence,
  MemoryKind,
  MemoryLifecycle,
  MemoryScope,
  MemorySource,
} from '../../shared/memory-schema';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_EVIDENCE_ORDER,
  MEMORY_KINDS,
  MEMORY_RECALL_TOP_K,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SPLIT_SUMMARY_MAX_BYTES,
  MEMORY_SPLIT_THRESHOLD_BYTES,
} from '../../shared/memory-schema';
import { yamlQuote } from '../../shared/ofk-schema';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { tMain } from '../i18n';
import { memoryDocPath, writeConceptSync } from '../ofk/ofk-bundle';
import { entryIdOf } from './entry-hash';
import { truncateUtf8ToBytes } from './text-bytes';

/**
 * 记忆存储核心(phase3-contract 6.1 建表 / + + ):
 * 八类 corpus + 自主写入状态机 + FTS5 召回查询。
 * - 拆除候选闸门:propose 直落 active(confirmedAt=now);
 * update/edit = 新建条目 supersedes 原条目,原条目 → superseded;
 * retire active → retired;agent 自审计自维护,无 confirm/reject。
 * - evidence 不因写入而改变:propose/update 只继承或沿用入参证据,一字不改。
 * - entry_id = 规范化内容哈希(entryIdOf):同内容必然同 id(幂等去重),内容任一变化 id 随之变化。
 * 哈希基于内容字段(不含时间戳/lifecycle——否则同内容两次 propose 因时刻不同产生不同 id,
 * 破坏幂等),见 contentId。
 * - 检索永不授权:search/recall 仅 active + scope 过滤,召回只作参考注入。
 */

/**
 * busy_timeout:SQLite 撞锁时等待上限(ms)。
 * 并发写(多句柄写同一 memory.db)时等待而非立即报 SQLITE_BUSY。
 */
export const MEMORY_BUSY_TIMEOUT_MS = 5_000;

/**
 * propose 入参:内容字段 + 来源/范围/证据。
 * entryId/schemaVersion/lifecycle/supersedes/时间戳均由 store 内部计算,调用方不传。
 * tags 可选(缺省 []):标准化标签,**不参与内容哈希**——
 * 同内容不同标签仍是同一 entry_id(幂等稳定,标签更新走 update 继承)。
 */
export type ProposeInput = Omit<
  MemoryEntry,
  | 'entryId'
  | 'schemaVersion'
  | 'lifecycle'
  | 'supersedes'
  | 'createdAt'
  | 'updatedAt'
  | 'confirmedAt'
  | 'tags'
  | 'ofkRef'
> & { tags?: string[]; ofkRef?: string | null };

/** update 补丁:缺省字段继承原条目(就地更新语义)。
 * kind 可改(2026-08-10 记忆页放开类别编辑;evidence 铁律不改)。 */
export interface UpdatePatch {
  title?: string;
  content?: string;
  basis?: string;
  kind?: MemoryKind;
  /** OFK 文档指针:仅改指针走就地 UPDATE,不产 supersedes;null = 清除。 */
  ofkRef?: string | null;
}

export interface SearchInput {
  query: string;
  /** 缺省不过滤 scope;传 scope 时 user/agent 级全局命中 + workspace 匹配。 */
  scope?: MemoryScope;
  workspace?: string | null;
}

export interface RecallInput {
  scope?: MemoryScope;
  workspace?: string | null;
  /** 截断条数,缺省 MEMORY_RECALL_TOP_K。 */
  k?: number;
  /** 可选:查询词参与 BM25 排序(仅排序,不过滤)。 */
  query?: string;
}

interface EntryRow {
  entry_id: string;
  corpus_kind: string;
  schema_version: number;
  title: string;
  content: string;
  tags: string | null;
  producer: string;
  source: string;
  scope: string;
  workspace: string | null;
  evidence: string;
  basis: string;
  lifecycle: string;
  supersedes: string | null;
  ofk_ref: string | null;
  created_at: number;
  updated_at: number;
  confirmed_at: number | null;
}

interface EventRow {
  id: number;
  ts: number;
  entry_id: string;
  event: string;
  detail: string | null;
}

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS corpus (
    corpus_id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    entry_id TEXT PRIMARY KEY,
    corpus_kind TEXT NOT NULL REFERENCES corpus(kind),
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
    supersedes TEXT REFERENCES entries(entry_id),
    ofk_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    confirmed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_entries_lifecycle ON entries(lifecycle);
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, entry_id UNINDEXED, tokenize='trigram', detail='none'
  );
  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    entry_id TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS entry_links (
    from_id TEXT NOT NULL REFERENCES entries(entry_id),
    to_id TEXT NOT NULL REFERENCES entries(entry_id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_entry_links_to ON entry_links(to_id);
  CREATE TABLE IF NOT EXISTS extraction_watermarks (
    session_file TEXT PRIMARY KEY,
    last_line INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const INSERT_ENTRY_SQL = `
  INSERT INTO entries (
    entry_id, corpus_kind, schema_version, title, content, tags, producer, source,
    scope, workspace, evidence, basis, lifecycle, supersedes, ofk_ref,
    created_at, updated_at, confirmed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * 证据权重:recall 首要排序键,顺序即 MEMORY_EVIDENCE_ORDER
 * (user-stated 4 / extracted 3 / inferred 2 / unverified 1)。
 */
const EVIDENCE_WEIGHT: Record<MemoryEvidence, number> = Object.fromEntries(
  MEMORY_EVIDENCE_ORDER.map((kind, i) => [kind, MEMORY_EVIDENCE_ORDER.length - i]),
) as Record<MemoryEvidence, number>;

/** 单次关联生成最多建链条数（防 LLM 短语全命中爆炸）。 */
export const MEMORY_LINK_MAX = 5;
/** recall 一跳扩展上限（命中页之后最多追加的关联页数）。 */
export const MEMORY_RECALL_HOP_MAX = 3;

/**
 * LIKE 查询词转义:反斜杠/百分号/下划线按字面处理(配合 SQL `ESCAPE '\'`)。
 * 检索走 FTS5 trigram tokenizer(detail='none'):LIKE '%词%' 对 ≥3 字符模式
 * 走子串索引、2 字符回退全表扫描——中文子串检索因此可用
 * (unicode61 整词分词把连续汉字当单 token,子串失效;2026-08-08 迁移)。
 * 多 token 按空白切分、隐式 AND。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function rowToEntry(row: EntryRow): MemoryEntry {
  let tags: string[] = [];
  if (row.tags) {
    try {
      const parsed = JSON.parse(row.tags) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      // 损坏的 tags JSON → 空数组（容错,不阻塞读回）
    }
  }
  return {
    entryId: row.entry_id,
    schemaVersion: row.schema_version,
    kind: row.corpus_kind as MemoryKind,
    title: row.title,
    content: row.content,
    tags,
    producer: row.producer,
    source: row.source as MemorySource,
    scope: row.scope as MemoryScope,
    workspace: row.workspace,
    evidence: row.evidence as MemoryEvidence,
    basis: row.basis,
    lifecycle: row.lifecycle as MemoryLifecycle,
    supersedes: row.supersedes,
    ofkRef: row.ofk_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
  };
}

function rowToEvent(row: EventRow): MemoryEvent {
  return {
    id: row.id,
    ts: row.ts,
    entryId: row.entry_id,
    event: row.event as MemoryEventKind,
    detail: row.detail,
  };
}

/** 内容首行(描述字段;剥换行,截 120 字符)。 */
function firstLine(content: string): string {
  const line =
    content
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  return line.slice(0, 120).replace(/\r/g, '');
}

/** 段落感知摘要:首段优先,叠加后续段落直到 ≤ 上限(utf8 字节)。 */
function paragraphSummary(content: string): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: string[] = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const candidate = [...out, paragraph].join('\n\n');
    if (used + Buffer.byteLength(paragraph, 'utf8') > MEMORY_SPLIT_SUMMARY_MAX_BYTES) {
      if (out.length === 0) {
        // 首段即超限 → 硬截断
        return truncateUtf8ToBytes(paragraph, MEMORY_SPLIT_SUMMARY_MAX_BYTES);
      }
      break;
    }
    out.push(paragraph);
    used = Buffer.byteLength(candidate, 'utf8');
  }
  return out.join('\n\n');
}

export class MemoryStore {
  /**
 * 句柄以非枚举属性存储(facts-store 同款):不暴露内部实现细节,
 * 也避免 vitest 深比较触达 node:sqlite 句柄。
 */
  private readonly db!: DatabaseSync;
  private closed = false;

  private constructor(db: DatabaseSync) {
    Object.defineProperty(this, 'db', {
      value: db,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  static open(dbPath: string): Result<MemoryStore> {
    let db: DatabaseSync | null = null;
    try {
      // 父目录递归创建(phase3-contract 存储纪律;幂等,mkdir 已存在目录为 no-op)
      mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      // WAL:读写不互锁;busy_timeout:并发写撞锁时等待重试
      db.exec(`PRAGMA journal_mode = 'wal'`);
      db.exec(`PRAGMA busy_timeout = ${MEMORY_BUSY_TIMEOUT_MS}`);
      db.exec(`PRAGMA foreign_keys = ON`);
      db.exec(CREATE_TABLES_SQL);
      // 2026-08-10 tags 列迁移(幂等):旧库 entries 无 tags 列 → ALTER 加列
      // (DEFAULT '[]',已存在行自动填充空标签)。
      {
        const cols = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'tags')) {
          db.exec("ALTER TABLE entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
        }
        // ofk_ref 列迁移(幂等):旧库无该列 → ALTER 加列(null 默认)。
        if (!cols.some((c) => c.name === 'ofk_ref')) {
          db.exec('ALTER TABLE entries ADD COLUMN ofk_ref TEXT');
        }
      }
      // 八类 corpus 播种(开工即种,reopen 幂等;由 MEMORY_KINDS 驱动)
      const seed = db.prepare(
        'INSERT INTO corpus (kind, label) VALUES (?, ?) ON CONFLICT(kind) DO NOTHING',
      );
      for (const kind of MEMORY_KINDS) seed.run(kind, kind);
      // 开库迁移(幂等,写操作前执行):旧闸门库 candidate→active、
      // rejected→retired;无对应行的新库为 no-op。旧 event_log 行保留原文。
      db.exec("UPDATE entries SET lifecycle = 'active' WHERE lifecycle = 'candidate'");
      db.exec("UPDATE entries SET lifecycle = 'retired' WHERE lifecycle = 'rejected'");
      // FTS5 trigram 迁移(2026-08-08):旧库为 unicode61 整词分词,连续汉字
      // 当单 token、中文子串检索失效。检测建表语句,非 trigram 则重建并回填
      // (幂等;detail='none' 使 LIKE 子串检索可用)。重建失败不阻塞打开——
      // 检索退化由 search 的 LIKE 扫描兜底。
      try {
        const ftsDef = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'")
          .get() as { sql: string } | undefined;
        if (ftsDef && !ftsDef.sql.includes('trigram')) {
          db.exec('DROP TABLE entries_fts');
          db.exec(
            `CREATE VIRTUAL TABLE entries_fts USING fts5(
               title, content, entry_id UNINDEXED, tokenize='trigram', detail='none'
             )`,
          );
          db.exec(
            'INSERT INTO entries_fts (title, content, entry_id) SELECT title, content, entry_id FROM entries',
          );
        }
      } catch {
        // 迁移失败仅影响检索索引,不阻塞打开
      }
      const store = new MemoryStore(db);
      store.migrateLongContentToOfk(dbPath);
      return ok(store);
    } catch (cause) {
      // 打开/建表失败必须释放句柄,否则文件被锁(测试清理 unlink 报 EBUSY)
      try {
        db?.close();
      } catch {
        // close 失败无需再处理
      }
      return err(toLorraError(cause, 'memory-store-open-failed'));
    }
  }

  /**
 * 内容规范化哈希(幂等去重与 supersedes 链的依据):
 * 只哈希内容字段 + 固定占位(active/null/0),时间戳与 lifecycle 不入哈希——
 * 保证同内容任意时刻 propose 得到同一 entry_id(契约:同内容必然同 id)。
 */
  private static contentId(input: ProposeInput): string {
    return entryIdOf({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: input.kind,
      title: input.title,
      content: input.content,
      // 标签不入哈希(幂等稳定):同内容任意标签同 id;标签更新走 update 继承。
      tags: [],
      producer: input.producer,
      source: input.source,
      scope: input.scope,
      workspace: input.workspace,
      evidence: input.evidence,
      basis: input.basis,
      lifecycle: 'active',
      supersedes: null,
      // ofkRef 不入哈希(白名单外):固定占位 null,哈希与旧库一致。
      ofkRef: null,
      createdAt: 0,
      updatedAt: 0,
      confirmedAt: 0,
    });
  }

  /** 测试探针:按当前 schema 域计算 contentId(供升级兼容用例比对 v1/v2 域)。 */
  static contentIdForTest(
    input: Omit<ProposeInput, 'source' | 'ofkRef'> & { source: MemorySource },
  ): string {
    return MemoryStore.contentId(input as ProposeInput);
  }

  /** v1 哈希域(MEMORY_SCHEMA_VERSION=1 时代):无 ofkRef 键 + schemaVersion 1。
 * 以 null 传 ofkRef 后从对象中删除该键(sortKeys 前剥离),复现 v1 规范形。 */
  private static contentIdV1(input: ProposeInput): string {
    const { ofkRef: _ofkRef, ...rest } = {
      schemaVersion: 1,
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: [],
      producer: input.producer,
      source: input.source,
      scope: input.scope,
      workspace: input.workspace,
      evidence: input.evidence,
      basis: input.basis,
      lifecycle: 'active' as const,
      supersedes: null,
      ofkRef: null,
      createdAt: 0,
      updatedAt: 0,
      confirmedAt: 0,
    };
    return entryIdOf(rest as unknown as Omit<MemoryEntry, 'entryId'>);
  }

  private static isContentTooLong(content: string): boolean {
    return Buffer.byteLength(content, 'utf8') > MEMORY_CONTENT_MAX_BYTES;
  }

  private findEntry(entryId: string): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE entry_id = ?').get(entryId);
    return row ? rowToEntry(row as unknown as EntryRow) : null;
  }

  private insertEntry(
    entry: MemoryEntry,
    detail: string | null,
    event: MemoryEventKind,
    ts: number,
  ): void {
    this.db
      .prepare(INSERT_ENTRY_SQL)
      .run(
        entry.entryId,
        entry.kind,
        entry.schemaVersion,
        entry.title,
        entry.content,
        JSON.stringify(entry.tags),
        entry.producer,
        entry.source,
        entry.scope,
        entry.workspace,
        entry.evidence,
        entry.basis,
        entry.lifecycle,
        entry.supersedes,
        entry.ofkRef,
        entry.createdAt,
        entry.updatedAt,
        entry.confirmedAt,
      );
    this.db
      .prepare('INSERT INTO entries_fts (title, content, entry_id) VALUES (?, ?, ?)')
      .run(entry.title, entry.content, entry.entryId);
    this.insertEvent(ts, entry.entryId, event, detail);
  }

  private insertEvent(
    ts: number,
    entryId: string,
    event: MemoryEventKind,
    detail: string | null,
  ): void {
    this.db
      .prepare('INSERT INTO event_log (ts, entry_id, event, detail) VALUES (?, ?, ?, ?)')
      .run(ts, entryId, event, detail);
  }

  /**
 * 存量长内容迁移(open 末尾执行):active 且 ofk_ref IS NULL 且
 * utf8 字节 > MEMORY_SPLIT_THRESHOLD_BYTES 的条目 → 写 OFK
 * memory/<entryId>.md(完整内容)→ 条目 content 变摘要 + 指针、ofk_ref 置位。
 * 逐条目 fail-open:写失败 → console.error 跳过,下次 open 重试;memory.db
 * 原内容不动(数据不丢)。写入经 ofk-bundle writeConcept(原子写 + 路径校验)。
 */
  private migrateLongContentToOfk(dbPath: string): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM entries WHERE lifecycle = 'active' AND ofk_ref IS NULL ORDER BY created_at",
      )
      .all() as unknown as EntryRow[];
    for (const row of rows) {
      const bytes = Buffer.byteLength(row.content ?? '', 'utf8');
      if (bytes <= MEMORY_SPLIT_THRESHOLD_BYTES) continue;
      const entry = rowToEntry(row);
      const ofkRef = memoryDocPath(entry.entryId).replace(/\\/g, '/');
      const doc = [
        '---',
        'type: Memory',
        `title: ${yamlQuote(entry.title)}`,
        `description: ${yamlQuote(firstLine(entry.content))}`,
        'sources:',
        `  - id: memory-entry`,
        `    resource: ${dbPath}#${entry.entryId}`,
        `generated: { by: process:lorra-migration/1, at: ${new Date().toISOString()} }`,
        '---',
        '',
        entry.content,
      ].join('\n');
      const written = writeConceptSync(ofkRef, doc);
      if (written.isErr()) {
        console.error(
          `[memory-store] ofk migration write failed for ${entry.entryId}:`,
          written.error,
        );
        continue;
      }
      const summary = `${paragraphSummary(entry.content)}\n\n（完整内容见 [知识库](/${ofkRef})）`;
      try {
        this.db
          .prepare('UPDATE entries SET content = ?, ofk_ref = ? WHERE entry_id = ?')
          .run(summary, `/${ofkRef}`, entry.entryId);
      } catch (cause) {
        console.error(`[memory-store] ofk migration update failed for ${entry.entryId}:`, cause);
      }
    }
  }

  /**
 * 自主写入入口:任何来源写入直落 active + confirmedAt=now,
 * 无确认闸门。哈希幂等:同 entry_id 已存在 → no-op 返回既有条目
 * (任何 lifecycle 均如此,不再有 already-rejected);不存在 → 插入 active。
 */
  propose(input: ProposeInput): Result<MemoryEntry> {
    try {
      if (MemoryStore.isContentTooLong(input.content)) {
        return err({
          code: 'content-too-long',
          message: `content exceeds ${MEMORY_CONTENT_MAX_BYTES} bytes`,
        });
      }
      const entryId = MemoryStore.contentId(input);
      const existing = this.findEntry(entryId);
      // MEMORY_SCHEMA_VERSION 1→2 升级兼容:新域未命中时回查 v1 哈希域
      // (旧库条目的 entry_id 按 schemaVersion 1 + 无 ofkRef 键计算),
      // 命中即返回既有条目——同内容重提不产重复。
      if (existing) {
        return ok(existing);
      }
      const v1Id = MemoryStore.contentIdV1(input);
      if (v1Id !== entryId) {
        const legacy = this.findEntry(v1Id);
        if (legacy) return ok(legacy);
      }
      const now = Date.now();
      const entry: MemoryEntry = {
        entryId,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        kind: input.kind,
        title: input.title,
        content: input.content,
        tags: input.tags ?? [],
        producer: input.producer,
        source: input.source,
        scope: input.scope,
        workspace: input.workspace,
        evidence: input.evidence,
        basis: input.basis,
        lifecycle: 'active',
        supersedes: null,
        ofkRef: input.ofkRef ?? null,
        createdAt: now,
        updatedAt: now,
        confirmedAt: now,
      };
      this.db.exec('BEGIN');
      this.insertEntry(entry, null, 'recorded', now);
      this.db.exec('COMMIT');
      return ok(entry);
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // BEGIN 未成功时无活跃事务,ROLLBACK 无意义,忽略
      }
      return err(toLorraError(cause, 'memory-store-propose-failed'));
    }
  }

  /** 撤销(自维护):仅 active → retired(即时生效,退出召回池)。 */
  retire(entryId: string): Result<MemoryEntry> {
    try {
      const existing = this.findEntry(entryId);
      if (!existing) {
        return err({ code: 'not-found', message: `entry not found: ${entryId}` });
      }
      if (existing.lifecycle !== 'active') {
        return err({
          code: 'invalid-state',
          message: `cannot retire entry in lifecycle ${existing.lifecycle}`,
        });
      }
      const now = Date.now();
      this.db.exec('BEGIN');
      this.db.prepare("UPDATE entries SET lifecycle = 'retired' WHERE entry_id = ?").run(entryId);
      this.insertEvent(now, entryId, 'retired', null);
      this.db.exec('COMMIT');
      return ok(this.findEntry(entryId)!);
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 无活跃事务时忽略
      }
      return err(toLorraError(cause, 'memory-store-retire-failed'));
    }
  }

  /**
 * 就地更新(agent 自维护 + 记忆页触点③纠正入口):
 * 以补丁字段新建 entry(supersedes=原 entryId、lifecycle=active、
 * confirmedAt=now,kind/producer/source/scope/workspace/evidence/basis
 * 继承原值,补丁提供的字段覆盖),原 entry → superseded。
 * 补丁为空或与原文一致 → no-change;content 超限 → content-too-long。
 */
  update(entryId: string, patch: UpdatePatch): Result<MemoryEntry> {
    try {
      const original = this.findEntry(entryId);
      if (!original) {
        return err({ code: 'not-found', message: `entry not found: ${entryId}` });
      }
      const content = patch.content ?? original.content;
      if (MemoryStore.isContentTooLong(content)) {
        return err({
          code: 'content-too-long',
          message: `content exceeds ${MEMORY_CONTENT_MAX_BYTES} bytes`,
        });
      }
      const newInput: ProposeInput = {
        kind: patch.kind ?? original.kind,
        title: patch.title ?? original.title,
        content,
        tags: original.tags, // 标签继承(本批标签更新不走 update 补丁)
        producer: original.producer,
        source: original.source,
        scope: original.scope,
        workspace: original.workspace,
        evidence: original.evidence,
        basis: patch.basis ?? original.basis,
        ofkRef: patch.ofkRef ?? original.ofkRef,
      };
      const newId = MemoryStore.contentId(newInput);
      // :内容未变(仅指针变化)→ 不走 supersedes 链,就地更新 ofk_ref。
      if (newId === original.entryId && patch.ofkRef !== undefined) {
        if (patch.ofkRef === original.ofkRef) {
          return err({ code: 'no-change', message: tMain('errors.memory.noChange') });
        }
        const now = Date.now();
        this.db.exec('BEGIN');
        this.db
          .prepare('UPDATE entries SET ofk_ref = ?, updated_at = ? WHERE entry_id = ?')
          .run(patch.ofkRef, now, entryId);
        this.insertEvent(now, entryId, 'edited', 'ref→ref');
        this.db.exec('COMMIT');
        return ok(this.findEntry(entryId)!);
      }
      if (newId === original.entryId) {
        return err({ code: 'no-change', message: tMain('errors.memory.noChange') });
      }
      const now = Date.now();
      const newEntry: MemoryEntry = {
        entryId: newId,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        kind: newInput.kind,
        title: newInput.title,
        content: newInput.content,
        tags: original.tags,
        producer: newInput.producer,
        source: newInput.source,
        scope: newInput.scope,
        workspace: newInput.workspace,
        evidence: newInput.evidence,
        basis: newInput.basis,
        lifecycle: 'active',
        supersedes: entryId,
        ofkRef: newInput.ofkRef ?? null,
        createdAt: now,
        updatedAt: now,
        confirmedAt: now,
      };
      this.db.exec('BEGIN');
      this.insertEntry(newEntry, `${entryId}→${newId}`, 'edited', now);
      this.db
        .prepare("UPDATE entries SET lifecycle = 'superseded' WHERE entry_id = ?")
        .run(entryId);
      this.db.exec('COMMIT');
      return ok(this.findEntry(newId)!);
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 无活跃事务时忽略
      }
      return err(toLorraError(cause, 'memory-store-update-failed'));
    }
  }

  /** 编辑(IPC edit 通道):= update 语义,title/content 必填(用户侧编辑入口)。
 * 2026-08-10:kind 可改(类别编辑),scope/evidence 继承不变。 */
  edit(
    entryId: string,
    title: string,
    content: string,
    basis?: string,
    kind?: MemoryKind,
  ): Result<MemoryEntry> {
    return this.update(entryId, { title, content, basis, kind });
  }

  /** 生效条目,可按类别过滤。 */
  listActive(kind?: MemoryKind): Result<MemoryEntry[]> {
    try {
      const rows =
        kind === undefined
          ? this.db
              .prepare("SELECT * FROM entries WHERE lifecycle = 'active' ORDER BY updated_at DESC")
              .all()
          : this.db
              .prepare(
                "SELECT * FROM entries WHERE lifecycle = 'active' AND corpus_kind = ? ORDER BY updated_at DESC",
              )
              .all(kind);
      return ok((rows as unknown as EntryRow[]).map(rowToEntry));
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-list-failed'));
    }
  }

  /** 归档(只读):retired + superseded。 */
  listArchived(): Result<MemoryEntry[]> {
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM entries WHERE lifecycle IN ('retired', 'superseded') ORDER BY updated_at DESC",
        )
        .all();
      return ok((rows as unknown as EntryRow[]).map(rowToEntry));
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-list-failed'));
    }
  }

  /**
 * ingest 编译匹配(方向 B 编译循环):给定提取产物的标题与内容,
 * 在生效 knowledge 页里找「标题命中 / 首段命中」的既有页,供编译层就地
 * update(supersedes 链)而非盲目新增。匹配规则确定性、无 LLM:
 * - 标题命中:规范化(trim + 折叠空白)后相等,或一方包含另一方(长度≥2);
 * - 首段命中:双方首段(首个 \n\n 块,无则首行)较短者被较长者包含(≥6 字符);
 * - 优先级:标题命中 > 首段命中;同级取 updatedAt 最新;无命中 → null。
 * 检索永不授权同源:匹配只作编译路由,不改变任何条目。
 */
  compileMatch(input: { title: string; content: string }): Result<MemoryEntry | null> {
    try {
      const active = this.listActive('knowledge');
      if (active.isErr()) return err(active.error);
      const norm = (s: string): string => s.trim().replace(/\s+/g, '');
      const title = norm(input.title);
      const firstPara = (s: string): string => {
        const blockEnd = s.indexOf('\n\n');
        const block = blockEnd === -1 ? s : s.slice(0, blockEnd);
        const lineEnd = block.indexOf('\n');
        return (lineEnd === -1 ? block : block.slice(0, lineEnd)).trim();
      };
      const inputPara = firstPara(input.content);
      const contains = (a: string, b: string): boolean =>
        a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
      let best: { entry: MemoryEntry; score: 0 | 1; updatedAt: number } | null = null;
      for (const entry of active.value) {
        const eTitle = norm(entry.title);
        const titleHit = eTitle.length >= 2 && (eTitle === title || contains(eTitle, title));
        const paraHit =
          inputPara.length >= 6 &&
          firstPara(entry.content).length >= 6 &&
          contains(firstPara(entry.content), inputPara);
        const score = titleHit ? 1 : paraHit ? 0 : null;
        if (score === null) continue;
        if (
          !best ||
          score > best.score ||
          (score === best.score && entry.updatedAt > best.updatedAt)
        ) {
          best = { entry, score, updatedAt: entry.updatedAt };
        }
      }
      return ok(best?.entry ?? null);
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-compile-match-failed'));
    }
  }

  /**
 * 自动关联回链(方向 C / 跨 kind):给定来源条目 id 与
 * 主题短语集合,在全部生效条目里做确定性标题匹配(与 compileMatch 同
 * norm/contains 先例),命中即建链 from→to(INSERT OR IGNORE,幂等)。
 * 返回实际新建的 to_id 列表。
 * 规则:短语与标题都做 norm(trim+折叠空白) 后互相包含(长度≥2)判定;
 * 排除来源自身;全部生效条目参与(跨 kind 图谱连接——偏好/经验/知识页
 * 彼此连边,不限于 knowledge 类);上限 MEMORY_LINK_MAX 条。
 */
  linkRelated(fromId: string, topicPhrases: string[]): Result<string[]> {
    const active = this.listActive();
    if (active.isErr()) return err(active.error);
    const norm = (s: string): string => s.trim().replace(/\s+/g, '');
    const contains = (a: string, b: string): boolean =>
      a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
    const targets = active.value.filter((e) => e.entryId !== fromId);
    const linked: string[] = [];
    try {
      this.db.exec('BEGIN');
      for (const phrase of topicPhrases) {
        const p = norm(phrase);
        if (p.length < 2) continue;
        for (const target of targets) {
          if (linked.length >= MEMORY_LINK_MAX) break;
          const t = norm(target.title);
          if (contains(t, p)) {
            const info = this.db
              .prepare(
                'INSERT OR IGNORE INTO entry_links (from_id, to_id, created_at) VALUES (?, ?, ?)',
              )
              .run(fromId, target.entryId, Date.now());
            if (Number(info.changes) > 0 && !linked.includes(target.entryId)) {
              linked.push(target.entryId);
            }
          }
        }
        if (linked.length >= MEMORY_LINK_MAX) break;
      }
      this.db.exec('COMMIT');
      return ok(linked);
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 无活跃事务忽略 */
      }
      return err(toLorraError(cause, 'memory-store-link-failed'));
    }
  }

  /**
 * 子串检索(trigram LIKE):仅 active;scope 过滤(user/agent 级全局命中,
 * workspace/project 级需 workspace 匹配入参);排序 = 首个 token 命中位置
 * 靠前 > 命中次数多者优先 > 内容短者优先(替代 BM25 的启发式,JS 侧计算)。
 */
  search(input: SearchInput): Result<MemoryEntry[]> {
    try {
      const tokens = input.query
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      if (tokens.length === 0) return ok([]);
      const conditions: string[] = [];
      const likeParams: SQLInputValue[] = [];
      for (const token of tokens) {
        const pattern = `%${escapeLike(token)}%`;
        likeParams.push(pattern, pattern);
        conditions.push("(f.title LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\')");
      }
      const where = conditions.join(' AND ');
      const params: SQLInputValue[] = [...likeParams];
      let scopeSql = '';
      if (input.scope !== undefined) {
        scopeSql = " AND (e.scope IN ('user','agent') OR e.workspace = ?)";
        params.push(input.workspace ?? null);
      }
      const rows = this.db
        .prepare(
          `SELECT e.* FROM entries e
           JOIN entries_fts f ON f.entry_id = e.entry_id
           WHERE e.lifecycle = 'active' AND ${where}${scopeSql}`,
        )
        .all(...params);
      const entries = (rows as unknown as EntryRow[]).map(rowToEntry);
      // 三键启发式排序（JS 侧;LIKE 无相关度分）:
      // 1. 首个 token 首次命中位置靠前;2. 命中次数多者优先;3. 内容短者优先
      const first = tokens[0].toLowerCase();
      const scored = entries.map((entry) => {
        const combined = `${entry.title}\n${entry.content}`.toLowerCase();
        let pos = -1;
        let count = 0;
        let idx = 0;
        while (idx <= combined.length - first.length) {
          const hit = combined.indexOf(first, idx);
          if (hit === -1) break;
          if (pos === -1) pos = hit;
          count += 1;
          idx = hit + first.length;
        }
        return { entry, pos: pos === -1 ? Number.POSITIVE_INFINITY : pos, count };
      });
      scored.sort(
        (a, b) =>
          a.pos - b.pos || b.count - a.count || a.entry.content.length - b.entry.content.length,
      );
      return ok(scored.map((s) => s.entry));
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-search-failed'));
    }
  }

  /**
 * 召回(会话启动注入/检索注入):仅 active + scope 过滤;
 * 排序键 = evidence 权重 > updatedAt 新鲜度 > 可选 query 命中位置;截断 k。
 */
  recall(input: RecallInput): Result<MemoryEntry[]> {
    try {
      const k = input.k ?? MEMORY_RECALL_TOP_K;
      if (k <= 0) return ok([]);
      const params: SQLInputValue[] = [];
      let scopeSql = '';
      if (input.scope !== undefined) {
        scopeSql = " AND (e.scope IN ('user','agent') OR e.workspace = ?)";
        params.push(input.workspace ?? null);
      }
      const rows = this.db
        .prepare(`SELECT e.* FROM entries e WHERE e.lifecycle = 'active'${scopeSql}`)
        .all(...params);
      const entries = (rows as unknown as EntryRow[]).map(rowToEntry);

      // 可选 query:命中位置只参与排序,不过滤(召回注入语境下无匹配词条仍可作背景参考)
      let hitPos: Map<string, number> | undefined;
      const q = input.query?.trim().toLowerCase() ?? '';
      if (q !== '') {
        hitPos = new Map();
        for (const entry of entries) {
          const pos = `${entry.title}\n${entry.content}`.toLowerCase().indexOf(q);
          if (pos !== -1) hitPos.set(entry.entryId, pos);
        }
      }

      entries.sort((a, b) => {
        const weightA = EVIDENCE_WEIGHT[a.evidence];
        const weightB = EVIDENCE_WEIGHT[b.evidence];
        if (weightA !== weightB) return weightB - weightA;
        if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
        if (hitPos) {
          // 命中位置靠前者优先;未命中的条目排最后
          const posA = hitPos.get(a.entryId) ?? Number.POSITIVE_INFINITY;
          const posB = hitPos.get(b.entryId) ?? Number.POSITIVE_INFINITY;
          if (posA !== posB) return posA - posB;
        }
        return 0;
      });
      // 一跳检索:命中条目沿 entry_links 取一跳关联页(出链+入链),
      // 过滤 active + scope(同主查询),排序键 = evidence 权重 > updatedAt,截断 HOP_MAX。
      const hits = entries.slice(0, k);
      if (hits.length === 0) return ok([]);
      const ids = hits.map((e) => e.entryId);
      const linkRows = this.db
        .prepare(
          `SELECT from_id, to_id FROM entry_links WHERE from_id IN (${ids.map(() => '?').join(',')}) OR to_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids, ...ids) as unknown as Array<{ from_id: string; to_id: string }>;
      const neighborIds = [
        ...new Set(linkRows.flatMap((r) => [r.from_id, r.to_id]).filter((id) => !ids.includes(id))),
      ];
      if (neighborIds.length === 0) return ok(hits);
      const hopSql = `SELECT * FROM entries e WHERE e.entry_id IN (${neighborIds.map(() => '?').join(',')}) AND e.lifecycle = 'active'${scopeSql}`;
      const hopRows = this.db
        .prepare(hopSql)
        .all(
          ...neighborIds,
          ...(input.scope !== undefined ? [input.workspace ?? null] : []),
        ) as unknown as EntryRow[];
      const hops = (hopRows as unknown as EntryRow[])
        .map(rowToEntry)
        .sort((a, b) => {
          const wA = EVIDENCE_WEIGHT[a.evidence],
            wB = EVIDENCE_WEIGHT[b.evidence];
          if (wA !== wB) return wB - wA;
          return b.updatedAt - a.updatedAt;
        })
        .slice(0, MEMORY_RECALL_HOP_MAX);
      return ok([...hits, ...hops]);
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-recall-failed'));
    }
  }

  /** 审计事件,按 ts 倒序;entryId 缺省返回全部。 */
  listEvents(entryId?: string): Result<MemoryEvent[]> {
    try {
      const rows =
        entryId === undefined
          ? this.db.prepare('SELECT * FROM event_log ORDER BY ts DESC, id DESC').all()
          : this.db
              .prepare('SELECT * FROM event_log WHERE entry_id = ? ORDER BY ts DESC, id DESC')
              .all(entryId);
      return ok((rows as unknown as EventRow[]).map(rowToEvent));
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-events-failed'));
    }
  }

  /** 八类 corpus 枚举(按 corpus_id 即生效区分组顺序)。 */
  listCorpus(): Result<Array<{ kind: MemoryKind; label: string }>> {
    try {
      const rows = this.db
        .prepare('SELECT kind, label FROM corpus ORDER BY corpus_id')
        .all() as unknown as Array<{ kind: string; label: string }>;
      return ok(rows.map((row) => ({ kind: row.kind as MemoryKind, label: row.label })));
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-list-failed'));
    }
  }

  /**
 * 会话提取水位:某会话 jsonl 已提取到的行号。
 * 无记录(首次提取) → 0。增量提取器据此只处理新行。
 */
  getExtractionWatermark(sessionFile: string): Result<number> {
    try {
      const row = this.db
        .prepare('SELECT last_line FROM extraction_watermarks WHERE session_file = ?')
        .get(sessionFile) as { last_line: number } | undefined;
      return ok(row?.last_line ?? 0);
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-watermark-failed'));
    }
  }

  /**
 * 会话提取水位写入。默认 MAX 语义:低水位不覆盖高水位(并发完成乱序
 * 时水位单调不后退);force: true 无条件覆盖——只给重置路径(水位 > 行数
 * 的 compaction 全量重提)使用,否则 MAX 会挡住重置 0 造成死循环。
 */
  setExtractionWatermark(
    sessionFile: string,
    lastLine: number,
    opts?: { force?: boolean },
  ): Result<void> {
    try {
      const updateClause =
        opts?.force === true
          ? 'last_line = excluded.last_line, updated_at = excluded.updated_at'
          : 'last_line = MAX(last_line, excluded.last_line), updated_at = excluded.updated_at';
      this.db
        .prepare(
          `INSERT INTO extraction_watermarks (session_file, last_line, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_file) DO UPDATE SET ${updateClause}`,
        )
        .run(sessionFile, lastLine, Date.now());
      return ok(undefined);
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-watermark-failed'));
    }
  }

  /**
 * 图谱数据出口:entry_links 全量边列表(展示阶段消费——
 * 网络图/关系面板)。返回形状 [{ fromId, toId }],无排序保证。
 */
  listLinks(): Result<Array<{ fromId: string; toId: string }>> {
    try {
      const rows = this.db
        .prepare('SELECT from_id, to_id FROM entry_links')
        .all() as unknown as Array<{ from_id: string; to_id: string }>;
      return ok(rows.map((row) => ({ fromId: row.from_id, toId: row.to_id })));
    } catch (cause) {
      return err(toLorraError(cause, 'memory-store-links-failed'));
    }
  }

  /** 幂等关闭:重复 close 不抛错(reset 单例已关闭后,测试清理再 close 安全)。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
