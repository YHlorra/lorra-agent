import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import type { Result, SerializedResult } from '../../shared/result';
import { ok } from '../../shared/result';
import type { ReviewRequest } from '../memory/review-assembler';
import { generateReview } from '../memory/review-generator';
import { createCompileModelInvoke } from '../memory/review-model';
import { type ReviewMeta, ReviewStore, type StoredReview } from '../memory/review-store';
import { syncWorkspaceSessions } from '../ofk/session-sync';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';
import { readWorkspaceRealpath } from '../pi-sdk-driver/workspace-realpath';

/**
 * 复盘 IPC(design D8, 改 OFK 直读):generate(读 bundle 概念/日摘要 →
 * 组装 → 生成 → 存档)/list/read。generate 无可用模型时返回 code
 * 'model-unavailable',前端按此禁入口;时间线离线不受影响。
 * 不再经 facts.db(refreshFacts/fetchFacts 随 P2 删除)。
 * 技能文件按活跃工作区播种/读取;无活跃工作区时回退 ~/.lorra/workspace。
 * MEDIUM-3 修复:generate 前先 syncWorkspaceSessions(会话 jsonl + 插件/
 * 内置数据源 → OFK 概念,幂等 diff-skip)——复盘不再依赖用户先打开今日页
 * 才同步会话(未开今日页时复盘曾静默漏会话)。同步失败只 console.error,
 * 不阻断复盘(既有 fail-open 纪律)。
 */
export function registerReviewHandlers(getActiveWorkspacePath?: () => string | null): void {
  let store: ReviewStore | null = null;

  function getReviewStore(): Result<ReviewStore> {
    if (store) return ok(store);
    mkdirSync(path.join(lorraConfigDir(), 'memory', 'reviews'), { recursive: true });
    const opened = ReviewStore.open(path.join(lorraConfigDir(), 'memory', 'reviews'));
    if (opened.isOk()) store = opened.value;
    return opened;
  }

  ipcMain.handle(
    'lorra.review.generate',
    async (_event, args: ReviewRequest): Promise<SerializedResult<ReviewMeta>> => {
      // MEDIUM-3:复盘前先冷同步会话(幂等 diff-skip);失败不阻断复盘
      try {
        await syncWorkspaceSessions();
      } catch (cause) {
        console.error('[review-ipc] session sync failed:', cause);
      }
      const storeResult = getReviewStore();
      if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
      const rawWorkspacePath =
        getActiveWorkspacePath?.() ?? path.join(lorraConfigDir(), 'workspace');
      const workspacePath = await readWorkspaceRealpath(rawWorkspacePath).catch(
        () => rawWorkspacePath,
      );
      const generated = await generateReview(args, {
        invoke: createCompileModelInvoke(),
        store: storeResult.value,
        workspacePath,
      });
      if (generated.isErr()) return { status: 'error', error: generated.error };
      return { status: 'ok', value: generated.value };
    },
  );

  ipcMain.handle('lorra.review.list', async (): Promise<SerializedResult<ReviewMeta[]>> => {
    const storeResult = getReviewStore();
    if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
    const listed = storeResult.value.list();
    if (listed.isErr()) return { status: 'error', error: listed.error };
    return { status: 'ok', value: listed.value };
  });

  ipcMain.handle(
    'lorra.review.read',
    async (_event, args: { id: string }): Promise<SerializedResult<StoredReview>> => {
      const storeResult = getReviewStore();
      if (storeResult.isErr()) return { status: 'error', error: storeResult.error };
      const read = storeResult.value.read(args.id);
      if (read.isErr()) return { status: 'error', error: read.error };
      return { status: 'ok', value: read.value };
    },
  );
}
