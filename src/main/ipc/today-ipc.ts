import path from 'node:path';
import { ipcMain } from 'electron';
import type { SessionConceptDoc } from '../../shared/ofk-schema';
import { parseSessionConcept } from '../../shared/ofk-schema';
import type { SerializedResult } from '../../shared/result';
import { toLorraError } from '../../shared/result';
import { localDateString, type TodayDayData } from '../memory/day-summary';
import { summarizeOfkDay } from '../ofk/day-aggregate';
import { createCompileScheduler } from '../ofk/compile-scheduler';
import {
  compileDay,
  dayDigestStaleGroups,
  readDayDigestSegments,
  type SegmentSpec,
} from '../ofk/day-digest';
import { listDayConceptFiles, readConcept } from '../ofk/ofk-bundle';
import { syncWorkspaceSessions } from '../ofk/session-sync';

/**
 * 今日页事实查询 IPC(step 5 + P4 step 7 + S6 后台编译):三层架构第三层
 * 直读 OFK。每次调用:
 * 1. 冷路径增量同步(syncWorkspaceSessions,共享模块):记账比对 + 只处理
 * 变化的文件(pi 会话 jsonl + 插件/内置数据源)。坏文件 Err 记
 * console.error,fail-open 不中断。
 * 2. stale 判定(纯本地读)后后台调度编译(plan S6/D5):页面**永不等待 LLM**,
 * 立即返回现有数据;编译完成经 'lorra.today.dayCompiled' 推送请求方
 * WebContents 刷新(页面已关 → isDestroyed 守卫跳过)。编译失败不推送,
 * 页面数据不受影响。
 * 3. 读当日全部会话概念(sessions 下 /<YYYY>/<dateISO>/ 的 *.md)→ 解析
 * (解析失败跳过)→ summarizeOfkDay 聚合(含 categories 大类分区)。
 * 不再触碰 facts.db(纯增量,不依赖活跃 driver,原始 jsonl 全程只读)。
 */

// 编译只从今日页入口与 review-assembler 入口触发;不在热同步/冷同步路径调度。
const compileScheduler = createCompileScheduler({ compileDay });

export function registerTodayHandlers(): void {
  ipcMain.handle(
    'lorra.today.getDayFacts',
    async (event, args?: { dateISO?: string }): Promise<SerializedResult<TodayDayData>> => {
      try {
        const dateISO = args?.dateISO ?? localDateString(new Date());

        // 冷路径:pi 会话 jsonl → 插件/内置数据源 → OFK 概念(fail-open)
        await syncWorkspaceSessions();

        // 后台编译调度(plan S6/D5):stale 判定快(纯本地),编译异步防抖;
        // 数据过期 → 立即返回现有数据 + 编译完成后推送请求页面刷新。
        try {
          const stale = await dayDigestStaleGroups(dateISO);
          if (stale.isOk() && stale.value.length > 0) {
            compileScheduler.schedule(dateISO, () => {
              if (!event.sender.isDestroyed()) {
                event.sender.send('lorra.today.dayCompiled', { dateISO });
              }
            });
          }
        } catch (cause) {
          console.error('[today-ipc] day compile schedule failed:', cause);
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
