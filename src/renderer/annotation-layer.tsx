import type { JSX, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { Annotation, AnnotationDraft } from '../shared/annotations';

/**
 * 文本锚点定位 + 高亮注入(md/code/PDF 共用)。
 * 原理:在容器 DOM 的文本节点拼接串中精确匹配 before+text+after,
 * 命中后把 Range 内容包进 <mark class="annotation-hl" data-ann-id>。
 * 失配(原文已编辑)降级为不渲染高亮——列表仍可读,不崩。
 */

export interface TextAnchor {
  before: string;
  after: string;
  text: string;
}

/**
 * 同位置划线检测(Office 式开关):相同 kind + 相同锚点 = 同一划线。
 * 用于「再次高亮 = 取消」:命中则移除,不命中才新增(杜绝色块叠加)。
 * 文本锚点要求 before/after 完全一致 —— 同一选区计算出的锚点确定相同,
 * 不同位置的同文本因上下文不同不会误判。
 */
export function findOverlappingAnnotation(
  annotations: Annotation[],
  draft: Pick<AnnotationDraft, 'kind' | 'text' | 'anchor'>,
): Annotation | undefined {
  return annotations.find((a) => {
    if (a.kind !== draft.kind) return false;
    const target = draft.anchor;
    if (a.anchor.type !== target.type) return false;
    switch (target.type) {
      case 'cfi':
        return a.anchor.type === 'cfi' && a.anchor.cfi === target.cfi;
      case 'pdf':
        return (
          a.anchor.type === 'pdf' &&
          a.anchor.page === target.page &&
          a.anchor.before === target.before &&
          a.anchor.after === target.after &&
          a.text === draft.text
        );
      default:
        return (
          a.anchor.type === 'text' &&
          a.anchor.before === target.before &&
          a.anchor.after === target.after &&
          a.text === draft.text
        );
    }
  });
}

/** 在容器拼接文本中定位锚点,返回对应 Range(供包裹 mark);找不到 → null。 */
export function matchTextAnchor(container: HTMLElement, anchor: TextAnchor): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let full = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    nodes.push(t);
    full += t.data;
  }
  const needle = `${anchor.before}${anchor.text}${anchor.after}`;
  if (!needle) return null;
  // before/after 仅用于消歧定位;高亮 Range 只覆盖选区文本本身。
  const needleAt = full.indexOf(needle);
  if (needleAt < 0) return null;
  const start = needleAt + anchor.before.length;
  const end = start + anchor.text.length;

  let acc = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;
  for (const t of nodes) {
    const next = acc + t.data.length;
    if (!startNode && start >= acc && start <= next) {
      startNode = t;
      startOff = start - acc;
    }
    if (!endNode && end <= next) {
      endNode = t;
      endOff = end - acc;
    }
    acc = next;
    if (startNode && endNode) break;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

/** 在容器拼接文本中定位 selText,取前后各 len 字符作为消歧锚点(选区创建时调用)。 */
export function anchorAround(container: HTMLElement, selText: string, len = 50): TextAnchor {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let full = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    full += (node as Text).data;
  }
  const idx = full.indexOf(selText);
  if (idx < 0) return { before: '', after: '', text: '' };
  return {
    before: full.slice(Math.max(0, idx - len), idx),
    after: full.slice(idx + selText.length, idx + selText.length + len),
    text: selText,
  };
}

interface AnnotationLayerProps {
  children: ReactNode;
  annotations: Annotation[];
  /** 未命中的标注 id(原文已变更);不传则忽略。 */
  onStale?: (ids: string[]) => void;
}

/**
 * 文档内容高亮注入层:每次 children/annotations 变化后先清除残留 mark,
 * 再对每条 md/code 标注做锚点匹配并包裹 <mark>。React 重渲染后自动重跑。
 */
export function AnnotationLayer({
  children,
  annotations,
  onStale,
}: AnnotationLayerProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // 1. 移除上次注入的 mark(文本节点还原,保证重新匹配基于原始文本)。
    for (const mark of Array.from(root.querySelectorAll('mark[data-ann-id]'))) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    }
    // 2. 逐条匹配注入;跨节点/失配等异常情况降级跳过。
    const stale: string[] = [];
    for (const ann of annotations) {
      if (ann.kind !== 'md' && ann.kind !== 'code') continue;
      const anchor = ann.anchor;
      if (anchor.type !== 'text') continue;
      const range = matchTextAnchor(root, {
        before: anchor.before,
        after: anchor.after,
        text: ann.text,
      });
      if (!range) {
        stale.push(ann.id);
        continue;
      }
      const mark = document.createElement('mark');
      mark.className = 'annotation-hl';
      mark.dataset.annId = ann.id;
      try {
        const fragment = range.cloneContents();
        range.deleteContents();
        mark.appendChild(fragment);
        range.insertNode(mark);
      } catch {
        stale.push(ann.id);
      }
    }
    onStale?.(stale);
  }, [children, annotations, onStale]);

  return (
    <div ref={rootRef} className="annotation-layer">
      {children}
    </div>
  );
}
