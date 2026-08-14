import { createHash } from 'node:crypto';
import type { MemoryEntry } from '../../shared/memory-schema';

/**
 * 记忆条目内容哈希（/ memory-schema 定稿语义）：
 * 对除 entryId 外全部字段做键排序 + 紧凑 JSON 后取 sha256。
 * 幂等去重与 supersedes 链的依据。
 *
 * 放在主进程而非 shared：node:crypto 在 renderer(vite client) 打包时被
 * externalize，shared 模块被页面引用会运行期崩溃（boot smoke 实证）。
 * shared/memory-schema.ts 保持纯类型与常量。
 */
export function entryIdOf(entry: Omit<MemoryEntry, 'entryId'>): string {
  const canonical = JSON.stringify(sortKeys(entry));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
