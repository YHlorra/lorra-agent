import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionFact } from '../../../shared/facts-schema';
import type { Result } from '../../../shared/result';
import { err, ok, toLorraError } from '../../../shared/result';
import { cleanseSession, type RawSessionEntry } from '../cleanse';
import type { Collector, CollectorOutput } from './types';

/**
 * pi-sdk jsonl collector(spec pi-sdk jsonl collector):
 * 读取 sessionsDir 下全部 *.jsonl,处理 parentId 构成的分支会话树(多叶取
 * 活跃叶),产出标准事实。原始 jsonl 全程只读;损坏行/缺会话头文件跳过,
 * 其 LorraError 记入 ok 值 errors,不中断其余文件清洗。
 */
export function createPiSdkCollector(opts: { sessionsDir: string; workspace: string }): Collector {
  return {
    name: 'pi-sdk',
    async collect(): Promise<Result<CollectorOutput>> {
      let files: string[];
      try {
        files = readdirSync(opts.sessionsDir).filter((name) => name.endsWith('.jsonl'));
      } catch (cause) {
        return err(toLorraError(cause, 'sessions-dir-unreadable'));
      }
      const facts: SessionFact[] = [];
      const sourceErrors: CollectorOutput['errors'] = [];
      for (const file of files) {
        const result = cleanseSessionFile(path.join(opts.sessionsDir, file), opts.workspace);
        if (result.isOk()) {
          facts.push(result.value);
        } else {
          sourceErrors.push(result.error);
        }
      }
      return ok({ facts, errors: sourceErrors });
    },
  };
}

/**
 * 清洗单个 jsonl 文件 → 事实。热会话增量旁路与冷清洗共用此入口,
 * 保证同一会话冷/热两条路径产出同构事实。
 *
 * fact.workspace 以会话头 header.cwd 的真实路径为准(目录名/编码名只是
 * 文件系统存放位置,不是工作区身份);header.cwd 缺失时回退调用方传入值。
 */
export function cleanseSessionFile(jsonlPath: string, workspace: string): Result<SessionFact> {
  let content: string;
  try {
    content = readFileSync(jsonlPath, 'utf8');
  } catch (cause) {
    return err(toLorraError(cause, 'session-file-unreadable'));
  }
  const parsed = parseSessionJsonl(content);
  if (!parsed.header) {
    return err({ code: 'session-header-missing', message: `no session header: ${jsonlPath}` });
  }
  if (parsed.skippedLines.length > 0) {
    console.error(
      `[pi-sdk-collector] ${jsonlPath}: skipped ${parsed.skippedLines.length} malformed line(s)`,
    );
  }
  const resolvedWorkspace =
    parsed.header.cwd && parsed.header.cwd.length > 0 ? parsed.header.cwd : workspace;
  return cleanseSession(parsed.header, parsed.entries, resolvedWorkspace);
}

export interface ParsedSessionFile {
  header: { id: string; cwd: string } | null;
  entries: RawSessionEntry[];
  /** 解析中被跳过的行(损坏 JSON / 缺 id / 非法时间戳等),供上层记录。 */
  skippedLines: string[];
}

/**
 * 解析 pi 会话 jsonl:首个非空行必须为 session 头,否则整文件判为缺头;
 * 后续损坏行单独跳过,不影响其余行。
 */
export function parseSessionJsonl(content: string): ParsedSessionFile {
  const lines = content.split('\n');
  let header: { id: string; cwd: string } | null = null;
  const entries: RawSessionEntry[] = [];
  const skippedLines: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      skippedLines.push(line.slice(0, 80));
      continue;
    }
    if (entry === null || typeof entry !== 'object') {
      skippedLines.push(line.slice(0, 80));
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (!header) {
      if (record.type === 'session' && typeof record.id === 'string' && record.id.length > 0) {
        header = { id: record.id, cwd: typeof record.cwd === 'string' ? record.cwd : '' };
      }
      continue; // 首行不是合法 session 头 → 整文件无头
    }
    if (typeof record.id !== 'string' || record.id.length === 0) {
      skippedLines.push(line.slice(0, 80));
      continue;
    }
    const timestamp = Date.parse(
      typeof record.timestamp === 'string' || typeof record.timestamp === 'number'
        ? String(record.timestamp)
        : '',
    );
    if (Number.isNaN(timestamp)) {
      skippedLines.push(line.slice(0, 80));
      continue;
    }
    const message =
      record.type === 'message' && record.message && typeof record.message === 'object'
        ? (record.message as {
            role: string;
            content: unknown;
            usage?: { totalTokens?: number };
          })
        : undefined;
    const modelChange =
      record.type === 'model_change' &&
      typeof record.provider === 'string' &&
      typeof record.modelId === 'string'
        ? { provider: record.provider, modelId: record.modelId }
        : undefined;
    entries.push({
      id: record.id,
      parentId: typeof record.parentId === 'string' ? record.parentId : null,
      timestamp,
      message,
      modelChange,
    });
  }
  return { header, entries, skippedLines };
}
