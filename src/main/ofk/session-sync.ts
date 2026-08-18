import { readdirSync } from 'node:fs';
import path from 'node:path';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';
import { readSettings } from '../workspace/settings';
import { createBuiltinCollectors } from './builtin-collectors';
import { readConcept, sessionConceptPath } from './ofk-bundle';
import { loadPlugins } from './plugin-loader';
import { readExistingMeta, syncSessionFile, writeSessionConcept } from './session-writer';
import { isFileUnchanged, readSyncState, statFile, updateSyncState } from './sync-state';

/**
 * 工作区会话冷同步(plan S3/D2 增量版):
 * 1. 遍历 ~/.lorra/sessions/ 下每个工作区目录的 *.jsonl → 水位比对:
 * - 文件 mtime+size 与同步记账一致且概念文档在位 → 不读不写直接跳过;
 * - 概念缺失 → 强制重提(用户删 bundle 可自愈);
 * - syncSessionFile 失败 → console.error 不记账,fail-open 下轮重试;
 * - 成功 → 记账 { mtimeMs, size, conceptRel }(updateSyncState dirty-check
 * 保证全量无变化时不写盘)。
 * 2. 数据源插件:loadPlugins + 按 dataSources 开关启用的内置
 * 适配器 → 逐个 collect → writeSessionConcept(落盘概念)。
 *
 * 消费方:today-ipc 冷路径(今日页)与 review-ipc(复盘生成)——复盘不再依赖
 * 用户先打开今日页才同步会话(MEDIUM-3 修复:未开今日页时复盘静默漏会话)。
 * 本模块不依赖 electron,测试可直接注入。
 */
export async function syncWorkspaceSessions(): Promise<void> {
  // 冷路径:pi 会话 jsonl → OFK 概念(记账增量,fail-open)
  const state = await readSyncState();
  const changed: Record<string, { mtimeMs: number; size: number; conceptRel: string }> = {};
  for (const dir of workspaceSessionDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      // workspace 以会话头 header.cwd 为准(syncSessionFile 内解析);
      // 目录名只是文件系统存放位置,不作为工作区身份。
      const full = path.join(dir, file);
      const stat = statFile(full);
      if (!stat) continue;
      const prev = state.files[full];
      if (isFileUnchanged(prev, stat)) {
        const existing = await readConcept(prev.conceptRel);
        if (existing.isOk() && existing.value !== null) {
          changed[full] = prev; // 记账命中 + 概念在位 → 不读不写
          continue;
        }
        // 概念缺失/读取失败 → 落到下方强制重提
      }
      const synced = await syncSessionFile(full, path.basename(dir));
      if (synced.isErr()) {
        console.error('[session-sync] session sync failed:', synced.error);
        continue; // fail-open,不记账 → 下轮重试
      }
      changed[full] = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        conceptRel: sessionConceptPath(synced.value),
      };
    }
  }
  if (Object.keys(changed).length > 0) {
    const result = await updateSyncState((s) => {
      Object.assign(s.files, changed);
    });
    if (result.isErr()) {
      console.error('[session-sync] sync state persist failed:', result.error);
    }
  }

  // 数据源插件:自定义插件 + 启用的内置适配器 → 写概念
  const settings = await readSettings();
  const collectors = [
    ...(await loadPlugins()).filter((p) => p.status === 'ok'),
    ...createBuiltinCollectors(settings.dataSources ?? {}),
  ];
  for (const collector of collectors) {
    const collected = await collector.collect();
    if (collected.isErr()) {
      console.error(`[session-sync] ${collector.name} collect failed:`, collected.error);
      continue;
    }
    for (const fact of collected.value) {
      // category + description 保持概念现有值(编译写回不被重同步覆盖,与 pi 路径同纪律)
      const existing = await readExistingMeta(fact);
      const written = await writeSessionConcept(
        fact,
        existing.category,
        null,
        undefined,
        existing.description,
      );
      if (written.isErr()) {
        console.error(`[session-sync] ${collector.name} concept write failed:`, written.error);
        // 水位自愈(plan S4/D3):opencode 等按 sources 记账的源,collect 内已
        // 前移水位 → 写失败会丢会话。回退到失败行 fact.end - 1 之下,
        // 下轮 time_updated > 回退水位自然重取。
        const rolledBack = await updateSyncState((s) => {
          if (s.sources[fact.collector] !== undefined) {
            s.sources[fact.collector] = Math.min(s.sources[fact.collector], fact.end - 1);
          }
        });
        if (rolledBack.isErr()) {
          console.error('[session-sync] watermark rollback failed:', rolledBack.error);
        }
      }
    }
  }
}

/** ~/.lorra/sessions/ 下每个子目录是一个工作区的会话目录。 */
function workspaceSessionDirs(): string[] {
  const root = path.join(lorraConfigDir(), 'sessions');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}
