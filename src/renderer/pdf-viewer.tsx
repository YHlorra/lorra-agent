import { Highlighter, RotateCcw } from 'lucide-react';
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  TextLayer,
} from 'pdfjs-dist';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, AnnotationDraft } from '../shared/annotations';
import { anchorAround, findOverlappingAnnotation, matchTextAnchor } from './annotation-layer';
import { AnnotationPanel } from './annotation-panel';
import { useT } from './lib/i18n';
import { createPdfWorkerPort, loadPdfWorkerUrl } from './pdf-worker';
import { SelectionToolbar } from './selection-toolbar';

/**
 * PDF 阅读器(pdfjs-dist v6):canvas 渲染 + TextLayer 文本层。
 * 划线 = 在文本层 span 上注入 <mark class="annotation-hl">(与 md/code 同一
 * mark 类名与配色);选区工具条复用 SelectionToolbar(跟随选区 rect)。
 */

interface PdfViewerProps {
  fileId: string;
  annotations: Annotation[];
  onAnnotate: (draft: AnnotationDraft) => void;
  onRemoveAnnotation: (id: string) => void;
  onAskAi: (text: string) => void;
}

interface PdfSelection {
  text: string;
  page: number;
  rect: DOMRect | null;
}

const RENDER_SCALE = 1.4;

export function PdfViewer({
  fileId,
  annotations,
  onAnnotate,
  onRemoveAnnotation,
  onAskAi,
}: PdfViewerProps): JSX.Element {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // 已渲染页:pageNum → 文本层元素(标注回放/跳转用)。
  const pageLayersRef = useRef<Map<number, HTMLElement>>(new Map());
  const workerModeRef = useRef<'url' | 'port'>('url');
  const annotationsRef = useRef(annotations);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [selection, setSelection] = useState<PdfSelection | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const jumpNoticeTimer = useRef<number | null>(null);

  // 标注最新值给懒渲染回调(避免闭包过期)。
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  const showJumpNotice = useCallback((message: string) => {
    setJumpNotice(message);
    if (jumpNoticeTimer.current) window.clearTimeout(jumpNoticeTimer.current);
    jumpNoticeTimer.current = window.setTimeout(() => setJumpNotice(null), 2500);
  }, []);

  /** 该页文本层内重放/刷新高亮 mark(先清除残留,再按锚点注入)。 */
  const applyPageAnnotations = useCallback((pageNum: number): void => {
    const layer = pageLayersRef.current.get(pageNum);
    if (!layer) return;
    for (const mark of Array.from(layer.querySelectorAll('mark[data-ann-id]'))) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    }
    for (const ann of annotationsRef.current) {
      if (ann.kind !== 'pdf' || ann.anchor.type !== 'pdf' || ann.anchor.page !== pageNum) continue;
      const range = matchTextAnchor(layer, {
        before: ann.anchor.before,
        after: ann.anchor.after,
        text: ann.text,
      });
      if (!range) continue; // 原文已变更 → 降级跳过
      const mark = document.createElement('mark');
      mark.className = 'annotation-hl';
      mark.dataset.annId = ann.id;
      try {
        const fragment = range.cloneContents();
        range.deleteContents();
        mark.appendChild(fragment);
        range.insertNode(mark);
      } catch {
        // 跨节点包裹失败 → 降级跳过
      }
    }
  }, []);

  const renderPage = useCallback(
    async (pageNum: number): Promise<void> => {
      const doc = docRef.current;
      const scroll = scrollRef.current;
      if (!doc || !scroll || pageLayersRef.current.has(pageNum)) return;
      const slot = scroll.querySelector(`.pdf-page-slot[data-page-number="${pageNum}"]`);
      if (!(slot instanceof HTMLElement)) return;
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const textLayer = document.createElement('div');
      textLayer.className = 'annotation-text-layer';
      // v6 TextLayer 用 --total-scale-factor 计算容器尺寸;与渲染 scale 对齐。
      textLayer.style.setProperty('--total-scale-factor', String(RENDER_SCALE));
      textLayer.style.setProperty('--scale-round-x', '1px');
      textLayer.style.setProperty('--scale-round-y', '1px');
      slot.append(canvas, textLayer);
      const textContent = await page.getTextContent();
      const layer = new TextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport,
      });
      await layer.render();
      pageLayersRef.current.set(pageNum, textLayer);
      applyPageAnnotations(pageNum);
    },
    [applyPageAnnotations],
  );

  // 加载 + worker 初始化(?url 主方案,失败切 workerPort 重试一次)。
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError('');
    setSelection(null);
    pageLayersRef.current = new Map();

    async function start(): Promise<void> {
      try {
        const res = await window.lorra.fs.openBinary({ fileId });
        if (!res.ok) {
          if (!cancelled) {
            setStatus('error');
            setError(res.error.message);
          }
          return;
        }
        let doc: PDFDocumentProxy;
        try {
          if (workerModeRef.current === 'url') {
            if (!GlobalWorkerOptions.workerSrc) {
              GlobalWorkerOptions.workerSrc = await loadPdfWorkerUrl();
            }
          }
          const task = getDocument({ data: res.value.data });
          taskRef.current = task;
          doc = await task.promise;
        } catch (err) {
          // Electron file:// 下 ?url worker 被拦 → 切内联 workerPort 重试。
          if (workerModeRef.current === 'url') {
            workerModeRef.current = 'port';
            GlobalWorkerOptions.workerPort = await createPdfWorkerPort();
            const task = getDocument({ data: res.value.data });
            taskRef.current = task;
            doc = await task.promise;
          } else {
            throw err;
          }
        }
        if (cancelled) return;
        docRef.current = doc;
        setPageCount(doc.numPages);
        const scroll = scrollRef.current;
        if (!scroll) return;
        // 只清自己的页占位(React 同时管理 scroll 内的加载态 <p>,不能动 innerHTML)。
        for (const old of scroll.querySelectorAll('.pdf-page-slot')) {
          old.remove();
        }
        for (let p = 1; p <= doc.numPages; p++) {
          const slot = document.createElement('div');
          slot.className = 'pdf-page-slot';
          slot.dataset.pageNumber = String(p);
          scroll.appendChild(slot);
        }
        observerRef.current?.disconnect();
        observerRef.current = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const num = Number((entry.target as HTMLElement).dataset.pageNumber);
              void renderPage(num);
            }
          },
          { root: scroll, rootMargin: '300px 0px' },
        );
        for (const slot of scroll.querySelectorAll('.pdf-page-slot')) {
          observerRef.current.observe(slot);
        }
        if (!cancelled) setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
      observerRef.current?.disconnect();
      observerRef.current = null;
      taskRef.current?.destroy();
      taskRef.current = null;
      docRef.current = null;
    };
  }, [fileId, reloadKey, renderPage]);

  // 标注变化 → 已渲染页刷新 mark(新增/删除/笔记更新都走重放)。
  useEffect(() => {
    for (const pageNum of pageLayersRef.current.keys()) {
      applyPageAnnotations(pageNum);
    }
  }, [annotations, applyPageAnnotations]);

  // 滚动时更新当前页指示。
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onScroll = (): void => {
      const slots = Array.from(scroll.querySelectorAll('.pdf-page-slot'));
      let current = 0;
      for (const slot of slots) {
        if (!(slot instanceof HTMLElement)) continue;
        const rect = slot.getBoundingClientRect();
        if (rect.top <= window.innerHeight / 2) {
          current = Number(slot.dataset.pageNumber) || 0;
        }
      }
      setCurrentPage(current);
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, [status]);

  // 文本层内选区 → 浮动工具条(跟随选区 rect)。
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onMouseUp = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.annotation-text-layer')) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString().trim();
      if (!text) return;
      const pageEl = target.closest('[data-page-number]');
      if (!(pageEl instanceof HTMLElement)) return;
      const page = Number(pageEl.dataset.pageNumber);
      if (Number.isNaN(page)) return;
      let rect: DOMRect | null = null;
      const range = sel.getRangeAt(0);
      if (typeof range.getBoundingClientRect === 'function') {
        rect = range.getBoundingClientRect();
      }
      setSelection({ text, page, rect });
    };
    scroll.addEventListener('mouseup', onMouseUp);
    return () => scroll.removeEventListener('mouseup', onMouseUp);
  }, [status]);

  const buildDraft = useCallback(
    (text: string, note?: string): AnnotationDraft | null => {
      if (!selection) return null;
      const layer = pageLayersRef.current.get(selection.page);
      const around = layer ? anchorAround(layer, text) : { before: '', after: '', text: '' };
      return {
        id: crypto.randomUUID(),
        kind: 'pdf',
        text: text.length > 500 ? `${text.slice(0, 500)}…` : text,
        note,
        anchor: { type: 'pdf', page: selection.page, before: around.before, after: around.after },
        createdAt: new Date().toISOString(),
      };
    },
    [selection],
  );

  // Office 式开关:同页同锚点再次「高亮」= 取消。
  const handleHighlight = useCallback(
    (text: string) => {
      const draft = buildDraft(text);
      if (!draft) return;
      const existing = findOverlappingAnnotation(annotationsRef.current, draft);
      if (existing) {
        onRemoveAnnotation(existing.id);
      } else {
        onAnnotate(draft);
      }
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    },
    [buildDraft, onAnnotate, onRemoveAnnotation],
  );

  const handleNote = useCallback(
    (text: string, note: string) => {
      const draft = buildDraft(text, note);
      if (!draft) return;
      const existing = findOverlappingAnnotation(annotationsRef.current, draft);
      if (existing) {
        onAnnotate({ ...draft, id: existing.id });
      } else {
        onAnnotate(draft);
      }
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    },
    [buildDraft, onAnnotate],
  );

  const handleAskAi = useCallback(
    (text: string) => {
      onAskAi(text);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    },
    [onAskAi],
  );

  const jumpToAnnotation = useCallback(
    (id: string) => {
      const ann = annotationsRef.current.find((a) => a.id === id);
      if (ann?.anchor.type !== 'pdf') {
        showJumpNotice(t('doc.annotationJumpFailed'));
        return;
      }
      const slot = scrollRef.current?.querySelector(
        `.pdf-page-slot[data-page-number="${ann.anchor.page}"]`,
      );
      if (!(slot instanceof HTMLElement)) {
        showJumpNotice(t('doc.annotationJumpFailed'));
        return;
      }
      void renderPage(ann.anchor.page)
        .then(() => {
          slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
          const mark = slot.querySelector(`mark[data-ann-id="${id}"]`);
          mark?.classList.add('annotation-flash');
          window.setTimeout(() => mark?.classList.remove('annotation-flash'), 600);
        })
        .catch(() => showJumpNotice(t('doc.annotationJumpFailed')));
    },
    [renderPage, showJumpNotice, t],
  );

  if (status === 'error') {
    return (
      <div className="viewer-error" role="alert">
        <p>{t('pdf.renderFailed')}</p>
        <p className="viewer-error-detail">{error}</p>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
          <RotateCcw size={14} aria-hidden="true" /> {t('pdf.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="pdf-viewer" data-testid="pdf-viewer">
      <div className="pdf-toolbar">
        <span className="pdf-page-indicator">
          {status === 'ready' && pageCount > 0
            ? t('doc.pageIndicator', { current: currentPage || 1, total: pageCount })
            : t('doc.loading')}
        </span>
        <button
          type="button"
          className={`annotation-toggle${panelOpen ? ' is-open' : ''}`}
          aria-label={t('doc.annotationList')}
          aria-pressed={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        >
          <Highlighter size={15} aria-hidden="true" />
          {t('doc.annotate')}
        </button>
      </div>
      {jumpNotice ? (
        <p className="annotation-jump-notice" role="status">
          {jumpNotice}
        </p>
      ) : null}
      <div className="pdf-scroll" ref={scrollRef}>
        {status === 'loading' ? <p className="viewer-loading">{t('pdf.loading')}</p> : null}
      </div>
      <SelectionToolbar
        controlled={
          selection
            ? { visible: true, text: selection.text, rect: selection.rect }
            : { visible: false, text: '' }
        }
        onHighlight={handleHighlight}
        onNote={handleNote}
        onAskAi={handleAskAi}
        onClose={() => {
          window.getSelection()?.removeAllRanges();
          setSelection(null);
        }}
      />
      {panelOpen ? (
        <AnnotationPanel
          annotations={annotations}
          onJump={jumpToAnnotation}
          onRemove={onRemoveAnnotation}
        />
      ) : null}
    </div>
  );
}
