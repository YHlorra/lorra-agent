/**
 * knowledge 条目 wikilink 解析与断链判定(任务 6.12)单元测试。
 *
 * 规范真源(派工契约 6.12 链接语义,钉死):
 * - 提取:`[[target]]` / `[[target|别名]]`(WIKILINK_RE 同 remark-obsidian.ts),
 * 去重保序,只取 target 不含别名。
 * - 断链判定:target 按条目标题精确匹配「生效(active)knowledge 条目」;
 * 命中 retired/superseded 同标题 → broken:'archived';无 → broken:'missing';
 * 非 knowledge 类别同标题不计数。
 */
import { describe, expect, it } from 'vitest';

import { extractWikilinks, resolveWikilinks } from '../../src/renderer/lib/knowledge-links';
import type { MemoryEntry } from '../../src/shared/memory-schema';

let seq = 0;

/** 本地造数(与 src/shared/memory-schema.ts MemoryEntry 同形),默认 active knowledge。 */
function entry(title: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  seq += 1;
  return {
    entryId: `kl-${String(seq).padStart(3, '0')}`,
    schemaVersion: 1,
    tags: [],
    kind: 'knowledge',
    title,
    content: '内容',
    producer: 'test',
    source: 'agent-proposal',
    scope: 'user',
    workspace: null,
    evidence: 'inferred',
    basis: '',
    lifecycle: 'active',
    supersedes: null,
    createdAt: 1,
    updatedAt: 1,
    confirmedAt: 1,
    ofkRef: null,
    ...over,
  };
}

describe('extractWikilinks', () => {
  it('解析 [[target]] 与 [[target|别名]],返回 target 不含别名', () => {
    expect(extractWikilinks('看 [[文档A]] 与 [[文档B|别名B]]')).toEqual(['文档A', '文档B']);
  });

  it('多链接去重保序(同 target 不同别名也只出现一次)', () => {
    expect(extractWikilinks('[[甲]] [[甲]] [[乙]] [[甲|别名]]')).toEqual(['甲', '乙']);
  });

  it('无链接 → 空数组(普通文本/外链/单方括号不命中)', () => {
    expect(extractWikilinks('普通文本 [外链](https://x) 和 [[未闭合')).toEqual([]);
    expect(extractWikilinks('')).toEqual([]);
  });

  it('target 首尾空白裁剪;纯空白 target 忽略', () => {
    expect(extractWikilinks('[[  目标  ]] 与 [[  |无别名]]')).toEqual(['目标']);
  });
});

describe('resolveWikilinks', () => {
  it('target 精确命中 active knowledge 条目标题 → { entry }', () => {
    const a = entry('页面A');
    const map = resolveWikilinks('见 [[页面A]] 与 [[页面B]]', [a], []);
    expect(map.size).toBe(2);
    expect(map.get('页面A')).toEqual({ entry: a });
    expect(map.get('页面B')).toEqual({ broken: 'missing' });
  });

  it('retired/superseded 同标题 → broken archived(归档侧参与判定)', () => {
    const retired = entry('旧页面', { lifecycle: 'retired', confirmedAt: null });
    const superseded = entry('被取代页', { lifecycle: 'superseded', confirmedAt: null });
    const map = resolveWikilinks('[[旧页面]] 与 [[被取代页]]', [], [retired, superseded]);
    expect(map.get('旧页面')).toEqual({ broken: 'archived' });
    expect(map.get('被取代页')).toEqual({ broken: 'archived' });
  });

  it('active 优先于 archived 同名(同名存活条目不算断链)', () => {
    const live = entry('同名');
    const old = entry('同名', { lifecycle: 'retired', confirmedAt: null });
    const map = resolveWikilinks('[[同名]]', [live], [old]);
    expect(map.get('同名')).toEqual({ entry: live });
  });

  it('非 knowledge 类别同标题不计数 → missing', () => {
    const hardPolicy = entry('规则', { kind: 'hard_policy' });
    const map = resolveWikilinks('[[规则]]', [hardPolicy], []);
    expect(map.get('规则')).toEqual({ broken: 'missing' });
  });

  it('无链接内容 → 空 Map;归档列表缺省为空数组', () => {
    expect(resolveWikilinks('无链接', [], []).size).toBe(0);
    expect(resolveWikilinks('无链接', []).size).toBe(0);
  });
});
