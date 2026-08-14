/**
 * knowledge 条目 wikilink 解析与断链判定(任务 6.12)。
 *
 * 语义(派工契约 6.12 钉死):
 * - 提取:`[[target]]` / `[[target|别名]]`,WIKILINK_RE 与 remark-obsidian.ts
 * 共用同一份(从该模块导入,防漂移),去重保序,只取 target 不含别名。
 * - 断链判定:target 按条目标题精确匹配「生效(active)knowledge 条目」;
 * 命中 retired/superseded 同标题 → broken:'archived'(目标已归档);
 * 无 → broken:'missing'(目标不存在);非 knowledge 类别同标题不计数。
 * - active 优先于 archived 同名:同名存活条目不算断链。
 *
 * 纯函数、零 React 依赖;记忆页 MemoryCard 与单元测试共用。
 */
import type { MemoryEntry } from '../../shared/memory-schema';
import { WIKILINK_RE } from './remark-obsidian';

/**
 * 从 markdown 原文提取 wikilink target 列表(去重保序,别名与方括号剔除)。
 * 空 content / 无链接 → []。
 */
export function extractWikilinks(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    const target = m[1]?.trim() ?? '';
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/**
 * 单个 wikilink target 的判定结果:
 * - { entry }:target 精确命中 active knowledge 条目(可导航);
 * - { broken: 'missing' }:无任何 knowledge 条目命中;
 * - { broken: 'archived' }:仅命中 retired/superseded knowledge 同标题。
 */
export type WikilinkResolveResult = { entry: MemoryEntry } | { broken: 'missing' | 'archived' };

/**
 * 解析 content 中全部 wikilink 的断链/命中状态,按 target 建 Map。
 *
 * @param activeKnowledgeEntries 生效区 knowledge 条目(供精确匹配)。
 * @param archivedKnowledgeEntries 归档区 knowledge 条目(retired/superseded,
 * 参与 archived 断链判定);缺省为空数组。
 * 只统计 kind === 'knowledge' 的条目——非 knowledge 类别同标题不计数。
 */
export function resolveWikilinks(
  content: string,
  activeKnowledgeEntries: MemoryEntry[],
  archivedKnowledgeEntries: MemoryEntry[] = [],
): Map<string, WikilinkResolveResult> {
  const activeByTitle = new Map<string, MemoryEntry>();
  for (const e of activeKnowledgeEntries) {
    if (e.kind === 'knowledge') activeByTitle.set(e.title, e);
  }
  const archivedByTitle = new Set<string>();
  for (const e of archivedKnowledgeEntries) {
    if (e.kind === 'knowledge') archivedByTitle.add(e.title);
  }

  const out = new Map<string, WikilinkResolveResult>();
  for (const target of extractWikilinks(content)) {
    const entry = activeByTitle.get(target);
    if (entry) {
      out.set(target, { entry });
    } else if (archivedByTitle.has(target)) {
      out.set(target, { broken: 'archived' });
    } else {
      out.set(target, { broken: 'missing' });
    }
  }
  return out;
}
