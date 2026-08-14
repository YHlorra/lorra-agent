import path from 'node:path';
import { ipcMain } from 'electron';
import type { SessionConceptDoc } from '../../shared/ofk-schema';
import { parseSessionConcept } from '../../shared/ofk-schema';
import type { SerializedResult } from '../../shared/result';
import { toLorraError } from '../../shared/result';
import { localDateString, type TodayDayData } from '../memory/day-summary';
import { summarizeOfkDay } from '../ofk/day-aggregate';
import { ensureDayCompiled, readDayDigestSegments, type SegmentSpec } from '../ofk/day-digest';
import { listDayConceptFiles, readConcept } from '../ofk/ofk-bundle';
import { syncWorkspaceSessions } from '../ofk/session-sync';

/**
 * 今日页事实查询 IPC(step 5 + P4 step 7):三层架构第三层直读 OFK。
 * 每次调用:
 * 1. 冷路径全量同步(syncWorkspaceSessions,共享模块):遍历工作区会话目录下
 * 每个 *.jsonl → syncSessionFile(清洗 → 写 OFK 概念;内容相同 diff-skip)。
 * 坏文件 Err 记 console.error,fail-open 不中断。
 * 2. 数据源插件:loadPlugins + 按 dataSources 开关启用的内置
 * 适配器 → 逐个 collect → writeSessionConcept(落盘概念,聚合自然包含)。
 * 插件不进热路径(无 lorra 驱动事件,仅冷路径全量)。
 * 3. 读当日全部会话概念(sessions 下 /<YYYY>/<dateISO>/ 的 *.md)→ 解析
 * (解析失败跳过)→ summarizeOfkDay 聚合(含 categories 大类分区)。
 * 不再触碰 facts.db(纯增量,不依赖活跃 driver,原始 jsonl 全程只读)。
 */
export function registerTodayHandlers(): void {
  ipcMain.handle(
    'lorra.today.getDayFacts',
    async (_event, args?: { dateISO?: string }): Promise<SerializedResult<TodayDayData>> => {
      try {
        const dateISO = args?.dateISO ?? localDateString(new Date());

        // 冷路径:pi 会话 jsonl → 插件/内置数据源 → OFK 概念(fail-open)
        await syncWorkspaceSessions();

        // 触发当日 LLM 编译(分类/分段写回;失败不阻断——现有数据照常返回)
        try {
          const compiled = await ensureDayCompiled(dateISO);
          if (compiled.isErr()) console.error('[today-ipc] day compile failed:', compiled.error);
        } catch (cause) {
          console.error('[today-ipc] day compile threw:', cause);
        }

        // 直读 bundle:当日概念
        const docs: SessionConceptDoc[] = [];
        const listed = await listDayConceptFiles(dateISO);
        if (listed.isErr()) {
          return { status: 'error', error: listed.error };
        }
        for (const rel of listed.value) {
          const content = await readConcept(rel);
          if (content.isErr()) {
            console.error('[today-ipc] concept read failed:', content.error);
            continue;
          }
          if (content.value === null) continue;
          const doc = parseSessionConcept(content.value);
          if (!doc) continue; // 解析失败跳过(frontmatter 损坏/非 Session)
          if (!doc.sessionRef) {
            // 兜底:概念文件名 = <sessionRef>.md(旧文档无 sessionRef 字段时)
            doc.sessionRef = path.basename(rel, '.md');
          }
          docs.push(doc);
        }
        // 日摘要语义分段(LLM 编译产物;读取失败 fail-open → 空 Map,退化 breaks/单段)
        const digestSegments = new Map<string, SegmentSpec[]>();
        const segsResult = await readDayDigestSegments(dateISO);
        if (segsResult.isErr()) {
          console.error('[today-ipc] digest segments read failed:', segsResult.error);
        } else {
          for (const [ref, specs] of segsResult.value) digestSegments.set(ref, specs);
        }
        return { status: 'ok', value: summarizeOfkDay(docs, dateISO, digestSegments) };
      } catch (cause) {
        return { status: 'error', error: toLorraError(cause, 'today-failed') };
      }
    },
  );
}
