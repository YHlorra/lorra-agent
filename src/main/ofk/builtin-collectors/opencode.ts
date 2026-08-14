import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FACTS_SCHEMA_VERSION, factIdOf, type SessionFact } from '../../../shared/facts-schema';
import { err, ok, type Result, toLorraError } from '../../../shared/result';
import { readSyncState, updateSyncState } from '../sync-state';
import type { BuiltinCollector } from './collector-core';

/**
 * OpenCode 数据源:真实数据是 SQLite 而非 jsonl。
 * 2026-08-13 实证:~/.opencode 不存在(原实现的 root,0 文件静默零产出);
 * 真实存储走 XDG 数据目录 → ~/.local/share/opencode/opencode.db,
 * session 表 2686 行(directory=真实项目路径、title=真实标题、time_created/
 * time_updated、tokens_*、model=JSON 串)。message 9.4 万 + part 41.7 万行
 * 全量读取过重 → 本收集器只读 session 表,字段直接映射:
 * workspace=directory(normalize 统一分隔符,与 pi 链路口径一致)、title、
 * start/end、tokens=input+output+reasoning、model=JSON 串的 id 字段。
 * tools 留空、unfinished=false(取舍:不读 message/part)。
 * DB 被 opencode 实时写(WAL):readOnly 打开 + busy timeout,撞锁等待而非报错;
 * db 缺失/打不开 → Ok([]) fail-open(与 jsonl 工厂同纪律)。
 */

export const OPENCODE_RUNTIME = 'opencode';

/** opencode 数据目录(XDG 数据目录下;Windows 上 opencode 同样走 ~/.local/share)。 */
export function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.local', 'share'),
    'opencode',
  );
}

interface OpenCodeSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
}

/** model 列是 JSON 串({"id":"...","providerID":"...","variant":"..."})→ 取 id。 */
function modelIdOf(raw: string | null): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : '';
  } catch {
    return '';
  }
}

export function createOpencodeCollector(): BuiltinCollector {
  return {
    name: OPENCODE_RUNTIME,
    runtime: OPENCODE_RUNTIME,
    enabled: true,
    async collect(): Promise<Result<SessionFact[]>> {
      const dbPath = path.join(opencodeDataDir(), 'opencode.db');
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
      } catch {
        return ok([]); // db 缺失/打不开 → fail-open
      }
      try {
        // 增量(plan S4/D3):只查 time_updated > 水位的新行;原始 DB 数值直接
        // 比较不做单位换算(fact.end = Number(row.time_updated),二者同单位)。
        const state = await readSyncState();
        const watermark = state.sources[OPENCODE_RUNTIME] ?? 0;
        const rows = db
          .prepare(
            `SELECT id, directory, title, time_created, time_updated, model,
                    tokens_input, tokens_output, tokens_reasoning
             FROM session
             WHERE directory IS NOT NULL AND directory != ''
               AND time_created IS NOT NULL AND time_updated IS NOT NULL
               AND time_updated > ?`,
          )
          .all(watermark) as unknown as OpenCodeSessionRow[];
        const facts: SessionFact[] = [];
        let maxUpdated = watermark;
        for (const row of rows) {
          const start = Number(row.time_created);
          const end = Number(row.time_updated);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) continue;
          if (Number(row.time_updated) > maxUpdated) maxUpdated = Number(row.time_updated);
          const base: Omit<SessionFact, 'factId'> = {
            schemaVersion: FACTS_SCHEMA_VERSION,
            collector: OPENCODE_RUNTIME,
            runtime: OPENCODE_RUNTIME,
            agentId: OPENCODE_RUNTIME,
            sessionRef: `${OPENCODE_RUNTIME}-${row.id}`,
            scope: 'workspace',
            summaryRef: null,
            privacy: 'public_safe',
            workspace: path.normalize(String(row.directory)),
            start,
            end,
            activeMs: Math.max(0, end - start),
            title:
              row.title && String(row.title).trim().length > 0
                ? String(row.title).trim().slice(0, 60)
                : row.id,
            tokens:
              (row.tokens_input ?? 0) + (row.tokens_output ?? 0) + (row.tokens_reasoning ?? 0),
            model: modelIdOf(row.model),
            tools: [],
            unfinished: false,
            containsTodo: false,
          };
          facts.push({ ...base, factId: factIdOf(base) });
        }
        // 水位前移(max 已含 watermark 下界;无新行 → 不动)。
        // 写失败会丢会话 → session-sync 写概念失败时回退(sources[collector] =
        // min(现值, fact.end - 1)),下轮重取。
        if (maxUpdated > watermark) {
          const persisted = await updateSyncState((s) => {
            s.sources[OPENCODE_RUNTIME] = maxUpdated;
          });
          if (persisted.isErr()) {
            console.error(`[opencode] sync state persist failed:`, persisted.error);
          }
        }
        return ok(facts);
      } catch (cause) {
        return err(toLorraError(cause, 'opencode-collect-failed'));
      } finally {
        db.close();
      }
    },
  };
}
