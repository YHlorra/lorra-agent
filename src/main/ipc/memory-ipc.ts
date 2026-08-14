import { ipcMain } from 'electron';
import {
  type CrystallizeArgs,
  type DigestFileArgs,
  type DigestTextArgs,
  type EditArgs,
  KNOWLEDGE_CHANNEL_READ,
  type ListActiveArgs,
  type ListEventsArgs,
  MEMORY_CHANNEL_CRYSTALLIZE,
  MEMORY_CHANNEL_DIGEST_FILE,
  MEMORY_CHANNEL_DIGEST_TEXT,
  MEMORY_CHANNEL_EDIT,
  MEMORY_CHANNEL_LIST_ACTIVE,
  MEMORY_CHANNEL_LIST_ARCHIVED,
  MEMORY_CHANNEL_LIST_EVENTS,
  MEMORY_CHANNEL_LIST_LINKS,
  MEMORY_CHANNEL_RETIRE,
  MEMORY_CHANNEL_SEARCH,
  type MemoryLink,
  type RetireArgs,
  type SearchArgs,
} from '../../shared/memory-api';
import type { MemoryEntry } from '../../shared/memory-schema';
import type { Result, SerializedResult } from '../../shared/result';
import { crystallize, digestFile, digestMaterial } from '../memory/material-digestion';
import { getSharedMemoryStore } from '../memory/shared-memory-store';

import { readConcept } from '../ofk/ofk-bundle';
/**
 * 记忆 IPC(phase3-contract 6.9 + 6.13 / ):记忆页全栈通道 + 素材消化/结晶。
 * 通道名/参数形状唯一事实源 = src/shared/memory-api.ts(逐字使用,防层间漂移)。
 *
 * - 全部经 getSharedMemoryStore 单例(不另持句柄,与工具/召回各消费方同库并发安全)。
 * - 无确认闸门:confirm/reject/batch 通道已移除,写入直落 active;
 * edit = update 语义(supersedes 链),retire = agent 自维护撤销。
 * - 错误映射:store 返回的 LorraError(content-too-long / not-found /
 * invalid-state / no-change)原样直通;意外异常统一 'internal'
 * (不在这里手写 try/catch 样板,单点收口)。
 * - 6.13 digest/crystallize:workspace 经 getActiveWorkspacePath getter 取当前值
 * (运行时切换工作区后仍取最新,fs-ipc 同款模式);无工作区 → no-workspace。
 * 提取器错误码(model-unavailable / digest-timed-out / content-too-long …)直通。
 */
export function registerMemoryIpc(opts?: {
  /** 当前活跃工作区路径;缺省 → 消化/结晶通道返回 no-workspace。 */
  getActiveWorkspacePath?: () => string | null;
}): void {
  ipcMain.handle(
    MEMORY_CHANNEL_LIST_ACTIVE,
    (_event, args?: ListActiveArgs): SerializedResult<MemoryEntry[]> => {
      const storeResult = getSharedMemoryStore();
      if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
      return serialize(storeResult.value.listActive(args?.kind));
    },
  );

  ipcMain.handle(MEMORY_CHANNEL_LIST_ARCHIVED, (): SerializedResult<MemoryEntry[]> => {
    const storeResult = getSharedMemoryStore();
    if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
    return serialize(storeResult.value.listArchived());
  });

  ipcMain.handle(MEMORY_CHANNEL_LIST_EVENTS, (_event, args?: ListEventsArgs) => {
    const storeResult = getSharedMemoryStore();
    if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
    return serialize(storeResult.value.listEvents(args?.entryId));
  });

  // 图谱数据出口:entry_links 全量边列表,展示阶段消费。
  ipcMain.handle(MEMORY_CHANNEL_LIST_LINKS, (): SerializedResult<MemoryLink[]> => {
    const storeResult = getSharedMemoryStore();
    if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
    return serialize(storeResult.value.listLinks());
  });

  ipcMain.handle(MEMORY_CHANNEL_EDIT, (_event, args: EditArgs): SerializedResult<MemoryEntry> => {
    const storeResult = getSharedMemoryStore();
    if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
    return serialize(
      storeResult.value.edit(args.entryId, args.title, args.content, args.basis, args.kind),
    );
  });

  ipcMain.handle(
    MEMORY_CHANNEL_RETIRE,
    (_event, args: RetireArgs): SerializedResult<MemoryEntry> => {
      const storeResult = getSharedMemoryStore();
      if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
      return serialize(storeResult.value.retire(args.entryId));
    },
  );

  ipcMain.handle(
    MEMORY_CHANNEL_SEARCH,
    (_event, args: SearchArgs): SerializedResult<MemoryEntry[]> => {
      const storeResult = getSharedMemoryStore();
      if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
      return serialize(
        storeResult.value.search({
          query: args.query,
          scope: args.scope,
          workspace: args.workspace,
        }),
      );
    },
  );

  // ---- 6.13 素材消化 + 用户结晶 ----

  ipcMain.handle(
    MEMORY_CHANNEL_DIGEST_TEXT,
    async (_event, args: DigestTextArgs): Promise<SerializedResult<{ entryId: string }>> => {
      const ws = opts?.getActiveWorkspacePath?.() ?? null;
      if (!ws) return noWorkspace();
      return serialize(await digestMaterial({ text: args.text, title: args.title, workspace: ws }));
    },
  );

  ipcMain.handle(
    MEMORY_CHANNEL_DIGEST_FILE,
    async (_event, args: DigestFileArgs): Promise<SerializedResult<{ entryId: string }>> => {
      const ws = opts?.getActiveWorkspacePath?.() ?? null;
      if (!ws) return noWorkspace();
      return serialize(await digestFile(args.filePath, { workspace: ws }));
    },
  );

  ipcMain.handle(
    MEMORY_CHANNEL_CRYSTALLIZE,
    async (_event, args: CrystallizeArgs): Promise<SerializedResult<{ entryId: string }>> => {
      const ws = opts?.getActiveWorkspacePath?.() ?? null;
      if (!ws) return noWorkspace();
      return serialize(
        await crystallize({ content: args.content, title: args.title, workspace: ws }),
      );
    },
  );

  // 知识库文档读取:记忆页「查看文档」跳转读 OFK memory/<entryId>.md。
  ipcMain.handle(
    KNOWLEDGE_CHANNEL_READ,
    async (
      _event,
      args: { path: string },
    ): Promise<SerializedResult<{ content: string | null }>> => {
      const read = await readConcept(args.path);
      if (read.isErr()) {
        return { status: 'error', error: read.error };
      }
      return { status: 'ok', value: { content: read.value } };
    },
  );
}

/** 无活跃工作区:消化/结晶按工作区落条目,缺工作区即结构化拒绝。 */
function noWorkspace(): SerializedResult<never> {
  return { status: 'error', error: { code: 'no-workspace', message: 'workspace not set' } };
}

/** 单条 Result → SerializedResult(store 错误码原样直通)。 */
function serialize<T>(result: Result<T>): SerializedResult<T> {
  return result.isOk()
    ? { status: 'ok', value: result.value }
    : { status: 'error', error: result.error };
}
