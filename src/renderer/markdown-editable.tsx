import {
  createElement,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { documentComponents, documentRehypePlugins, documentRemarkPlugins } from './safe-markdown';

/**
 * Obsidian live-preview 式阅读/编辑合一:文档按块渲染,点击某块 →
 * 该块就地变成可编辑的原始 Markdown 源;失焦/Ctrl+S 保存,Esc 取消。
 *
 * 保存语义:整篇原文按块替换(meta.toFull 把 body 偏移映射回原文偏移),
 * 不引入私有格式——写回磁盘的就是标准 Markdown(/)。
 */

export interface EditableMarkdownProps {
  /** meta.body:去掉 frontmatter 与首 H1 的正文(编辑渲染用)。 */
  content: string;
  /** 原始整篇 Markdown(保存时按块替换用)。 */
  fullContent: string;
  /** body 偏移 → 原文偏移(markdown-meta 的 toFull)。 */
  toFull: (offset: number) => number;
  /** 保存整篇原文;返回结果决定编辑态去留。 */
  onSave: (fullContent: string) => Promise<'saved' | 'conflict' | 'error'>;
  onEditStateChange: (editing: boolean) => void;
}

/** 参与就地编辑的块级标签(行内元素不包,防误触)。 */
const BLOCK_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'table',
  'hr',
  'div',
];

interface BlockWrapProps extends HTMLAttributes<HTMLElement> {
  tag: string;
  node?: unknown;
  children?: ReactNode;
  fullContent: string;
  toFull: (offset: number) => number;
  onSave: (fullContent: string) => Promise<'saved' | 'conflict' | 'error'>;
  onEditStateChange: (editing: boolean) => void;
}

function nodeOffset(node: unknown, side: 'start' | 'end'): number | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const position = (
    node as { position?: { start?: { offset?: number }; end?: { offset?: number } } }
  ).position;
  return position?.[side]?.offset;
}

/**
 * 块包裹:位置齐全 → 包编辑外壳(点击进编辑);任一偏移缺失(插件合成节点)
 * → 纯渲染,不包编辑。
 */
function BlockWrap({
  tag,
  node,
  children,
  fullContent,
  toFull,
  onSave,
  onEditStateChange,
  ...rest
}: BlockWrapProps): JSX.Element {
  const startOffset = nodeOffset(node, 'start');
  const endOffset = nodeOffset(node, 'end');
  const hasPosition = startOffset !== undefined && endOffset !== undefined;
  // 原文偏移:body 偏移经 toFull 映射(含 frontmatter 与 H1 切除补偿)。
  const start = hasPosition ? toFull(startOffset) : 0;
  const end = hasPosition ? toFull(endOffset) : 0;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const savingRef = useRef(false);
  const cancelledRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // autoFocus 禁用(无障碍);编辑态挂载后手动聚焦。
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const exitEdit = (): void => {
    setEditing(false);
    onEditStateChange(false);
  };

  const beginEdit = (): void => {
    // 用户正在划选(划线/问 AI 流程)→ 不进入编辑。
    if (window.getSelection()?.toString()) return;
    setDraft(fullContent.slice(start, end));
    setEditing(true);
    onEditStateChange(true);
  };

  const commit = async (): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const newFull = fullContent.slice(0, start) + draft + fullContent.slice(end);
      const outcome = await onSave(newFull);
      // 'error' → 保留编辑态与 draft(App 的 commandNotice 已提示原因,可重试)。
      if (outcome === 'saved' || outcome === 'conflict') exitEdit();
    } finally {
      savingRef.current = false;
    }
  };

  const cancel = (): void => {
    cancelledRef.current = true;
    exitEdit();
  };

  if (editing) {
    return (
      <div className="md-block" data-block-start={start} data-block-end={end}>
        <textarea
          className="md-edit-input"
          value={draft}
          rows={draft.split('\n').length}
          ref={textareaRef}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (!cancelledRef.current) void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            } else if ((event.ctrlKey || event.metaKey) && event.key === 's') {
              event.preventDefault();
              void commit();
            }
          }}
        />
      </div>
    );
  }

  if (!hasPosition) {
    return createElement(tag, rest, children);
  }

  // 整块可点击进入编辑;块内是 h1/p/ul 等块级内容,button 内容模型(phrasing)不允许,
  // 故用 div + role/tabIndex/onKeyDown 提供等效键盘可达。
  return (
    // biome-ignore lint/a11y/useSemanticElements: 块级内容不能放入 button
    <div
      className="md-block"
      data-block-start={start}
      data-block-end={end}
      role="button"
      tabIndex={0}
      onClick={beginEdit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          beginEdit();
        }
      }}
    >
      {createElement(tag, rest, children)}
    </div>
  );
}

export function EditableMarkdown({
  content,
  fullContent,
  toFull,
  onSave,
  onEditStateChange,
}: EditableMarkdownProps): JSX.Element {
  const components = useMemoComponents(fullContent, toFull, onSave, onEditStateChange);
  // key=fullContent:文件切换/保存后整树重挂,清掉任何残留编辑态。
  return (
    <ReactMarkdown
      key={fullContent}
      remarkPlugins={documentRemarkPlugins}
      rehypePlugins={documentRehypePlugins}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}

function useMemoComponents(
  fullContent: string,
  toFull: (offset: number) => number,
  onSave: (fullContent: string) => Promise<'saved' | 'conflict' | 'error'>,
  onEditStateChange: (editing: boolean) => void,
): Components {
  return useMemo(() => {
    const wrapped: Record<string, unknown> = { ...documentComponents };
    for (const tag of BLOCK_TAGS) {
      wrapped[tag] = (props: { node?: unknown } & HTMLAttributes<HTMLElement>): JSX.Element => (
        <BlockWrap
          tag={tag}
          fullContent={fullContent}
          toFull={toFull}
          onSave={onSave}
          onEditStateChange={onEditStateChange}
          {...props}
        />
      );
    }
    return wrapped as Components;
  }, [fullContent, toFull, onSave, onEditStateChange]);
}
