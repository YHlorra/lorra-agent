import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { OBSIDIAN_TAG_SOURCE } from './remark-obsidian';

/**
 * Markdown 元数据提取:frontmatter title/tags、第一个 H1、正文(去掉
 * frontmatter 与首 H1)、body 偏移 → 原文偏移映射(编辑提交时用)。
 *
 * 用 remark-frontmatter + remark-parse(不用 gray-matter:它在浏览器渲染端
 * 引用 Buffer,会在 vite 构建的 renderer 里崩)。frontmatter 的 YAML 只取
 * title/tags 两个字段,手写最小解析,不引 YAML 库。
 */

export interface MarkdownMeta {
  /** frontmatter title ?? 第一个 H1 文本;都没有 → null(调用方回退文件名)。 */
  title: string | null;
  /** frontmatter tags + 正文内联 #tag,去重保序,不带 # 前缀。 */
  tags: string[];
  /** 去掉 frontmatter 与第一个 H1 后的正文(编辑渲染用)。 */
  body: string;
  /** body 偏移 → 原文偏移。 */
  toFull: (offset: number) => number;
}

/** 标题文本:递归拼接 heading 的 text 子节点。 */
function headingText(node: { children?: unknown[] }): string {
  let out = '';
  for (const child of node.children ?? []) {
    const c = child as { type?: string; value?: string; children?: unknown[] };
    if (c.type === 'text' && typeof c.value === 'string') out += c.value;
    else if (c.children) out += headingText(c);
  }
  return out;
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

/**
 * frontmatter YAML 最小解析:只认 `title:` 与 `tags:`(行内数组或缩进列表),
 * 其余字段忽略——这是 PRD/编辑器只消费的两个字段,不引完整 YAML 解析器。
 */
function parseFrontmatterYaml(value: string): { title: string | null; tags: string[] } {
  let title: string | null = null;
  let tags: string[] = [];
  let inTagsList = false;
  for (const line of value.split('\n')) {
    const titleMatch = /^title:\s*(.*)$/.exec(line);
    if (titleMatch) {
      title = unquote(titleMatch[1]);
      continue;
    }
    const tagsMatch = /^tags:\s*(.*)$/.exec(line);
    if (tagsMatch) {
      const rest = tagsMatch[1].trim();
      if (rest === '') {
        inTagsList = true;
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        tags = rest
          .slice(1, -1)
          .split(',')
          .map((t) => unquote(t))
          .filter(Boolean);
        inTagsList = false;
      } else {
        tags = [unquote(rest)];
        inTagsList = false;
      }
      continue;
    }
    if (inTagsList) {
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item) tags.push(unquote(item[1]));
      else inTagsList = false;
    }
  }
  return { title, tags };
}

export function extractMarkdownMeta(full: string): MarkdownMeta {
  const tree = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(full);

  // frontmatter 块在原文中的结束偏移(不含其后换行);无 frontmatter → 0。
  let fmEnd = 0;
  // 第一个 H1(相对全文的偏移区间)与内联标签。
  let hStart: number | null = null;
  let hEnd: number | null = null;
  let h1Title: string | null = null;
  let fmYaml = '';
  const inlineTags: string[] = [];
  const tagRe = new RegExp(OBSIDIAN_TAG_SOURCE, 'gu');

  visit(tree, (node, _index, parent) => {
    if (node.type === 'yaml' && fmEnd === 0) {
      fmYaml = (node as { value: string }).value;
      const end = node.position?.end.offset;
      if (end !== undefined) fmEnd = end;
      return;
    }
    if (node.type === 'heading' && (node as { depth?: number }).depth === 1 && hStart === null) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        hStart = start;
        hEnd = end;
        h1Title = headingText(node).trim() || null;
      }
      return;
    }
    if (node.type === 'text') {
      // 与渲染插件同规则:heading 内不提取标签(mdast 的 code 节点是 value 非 text 子树)。
      if (parent?.type === 'heading') return;
      for (const m of (node as { value: string }).value.matchAll(tagRe)) {
        inlineTags.push(m[2]);
      }
    }
  });

  const fm = fmEnd > 0 ? parseFrontmatterYaml(fmYaml) : { title: null, tags: [] };
  const fmTitle = fm.title && fm.title !== '' ? fm.title : null;
  const title = fmTitle ?? h1Title;
  const fmTags = fm.tags.map((t) => t.replace(/^#/, ''));
  const tags = [...new Set([...fmTags, ...inlineTags])];

  // 去掉 frontmatter 与第一个 H1(偏移相对全文)。
  const body =
    hStart !== null && hEnd !== null
      ? full.slice(fmEnd, hStart) + full.slice(hEnd)
      : full.slice(fmEnd);
  const delta = hStart !== null && hEnd !== null ? hEnd - hStart : 0;

  const toFull = (offset: number): number => {
    const abs = offset + fmEnd;
    return hStart !== null && abs >= hStart ? abs + delta : abs;
  };

  return { title, tags, body, toFull };
}
