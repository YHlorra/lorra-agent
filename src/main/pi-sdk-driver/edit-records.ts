import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './tool-safety/atomic-write';

/**
 * AI 编辑历史记录:每次 `edit`/`write` 执行后落一条记录,
 * 与对话流工具卡片通过 `id = toolCallId` 关联。
 *
 * 记录 id 唯一:同一 toolCallId 只会对应一次实际执行(拦截器在放行时记录、
 * tool_result 到达时落盘;失败/被阻断的调用不落盘)。
 */

export interface EditRecord {
  /** = 工具调用 toolCallId,唯一,关联对话卡片。 */
  id: string;
  sessionId: string;
  toolName: 'write' | 'edit';
  /** 相对工作区路径(/ 分隔)。 */
  fileId: string;
  /** 执行前完整内容;空串 = 新建文件(或文件原本为空)。 */
  before: string;
  /** 记录创建时间(Epoch ms)。 */
  ts: number;
  status: 'applied' | 'accepted' | 'reverted';
  /** 实际采用的机制:git(自管仓库) | snapshot(降级)。 */
  kind: 'git' | 'snapshot';
  /** git 路径:该次编辑的 commit hash。 */
  commit?: string;
  /** git 路径:commit 的父提交(复原目标)。 */
  parentCommit?: string;
}

/** 已裁决记录保留窗口:超过 7 天的 accepted/reverted 记录在 load 时丢弃。 */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 编辑记录统一存储(git 与快照两路径共用)。数据落在 `~/.lorra/edits/edits.json`,
 * 与会话/模型配置同目录族;写入全量原子替换(atomicWrite),崩溃不截断。
 */
export class EditRecordStore {
  private records = new Map<string, EditRecord>();
  private filePath: string;

  constructor(recordsDir: string) {
    this.filePath = path.join(recordsDir, 'edits.json');
  }

  /**
 * 幂等加载:目录不存在或文件缺失 → 空存储;解析失败 → 空存储(下次 save 全量重建)。
 * load 时丢弃超 7 天的已裁决(accepted/reverted)记录;applied 记录不清理。
 */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    const next = new Map<string, EditRecord>();
    if (parsed && typeof parsed === 'object') {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const record = value as EditRecord;
        if (
          typeof record?.id !== 'string' ||
          typeof record.fileId !== 'string' ||
          typeof record.before !== 'string' ||
          typeof record.ts !== 'number'
        ) {
          continue;
        }
        if ((record.status === 'accepted' || record.status === 'reverted') && record.ts < cutoff) {
          continue;
        }
        next.set(id, record);
      }
    }
    this.records = next;
  }

  async get(id: string): Promise<EditRecord | null> {
    return this.records.get(id) ?? null;
  }

  /** 全量写回 edits.json(mkdir recursive + atomicWrite)。 */
  async save(record: EditRecord): Promise<void> {
    this.records.set(record.id, record);
    await this.persist();
  }

  async updateStatus(id: string, status: EditRecord['status']): Promise<EditRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    const next = { ...record, status };
    this.records.set(id, next);
    await this.persist();
    return next;
  }

  async list(sessionId?: string): Promise<EditRecord[]> {
    const all = Array.from(this.records.values());
    const filtered = sessionId ? all.filter((r) => r.sessionId === sessionId) : all;
    return filtered.sort((a, b) => b.ts - a.ts);
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const blob: Record<string, EditRecord> = {};
    for (const [id, record] of this.records) {
      blob[id] = record;
    }
    await atomicWrite(this.filePath, `${JSON.stringify(blob, null, 2)}\n`);
  }
}
