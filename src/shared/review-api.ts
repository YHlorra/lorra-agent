/**
 * 复盘 IPC 契约单一事实源(bug-fix:契约层间漂移根因修复)。
 *
 * 背景:review-rail 调 read(id) 传字符串,而 preload 契约是 read({ id }),导致
 * 生产 ENOENT .../undefined.md。根因是同一契约在 preload 内联字面量、
 * vite-env.d.ts 手写声明、renderer 测试 mock 三处各写一遍,漂移无法在编译期
 * 暴露。
 *
 * 本模块收拢全部复盘 IPC 契约类型与通道名:
 * - ReviewRequest / ReviewMeta / StoredReview 从主进程模块 re-export(不重复定义;
 * PM 方向修正后 ReviewRequest = { kind; dateISO? },modules 与 userPrompt 均已移除,
 * 复盘重点由技能文件承载)
 * - GenerateArgs / ReadArgs 为 IPC 参数形状(ReadArgs 钉死 { id },对象包裹)
 * - 三个 channel 名常量,preload 与主进程共用
 */

import type { ReviewRequest } from '../main/memory/review-assembler';
import type { ReviewMeta, StoredReview } from '../main/memory/review-store';

export type { ReviewRequest } from '../main/memory/review-assembler';
export type { ReviewMeta, StoredReview } from '../main/memory/review-store';

/** 'daily' | 'weekly',取自 ReviewMeta.kind。 */
export type ReviewKind = ReviewMeta['kind'];

/** generate 的 IPC 参数形状(与 ReviewRequest 同构,复用不重定义)。 */
export type GenerateArgs = ReviewRequest;

/** read 的 IPC 参数形状:对象包裹(与其余 IPC 风格一致)。 */
export interface ReadArgs {
  id: string;
}

export const REVIEW_CHANNEL_GENERATE = 'lorra.review.generate';
export const REVIEW_CHANNEL_LIST = 'lorra.review.list';
export const REVIEW_CHANNEL_READ = 'lorra.review.read';
