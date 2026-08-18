import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';

/**
 * 复盘报告存档与历史(spec review-engine「报告存档与历史」):
 * 报告以 Markdown 存档至 ~/.lorra/memory/reviews/,历史列表按时间倒序。
 * 存储布局:每份报告一个 <id>.md 文件,首行为元数据 JSON,其后为 Markdown
 * 正文;read 只读文件、解析元数据,绝不改写。
 */

export interface ReviewMeta {
  id: string;
  kind: 'daily' | 'weekly';
  dateISO: string;
  /** 旧存档兼容:历史报告含模块勾选;新报告由技能文件承载方法论,不再携带。 */
  modules?: string[];
  createdAt: number;
}

/** read 的返回:报告正文 + 解析出的元数据。 */
export interface StoredReview {
  meta: ReviewMeta;
  markdown: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export class ReviewStore {
  private constructor(private readonly dirPath: string) {}

  /** 目录不存在(或非目录)→ Err;调用方负责先建目录。 */
  static open(dirPath: string): Result<ReviewStore> {
    try {
      if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
        return err({ code: 'review-dir-missing', message: `reviews dir not found: ${dirPath}` });
      }
      return ok(new ReviewStore(dirPath));
    } catch (cause) {
      return err(toLorraError(cause, 'review-store-open-failed'));
    }
  }

  /**
   * 存档:<id>.md = 元数据 JSON 首行 + '\n' + Markdown 正文。
   * markdown 可省略(仅登记元数据的场景,如列表排序测试)。
   */
  save(meta: ReviewMeta, markdown?: string): Result<ReviewMeta> {
    if (!meta || typeof meta.id !== 'string' || !SAFE_ID.test(meta.id)) {
      return err({ code: 'review-invalid-id', message: 'invalid review id' });
    }
    try {
      writeFileSync(
        path.join(this.dirPath, `${meta.id}.md`),
        `${JSON.stringify(meta)}\n${markdown ?? ''}`,
        'utf8',
      );
      return ok(meta);
    } catch (cause) {
      return err(toLorraError(cause, 'review-save-failed'));
    }
  }

  /** 历史列表,按 createdAt 倒序(最新在前)。 */
  list(): Result<ReviewMeta[]> {
    try {
      const metas: ReviewMeta[] = [];
      for (const name of readdirSync(this.dirPath)) {
        if (!name.endsWith('.md')) continue;
        const parsed = parseReportFile(path.join(this.dirPath, name));
        if (parsed) metas.push(parsed.meta);
      }
      metas.sort((a, b) => b.createdAt - a.createdAt);
      return ok(metas);
    } catch (cause) {
      return err(toLorraError(cause, 'review-list-failed'));
    }
  }

  /** 读取报告(只读不修改文件);文件损坏/缺失 → Err。 */
  read(id: string): Result<StoredReview> {
    if (!SAFE_ID.test(id)) {
      return err({ code: 'review-invalid-id', message: 'invalid review id' });
    }
    try {
      const parsed = parseReportFile(path.join(this.dirPath, `${id}.md`));
      if (!parsed) {
        return err({ code: 'review-corrupted', message: `corrupted review file: ${id}` });
      }
      return ok(parsed);
    } catch (cause) {
      return err(toLorraError(cause, 'review-read-failed'));
    }
  }

  close(): void {
    // 纯文件读写,无句柄需释放;保留以符合契约。
  }
}

/** 解析报告文件:首行为元数据 JSON(非法即视为损坏),其后为正文。 */
function parseReportFile(filePath: string): StoredReview | null {
  const content = readFileSync(filePath, 'utf8');
  const newlineIndex = content.indexOf('\n');
  const metaLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
  try {
    const meta = JSON.parse(metaLine) as ReviewMeta;
    if (!meta || typeof meta.id !== 'string' || typeof meta.createdAt !== 'number') {
      return null;
    }
    return {
      meta,
      markdown: newlineIndex === -1 ? '' : content.slice(newlineIndex + 1),
    };
  } catch {
    return null;
  }
}
