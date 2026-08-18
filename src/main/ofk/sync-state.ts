import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';
import { atomicWrite } from '../pi-sdk-driver/tool-safety/atomic-write';

/**
 * 同步水位存储(plan S2/D1):~/.lorra/sync-state.json。
 *
 * 形状:
 * { version, files: Record<绝对路径, { mtimeMs, size, conceptRel }>,
 * sources: Record<runtime 名, 标量水位> }
 *
 * 用途:冷路径(pi 会话 / jsonl 采集器)按文件 mtime+size 记账跳过未变文件;
 * opencode 按 sources.opencode 原始 DB 数值只查增量。
 *
 * 关键纪律:
 * - updateSyncState read-modify-write 整体在模块级 promise 链内串行化,
 * today-ipc 与 review-ipc 并发同步时不会互相覆盖。
 * - dirty-check:mutate 后内容未变 → 跳过写盘(避免每次页面打开都写)。
 * - 写盘用 atomicWrite(tmp+fsync+rename,与 ofk-bundle writeConcept 同一原语);
 * 写失败返回 Err,调用方 console.error + fail-open(下轮 mtime 不匹配自然重提)。
 */
export const SYNC_STATE_VERSION = 1;

export interface SyncFileEntry {
  mtimeMs: number;
  size: number;
  /** 概念文档相对路径(sessions/<ws-slug>/<YYYY>/<YYYY-MM-DD>/<sessionRef>.md)。 */
  conceptRel: string;
}

export interface SyncState {
  version: number;
  /** key = 原始文件绝对路径(path.join 原生分隔符,Windows 大小写以 readdirSync 实际大小写为准)。 */
  files: Record<string, SyncFileEntry>;
  /** key = 采集器 runtime 名(现仅 'opencode'),值 = 该源最新标量水位(原始 DB 数值)。 */
  sources: Record<string, number>;
}

export function syncStatePath(): string {
  return path.join(lorraConfigDir(), 'sync-state.json');
}

/** 缺失/JSON 损坏/version 不符 → 空态并 console.error(损坏不阻断,视为首次全量同步)。 */
export async function readSyncState(): Promise<SyncState> {
  try {
    const raw = readFileSync(syncStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    if (parsed.version !== SYNC_STATE_VERSION) {
      console.error(`[sync-state] version mismatch (${String(parsed.version)}), reset to empty`);
      return emptyState();
    }
    return {
      version: SYNC_STATE_VERSION,
      files: parsed.files ?? {},
      sources: parsed.sources ?? {},
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[sync-state] read failed, reset to empty:', cause);
    }
    return emptyState();
  }
}

function emptyState(): SyncState {
  return { version: SYNC_STATE_VERSION, files: {}, sources: {} };
}

// read-modify-write 串行化:所有 updateSyncState 排队执行,防并发互踩。
let chain: Promise<unknown> = Promise.resolve();

/**
 * read-modify-write 水位更新。mutate 内直接改 state 对象;
 * mutate 后内容未变 → 不写盘;写盘失败返回 Err(调用方 fail-open)。
 */
export async function updateSyncState(mutate: (s: SyncState) => void): Promise<Result<void>> {
  const run = async (): Promise<Result<void>> => {
    const state = await readSyncState();
    const before = JSON.stringify(state);
    mutate(state);
    if (JSON.stringify(state) === before) {
      return ok(); // dirty-check:无变化不写盘
    }
    try {
      mkdirSync(path.dirname(syncStatePath()), { recursive: true });
      await atomicWrite(syncStatePath(), JSON.stringify(state, null, 2));
      return ok();
    } catch (cause) {
      return err(toLorraError(cause, 'sync-state-write'));
    }
  };
  const result = chain.then(run, run);
  chain = result.catch(() => {}); // 错误不阻断后续队列
  return result;
}

/** statSync try/catch:存在 → { mtimeMs, size };失败(不存在/权限) → null。 */
export function statFile(p: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(p);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/** 水位命中判定:mtime+size 全等 → true;任一不等或 prev undefined → false。 */
export function isFileUnchanged(
  prev: SyncFileEntry | undefined,
  stat: { mtimeMs: number; size: number },
): boolean {
  return prev !== undefined && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size;
}
