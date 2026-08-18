/**
 * 复盘引擎测试数据(agent-memory-today-timeline)。
 * IPC 信封与 today-test-data 的 okToday/errToday 同源:生产 SerializedResult
 * {ok:true,value} / {ok:false,error:{code,message}}。
 * 契约:window.lorra.review.{generate,list,read} —— 类型单一事实源
 * src/shared/review-api.ts(与 preload 同源,防层间漂移;read 收 { id } 对象)。
 */
import { type Mock, vi } from 'vitest';
import type { ReviewMeta } from '../../src/shared/review-api';
import { type LorraMock, makeLorraMock } from './lorra-test-helpers';
import { makeDayData } from './today-test-data';

export type { ReviewMeta } from '../../src/shared/review-api';

/** legacy 旧存档形状:模块体系已删,保留 modules 字段以测旧数据兼容。 */

export function okRes<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function errRes(
  code: string,
  message: string,
): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

export function makeReviewMeta(over: Partial<ReviewMeta> & { id: string }): ReviewMeta {
  return {
    kind: 'daily',
    dateISO: '2026-08-07',
    modules: ['summary', 'missed', 'usage', 'code'],
    createdAt: 1_752_000_000_000,
    ...over,
  };
}

/** 示例报告 markdown(三层结构:全局概览 → 按工作区 → 跨项目洞察)。 */
export function makeReviewMarkdown(meta: ReviewMeta): string {
  const title = meta.kind === 'daily' ? '每日复盘' : '每周深度复盘';
  return [
    `# ${title} · ${meta.dateISO}`,
    '',
    '## 全局概览',
    '',
    '- 总使用时长 90 分钟,12 个会话',
    '',
    '## 工作区明细',
    '',
    '### E:/work/demo',
    '',
    '- 上午任务:3 个会话,30 分钟',
    '',
    '## 跨项目洞察',
    '',
    '> 晚间会话集中在 idea-lab,建议拆分长会话。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// window.lorra mock:今日页 IPC + 复盘 IPC
// ---------------------------------------------------------------------------

export interface ReviewLorraMock extends LorraMock {
  today: { getDayFacts: Mock };
  review: { generate: Mock; list: Mock; read: Mock };
}

export function installReviewLorraMock(): ReviewLorraMock {
  const m = makeLorraMock() as ReviewLorraMock;
  m.today = { getDayFacts: vi.fn().mockResolvedValue(okRes(makeDayData())) };
  m.review = { generate: vi.fn(), list: vi.fn(), read: vi.fn() };
  Object.defineProperty(window, 'lorra', {
    value: m,
    writable: true,
    configurable: true,
  });
  return m;
}
