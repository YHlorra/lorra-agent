import { Highlighter, MessageSquare, StickyNote, X } from 'lucide-react';
import type { CSSProperties, JSX, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useT } from './lib/i18n';

/**
 * 阅读态选区工具条(照抄 qmreader-books selection-toolbar 交互模型):
 * 选区出现 → 浮动条「高亮 / 笔记 / 问 AI / 关闭」。
 *
 * 两种驱动模式:
 * - 同文档模式(md/code/PDF):监听 window mouseup,anchorNode 落在容器内时自显,
 * 跟随选区 rect 定位;滚动/点击别处/Esc 关闭。
 * - 受控模式(EPUB iframe):宿主经 `controlled` 传入可见性与文本,
 * 不传 rect 时定位在阅读区顶部居中(epubjs 不提供选区坐标)。
 */

export interface SelectionToolbarProps {
  /** 同文档模式必填:选区 anchorNode 必须落在这个容器内才显示。 */
  containerRef?: RefObject<HTMLElement | null>;
  /** 受控模式(EPUB/PDF 宿主驱动):{ visible, text, rect? }。 */
  controlled?: { visible: boolean; text: string; rect?: DOMRect | null };
  onHighlight: (text: string) => void;
  /** 笔记保存回调(含笔记正文)。 */
  onNote: (text: string, note: string) => void;
  onAskAi: (text: string) => void;
  /** 关闭:同文档模式自动清除选区;宿主需清自身状态。 */
  onClose: () => void;
}

export function SelectionToolbar({
  containerRef,
  controlled,
  onHighlight,
  onNote,
  onAskAi,
  onClose,
}: SelectionToolbarProps): JSX.Element | null {
  const t = useT();
  const [selfVisible, setSelfVisible] = useState(false);
  const [selfText, setSelfText] = useState('');
  const [selfRect, setSelfRect] = useState<DOMRect | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [note, setNote] = useState('');
  const toolbarRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // 笔记弹层打开时聚焦 textarea(jsdom 友好,不用 autoFocus 属性)。
  useEffect(() => {
    if (noteMode) noteRef.current?.focus();
  }, [noteMode]);

  const visible = controlled ? controlled.visible : selfVisible;
  const text = controlled ? controlled.text : selfText;
  const rect = controlled ? (controlled.rect ?? null) : selfRect;

  // 同文档模式:选区检测 + 关闭行为(md/code/PDF 共用)。
  useEffect(() => {
    if (controlled) return;
    const container = containerRef?.current;
    if (!container) return;

    function detect(): void {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelfVisible(false);
        setNoteMode(false);
        return;
      }
      const anchor = sel.anchorNode;
      if (!anchor) return;
      const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element);
      if (!el?.closest('.document-content')) {
        setSelfVisible(false);
        setNoteMode(false);
        return;
      }
      const t = sel.toString().trim();
      if (!t) {
        setSelfVisible(false);
        setNoteMode(false);
        return;
      }
      const range = sel.getRangeAt(0);
      setSelfText(t);
      // jsdom 无 Range.getBoundingClientRect;缺失时退化为顶部居中定位。
      if (typeof range.getBoundingClientRect === 'function') {
        setSelfRect(range.getBoundingClientRect());
      } else {
        setSelfRect(null);
      }
      setSelfVisible(true);
      // 不动 noteMode:点「笔记」后的 mouseup 重检测不应关闭笔记弹层。
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      setSelfVisible(false);
      setNoteMode(false);
      window.getSelection()?.removeAllRanges();
    }
    function onScroll(): void {
      setSelfVisible(false);
      setNoteMode(false);
    }
    function onDocMouseDown(e: MouseEvent): void {
      if (toolbarRef.current?.contains(e.target as Node)) return;
      setSelfVisible(false);
      setNoteMode(false);
    }
    // 延迟一拍等浏览器选区稳定(mouseup 时 range 尚未最终化)。
    // 工具条内的交互不重算选区:点击按钮本身会使选区坍缩,不能因此关闭自身。
    function onMouseUp(e: MouseEvent): void {
      if (toolbarRef.current?.contains(e.target as Node)) return;
      window.setTimeout(detect, 0);
    }

    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [controlled, containerRef]);

  if (!visible || !text) return null;

  const style: CSSProperties = rect
    ? {
        position: 'fixed',
        top: Math.max(8, rect.top - 46),
        left: `clamp(8px, ${rect.left + rect.width / 2}px, calc(100vw - 256px))`,
        transform: 'translateX(-50%)',
      }
    : { position: 'fixed', top: 56, left: '50%', transform: 'translateX(-50%)' };

  function handleClose(): void {
    setSelfVisible(false);
    setNoteMode(false);
    setNote('');
    if (!controlled) window.getSelection()?.removeAllRanges();
    onClose();
  }

  /** 动作完成后收尾:执行回调 + 清选区隐藏(qmreader saveHighlight 同款)。 */
  function finishAction(action: () => void): void {
    action();
    setSelfVisible(false);
    setNoteMode(false);
    setNote('');
    if (!controlled) window.getSelection()?.removeAllRanges();
  }

  function handleSaveNote(): void {
    finishAction(() => onNote(text, note.trim()));
  }

  return (
    <div
      ref={toolbarRef}
      className={`selection-toolbar${noteMode ? ' has-note' : ''}`}
      style={style}
      role="toolbar"
      aria-label={t('selectionToolbar.label')}
    >
      {noteMode ? (
        <div className="note-popover" role="dialog" aria-label={t('selectionToolbar.addNote')}>
          <textarea
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('selectionToolbar.notePlaceholder')}
            rows={3}
            aria-label={t('selectionToolbar.noteContent')}
          />
          <div className="note-popover-actions">
            <button
              type="button"
              className="note-save"
              disabled={!note.trim()}
              onClick={handleSaveNote}
            >
              {t('selectionToolbar.save')}
            </button>
            <button type="button" className="note-cancel" onClick={handleClose}>
              {t('selectionToolbar.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => finishAction(() => onHighlight(text))}
            aria-label={t('selectionToolbar.highlight')}
          >
            <Highlighter size={15} aria-hidden="true" />
            {t('selectionToolbar.highlight')}
          </button>
          <button
            type="button"
            onClick={() => {
              setNoteMode(true);
            }}
            aria-label={t('selectionToolbar.note')}
          >
            <StickyNote size={15} aria-hidden="true" />
            {t('selectionToolbar.note')}
          </button>
          <button
            type="button"
            onClick={() => finishAction(() => onAskAi(text))}
            aria-label={t('selectionToolbar.askAi')}
          >
            <MessageSquare size={15} aria-hidden="true" />
            {t('selectionToolbar.askAi')}
          </button>
          <button
            type="button"
            className="toolbar-close"
            onClick={handleClose}
            aria-label={t('selectionToolbar.close')}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
