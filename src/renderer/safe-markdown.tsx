import type { JSX, ReactNode } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { useT } from './lib/i18n';
import {
  remarkObsidianCallout,
  remarkObsidianHighlight,
  remarkObsidianTags,
  remarkObsidianWikilink,
} from './lib/remark-obsidian';
import { MermaidBlock } from './mermaid-block';

// 链接/图片协议消毒:react-markdown 默认不过滤,jsdom 不渲染原始 HTML,
// 语法生成的 <a href>/<img src> 需自检协议,封掉 javascript:/data: 向量。
// 图片额外允许工作区相对路径(./ ../),否则本地 .md 的图片全部丢失 src。
const safeMarkdownComponents: Components = {
  a: ({ node, href, children, ...props }) => {
    const safe = href && /^(https?:\/\/|mailto:|#|\/)/i.test(href);
    return (
      <a href={safe ? href : undefined} {...props}>
        {children}
      </a>
    );
  },
  img: ({ node, src, alt, ...props }) => {
    const safe = src && (/^https?:\/\//i.test(src) || /^\.{1,2}\//.test(src));
    return <img src={safe ? src : undefined} alt={alt ?? ''} {...props} />;
  },
};

/** 从渲染子节点递归收集纯文本(代码块覆写取原文用)。 */
function collectText(children: ReactNode): string {
  let out = '';
  const walk = (nodes: ReactNode): void => {
    if (typeof nodes === 'string' || typeof nodes === 'number') {
      out += String(nodes);
      return;
    }
    if (Array.isArray(nodes)) {
      for (const n of nodes) walk(n);
      return;
    }
    if (nodes && typeof nodes === 'object' && 'props' in nodes) {
      const props = (nodes as { props?: { children?: ReactNode } }).props;
      if (props?.children !== undefined) walk(props.children);
    }
  };
  walk(children);
  return out;
}

interface SafeMarkdownProps {
  /** Markdown 原文。 */
  content: string;
  /** 额外 className;默认 `markdown-body`,与 document-viewer 一致。 */
  className?: string;
  /**
 * 'chat' = 右栏 AI 回答(GFM, );
 * 'document' = 中栏 Obsidian 式阅读(GFM + 数学 + callout/tag/高亮/wiki + mermaid)。
 */
  variant?: 'chat' | 'document';
  /**
 * wikilink 断链标注(仅 document 变体生效,6.12):target → 断链原因。
 * 命中项渲染为 span.wikilink.knowledge-link-broken(data-broken/data-hint),
 * 供页面级事件委托做断链提示与点击导航;缺省 = 原行为(span.wikilink 只渲染)。
 */
  wikilinkBroken?: ReadonlyMap<string, 'missing' | 'archived'>;
}

// 共享 markdown 渲染:协议消毒 + 围栏代码高亮(github.css)。
// 用处:document-viewer 阅读文件、chat-pane 渲染 assistant 消息。
// 两处共用一份消毒规则,避免「document 拦截了 javascript:, chat 没拦截」漂移。
export function SafeMarkdown({
  content,
  className,
  variant = 'chat',
  wikilinkBroken,
}: SafeMarkdownProps): JSX.Element {
  const t = useT();
  const cls = className ?? 'markdown-body';
  const isDocument = variant === 'document';
  const options: Options = isDocument
    ? {
        // 传了 wikilinkBroken 才替换 wikilink 插件为带断链标注的实例(6.12);
        // 缺省走共享常量 documentRemarkPlugins,行为与 document-viewer 完全一致。
        remarkPlugins: wikilinkBroken
          ? [
              remarkGfm,
              remarkMath,
              remarkObsidianCallout,
              remarkObsidianTags,
              remarkObsidianHighlight,
              [
                remarkObsidianWikilink,
                {
                  brokenTargets: wikilinkBroken,
                  hintFor: (reason: 'missing' | 'archived') =>
                    t(reason === 'missing' ? 'memory.wikilinkMissing' : 'memory.wikilinkArchived'),
                },
              ],
            ]
          : documentRemarkPlugins,
        rehypePlugins: documentRehypePlugins,
        components: documentComponents,
      }
    : {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeHighlight],
        components: safeMarkdownComponents,
      };
  return (
    <div className={cls}>
      <ReactMarkdown {...options}>{content}</ReactMarkdown>
    </div>
  );
}

/** 协议消毒后的 component map,导出供复用/测试。 */
export const safeMarkdownComponentMap = safeMarkdownComponents;

/** document 变体的 remark 管线(GFM + 数学 + Obsidian 四插件)。 */
export const documentRemarkPlugins: Options['remarkPlugins'] = [
  remarkGfm,
  remarkMath,
  remarkObsidianCallout,
  remarkObsidianTags,
  remarkObsidianHighlight,
  remarkObsidianWikilink,
];

/** document 变体的 rehype 管线(代码高亮 + KaTeX)。 */
export const documentRehypePlugins: Options['rehypePlugins'] = [rehypeHighlight, rehypeKatex];

/** document 变体的组件表:消毒组件 + mermaid 代码块覆写。 */
export const documentComponents: Components = {
  ...safeMarkdownComponents,
  code({ node, className, children, ...props }) {
    if (className?.includes('language-mermaid')) {
      // mermaid 不在 highlight.js 语言表,highlight 会原样保留文本 → 直接收文本。
      return <MermaidBlock code={collectText(children)} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};
