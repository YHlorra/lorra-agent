import type { Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

/**
 * Obsidian 兼容的 remark 插件集。全部用「未知 mdast 节点 + data.hName /
 * hProperties / hChildren」的 mdast→hast 重写方式(mdast-util-to-hast 官方
 * 机制),不写自定义 React 组件,同一管线在 document-viewer 与
 * markdown-editable 间完全复用。
 */

/** 内联标签 token 规则(渲染与 markdown-meta 提取共用同一份)。 */
export const OBSIDIAN_TAG_SOURCE = String.raw`(^|\s)#([\p{L}\p{N}_/:-]+)`;

/** callout 类型白名单(默认 note)。 */
const CALLOUT_TYPES = new Set([
  'note',
  'tip',
  'warning',
  'danger',
  'important',
  'info',
  'success',
  'question',
  'example',
]);

/** `> [!type] Title` 行。 */
const CALLOUT_RE = /^\[!(\w+)\](?:\s+(.+))?$/;

/** `==高亮==`。 */
const HIGHLIGHT_RE = /==([^=\n]+)==/g;

/**
 * `[[target]]` / `[[target|alias]]`。导出供 knowledge-links.ts 提取共用
 * (6.12 契约:解析与渲染同一份正则,防漂移)。
 */
export const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

interface InlineElement {
  type: string;
  value: string;
  data: {
    hName: string;
    hProperties: Record<string, unknown>;
    hChildren: Array<{ type: 'text'; value: string }>;
  };
}

function inlineElement(
  type: string,
  tagName: string,
  className: string,
  text: string,
  extra: Record<string, unknown> = {},
): InlineElement {
  return {
    type,
    value: text,
    data: {
      hName: tagName,
      hProperties: { className, ...extra },
      hChildren: [{ type: 'text', value: text }],
    },
  };
}

/** 拼接段:纯文本段直接是 mdast text 节点,命中段是自定义行内元素。 */
type Segment = { type: 'text'; value: string } | InlineElement;

function textSegment(value: string): { type: 'text'; value: string } {
  return { type: 'text', value };
}

/** 文本节点按 token 正则重写为内联元素(通用帮手)。 */
function rewriteText(
  tree: Root,
  skip: (parent: { type: string }) => boolean,
  makeSegments: (value: string) => Segment[] | null,
): void {
  visit(tree, 'text', (node, index, parent) => {
    if (!parent || index === undefined) return;
    if (skip(parent as unknown as { type: string })) return;
    const segments = makeSegments(node.value);
    if (!segments || segments.length === 0) return;
    (parent as unknown as { children: unknown[] }).children.splice(index, 1, ...segments);
  });
}

/**
 * `> [!tip] 标题` → div.callout.callout-tip,标题行作为 div.callout-title。
 * 首段若含多个行内节点(如 `[!note] **粗体标题**`)则只出 callout 容器、
 * 首段原样保留——渲染不丢内容,只是标题不带样式。
 */
export const remarkObsidianCallout: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'blockquote', (quote) => {
    const first = quote.children[0];
    if (first?.type !== 'paragraph') return;
    const text = first.children[0];
    if (text?.type !== 'text') return;
    const m = CALLOUT_RE.exec(text.value);
    if (!m) return;
    const raw = m[1]?.toLowerCase() ?? 'note';
    const cls = CALLOUT_TYPES.has(raw) ? raw : 'note';
    quote.data = {
      hName: 'div',
      hProperties: { className: ['callout', `callout-${cls}`] },
    };
    // 首段是单文本节点 → 整段重写为标题行;否则保留首段(退化但完整)。
    if (first.children.length === 1) {
      const title = (m[2] ?? '').trim();
      first.data = {
        hName: 'div',
        hProperties: { className: ['callout-title'] },
        hChildren: title ? [{ type: 'text', value: title }] : [],
      };
    }
  });
};

/** `#tag` → span.md-tag;跳过 heading(Obsidian 标题内不渲染标签)。code 子节点是 value 非 text,天然不命中。 */
export const remarkObsidianTags: Plugin<[], Root> = () => (tree) => {
  const re = new RegExp(OBSIDIAN_TAG_SOURCE, 'gu');
  rewriteText(
    tree,
    (parent) => parent.type === 'heading',
    (value) => {
      const segments: Segment[] = [];
      let last = 0;
      for (const m of value.matchAll(re)) {
        const idx = m.index ?? 0;
        if (idx > last) segments.push(textSegment(value.slice(last, idx)));
        const lead = m[1] ?? '';
        if (lead) segments.push(textSegment(lead));
        segments.push(inlineElement('mdTag', 'span', 'md-tag', `#${m[2]}`));
        last = idx + m[0].length;
      }
      if (segments.length === 0) return null;
      if (last < value.length) segments.push(textSegment(value.slice(last)));
      return segments;
    },
  );
};

/** `==高亮==` → mark.md-highlight。 */
export const remarkObsidianHighlight: Plugin<[], Root> = () => (tree) => {
  rewriteText(
    tree,
    () => false,
    (value) => {
      const segments: Segment[] = [];
      let last = 0;
      for (const m of value.matchAll(HIGHLIGHT_RE)) {
        const idx = m.index ?? 0;
        if (idx > last) segments.push(textSegment(value.slice(last, idx)));
        segments.push(inlineElement('mdHighlight', 'mark', 'md-highlight', m[1]));
        last = idx + m[0].length;
      }
      if (segments.length === 0) return null;
      if (last < value.length) segments.push(textSegment(value.slice(last)));
      return segments;
    },
  );
};

/**
 * wikilink 导航选项(6.12 可选参数;缺省 = 原「只渲染不导航」行为):
 * brokenTargets 命中即渲染为断链标记 span.wikilink.knowledge-link-broken,
 * 注入 data-target / data-broken / data-hint,供页面级事件委托做断链提示与
 * 点击导航(记忆页 knowledge 条目)。缺省不传 → 与 3a 完全一致,既有渲染测试零回归。
 */
export interface WikilinkNavOptions {
  /** target → 断链原因;命中项渲染为断链标记。 */
  brokenTargets?: ReadonlyMap<string, 'missing' | 'archived'>;
  /** 断链提示文案解析器;缺省用内置中文,行为与旧版一致。 */
  hintFor?: (reason: 'missing' | 'archived') => string;
}

/** 断链悬浮提示文案(与 memory-page 测试钉死)。 */
const WIKILINK_BROKEN_HINTS: Record<'missing' | 'archived', string> = {
  missing: '目标不存在',
  archived: '目标已归档',
};

/**
 * `[[target]]` / `[[target|别名]]` → span.wikilink(带 data-target 供导航;
 * 可选 brokenTargets 注入 data-broken/data-hint + knowledge-link-broken class)。
 * 只渲染不导航(跨文件跳转由消费方事件委托,PRD 未要求新增 IPC)。
 */
export const remarkObsidianWikilink: Plugin<[options?: WikilinkNavOptions], Root> =
  (options) => (tree) => {
    rewriteText(
      tree,
      () => false,
      (value) => {
        const segments: Segment[] = [];
        let last = 0;
        for (const m of value.matchAll(WIKILINK_RE)) {
          const idx = m.index ?? 0;
          if (idx > last) segments.push(textSegment(value.slice(last, idx)));
          const target = m[1]?.trim() ?? '';
          const alias = m[2] ?? target;
          const broken = options?.brokenTargets?.get(target);
          const extra: Record<string, unknown> = { title: target, 'data-target': target };
          if (broken) {
            const hint = options?.hintFor?.(broken) ?? WIKILINK_BROKEN_HINTS[broken];
            extra.className = ['wikilink', 'knowledge-link-broken'];
            extra['data-broken'] = broken;
            extra['data-hint'] = hint;
            extra.title = `${hint}: ${target}`;
          }
          segments.push(inlineElement('mdWikilink', 'span', 'wikilink', alias, extra));
          last = idx + m[0].length;
        }
        if (segments.length === 0) return null;
        if (last < value.length) segments.push(textSegment(value.slice(last)));
        return segments;
      },
    );
  };
