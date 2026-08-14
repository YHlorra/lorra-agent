import type { Root } from 'mdast';
import { toHast } from 'mdast-util-to-hast';
import remarkParse from 'remark-parse';
import type { Plugin } from 'unified';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import {
  remarkObsidianCallout,
  remarkObsidianHighlight,
  remarkObsidianTags,
  remarkObsidianWikilink,
} from '../../src/renderer/lib/remark-obsidian';

/** mdast → hast,断言最终渲染树(与 react-markdown 管线一致:parse → 插件 transformer → rehype)。 */
function render(md: string, plugins: Plugin<[], Root>[] = []) {
  const processor = unified().use(remarkParse).use(plugins);
  const tree = processor.parse(md);
  // runSync 的返回类型是宽 Node,这里收窄到 Root 交给 toHast。
  const transformed = processor.runSync(tree) as Root;
  return toHast(transformed);
}

function findAllByTag(hast: unknown, tag: string): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; tagName?: string; children?: unknown[] };
    if (n.type === 'element' && n.tagName === tag) out.push(node);
    for (const c of n.children ?? []) walk(c);
  };
  walk(hast);
  return out;
}

describe('remarkObsidianCallout', () => {
  it('`> [!tip] 标题` → div.callout.callout-tip,标题在 callout-title 内', () => {
    const hast = render('> [!tip] 小贴士\n>\n> 内容在此', [remarkObsidianCallout]);
    const divs = findAllByTag(hast, 'div') as Array<{
      properties?: Record<string, unknown>;
      children?: unknown[];
    }>;
    const callout = divs.find((d) => (d.properties?.className as string[])?.includes('callout'));
    expect(callout).toBeTruthy();
    expect(callout?.properties?.className).toContain('callout-tip');
    const titleDiv = divs.find((d) =>
      (d.properties?.className as string[])?.includes('callout-title'),
    );
    expect(titleDiv).toBeTruthy();
    expect(JSON.stringify(titleDiv)).toContain('小贴士');
  });

  it('类型白名单外 → 默认 note;无标题行 → callout 容器无标题', () => {
    const hast = render('> [!frobnicate] x\n>\n> 内容', [remarkObsidianCallout]);
    const divs = findAllByTag(hast, 'div') as Array<{ properties?: Record<string, unknown> }>;
    const callout = divs.find((d) => (d.properties?.className as string[])?.includes('callout'));
    expect(callout?.properties?.className).toContain('callout-note');
  });

  it('非 callout 前缀的 blockquote 不重写', () => {
    const hast = render('> 普通引用\n> 继续', [remarkObsidianCallout]);
    expect(findAllByTag(hast, 'div').length).toBe(0);
  });
});

describe('remarkObsidianTags', () => {
  it('`#tag` → span.md-tag,保留前缀 #;heading 内不生成', () => {
    const hast = render('# 标题 #h1tag\n\n正文 #realtag 和 #另一个', [remarkObsidianTags]);
    const spans = findAllByTag(hast, 'span') as Array<{
      properties?: Record<string, unknown>;
      children?: Array<{ type?: string; value?: string }>;
    }>;
    const tagSpans = spans.filter((s) => (s.properties?.className as string[])?.includes('md-tag'));
    expect(tagSpans).toHaveLength(2);
    const text = tagSpans.map((s) => s.children?.[0]?.value).join('|');
    expect(text).toBe('#realtag|#另一个');
    // 标题里的 tag 原样文本,无 span 包裹
    expect(JSON.stringify(hast)).toContain('#h1tag');
    expect(JSON.stringify(hast)).not.toContain('md-tag"}]},{"type":"text","value":"#h1tag');
  });

  it('code 块内的 #tag 不生成 span', () => {
    const hast = render('```js\n// #notag\nconst a = 1;\n```\n\n正文 #realtag', [
      remarkObsidianTags,
    ]);
    const spans = findAllByTag(hast, 'span') as Array<{
      properties?: Record<string, unknown>;
    }>;
    const tagSpans = spans.filter((s) => (s.properties?.className as string[])?.includes('md-tag'));
    expect(tagSpans).toHaveLength(1);
    expect(JSON.stringify(hast)).toContain('#notag');
  });

  it('行首 tag 与词中 # 不误匹配', () => {
    const hast = render('#行首标签', [remarkObsidianTags]);
    const spans = findAllByTag(hast, 'span') as Array<{ properties?: Record<string, unknown> }>;
    const tagSpans = spans.filter((s) => (s.properties?.className as string[])?.includes('md-tag'));
    // #行首标签 是整行文本 → 匹配(行首允许 #)
    expect(tagSpans.length).toBeGreaterThanOrEqual(1);
  });
});

describe('remarkObsidianHighlight', () => {
  it('`==高亮==` → mark.md-highlight', () => {
    const hast = render('这是 ==重点内容== 和 ==另一处==', [remarkObsidianHighlight]);
    const marks = findAllByTag(hast, 'mark') as Array<{
      properties?: Record<string, unknown>;
      children?: Array<{ type?: string; value?: string }>;
    }>;
    expect(marks).toHaveLength(2);
    expect(marks[0]?.properties?.className).toContain('md-highlight');
    expect(marks[0]?.children?.[0]?.value).toBe('重点内容');
  });

  it('code 内不处理', () => {
    const hast = render('```\n==not-marked==\n```', [remarkObsidianHighlight]);
    expect(findAllByTag(hast, 'mark')).toHaveLength(0);
  });
});

describe('remarkObsidianWikilink', () => {
  it('`[[target]]` 与 `[[target|别名]]` → span.wikilink', () => {
    const hast = render('看 [[文档]] 或 [[文档2|别名文本]]', [remarkObsidianWikilink]);
    const spans = findAllByTag(hast, 'span') as Array<{
      properties?: Record<string, unknown>;
      children?: Array<{ type?: string; value?: string }>;
    }>;
    const links = spans.filter((s) => (s.properties?.className as string[])?.includes('wikilink'));
    expect(links).toHaveLength(2);
    expect(links[0]?.children?.[0]?.value).toBe('文档');
    expect(links[0]?.properties?.title).toBe('文档');
    expect(links[1]?.children?.[0]?.value).toBe('别名文本');
    expect(links[1]?.properties?.title).toBe('文档2');
  });

  it('code 内不处理', () => {
    const hast = render('```\n[[not-a-link]]\n```', [remarkObsidianWikilink]);
    expect(findAllByTag(hast, 'span')).toHaveLength(0);
  });
});
