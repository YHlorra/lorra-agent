import { ChevronLeft, ChevronRight, Highlighter, RotateCcw } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/app-store';
import type { Annotation, AnnotationDraft } from '../shared/annotations';
import { findOverlappingAnnotation } from './annotation-layer';
import { AnnotationPanel } from './annotation-panel';
import { useT } from './lib/i18n';
import { SelectionToolbar } from './selection-toolbar';

/**
 * EPUB 阅读器(epubjs,分页流式):选中文字 → 顶部居中浮动工具条
 * → 高亮(epubjs annotations.highlight,CFI 锚点)/笔记/问 AI。
 * 交互模型照抄 qmreader-books reader-app.tsx。
 */

interface EpubViewerProps {
  fileId: string;
  annotations: Annotation[];
  onAnnotate: (draft: AnnotationDraft) => void;
  onRemoveAnnotation: (id: string) => void;
  onAskAi: (text: string) => void;
}

interface EpubSelection {
  cfi: string;
  text: string;
}

// epubjs 自带类型(types/rendition.d.ts 等),但标注方法签名松散;
// 这里按实际用法声明最小面,避免逐处 any。
type ThemesLike = {
  register(name: string, rules: Record<string, string>): void;
  select(name: string): void;
  /** 恢复书自带样式(epubjs themes.default,实参为 theme 名/对象)。 */
  default(...args: unknown[]): void;
};

type RenditionLike = {
  on(event: 'relocated', cb: (location: { start?: { href?: string } }) => void): void;
  on(event: 'selected', cb: (cfi: string, contents: { window?: Window }) => void): void;
  annotations: {
    highlight(
      cfiRange: string,
      data: Record<string, unknown>,
      cb?: () => void,
      className?: string,
      styles?: object,
    ): void;
    remove(cfiRange: string, type: string): void;
  };
  themes?: ThemesLike;
  getContents(): unknown;
  display(target?: string): Promise<unknown>;
  prev(): Promise<void>;
  next(): Promise<void>;
  destroy(): void;
  /** 渲染队列(rAF 驱动;隐藏窗口下需要降级 tick,见加载处注释)。 */
  q?: { tick?: (cb: () => void) => void };
  manager?: { q?: { tick?: (cb: () => void) => void } };
};

type BookLike = {
  ready: Promise<unknown>;
  renderTo(element: HTMLElement, options: Record<string, unknown>): RenditionLike;
  destroy(): void;
};

/**
 * 高亮填充:epubjs 用 marks-pane 在内容上方画 SVG rect,fill-opacity 必须
 * 半透明,否则不透明矩形会盖住文字(qmreader 用 0.42;曾误设 1.0 导致
 * 「高亮后文字消失」)。浅色 multiply 与纸面融合;深色直接半透明黄。
 */
function fillFor(theme: string): Record<string, string> {
  return theme === 'dark'
    ? { fill: 'rgb(255, 215, 100)', 'fill-opacity': '0.3' }
    : { fill: '#f5e59c', 'fill-opacity': '0.45', 'mix-blend-mode': 'multiply' };
}

/** 章节名:取自 relocated href 的文件名(qmreader 用 TOC 标签,这里简化)。 */
function chapterFromHref(href: string, fallback: string): string {
  const name = href.split('/').pop() ?? '';
  const base = name.replace(/\.[^.]+$/, '');
  return base || fallback;
}

export function EpubViewer({
  fileId,
  annotations,
  onAnnotate,
  onRemoveAnnotation,
  onAskAi,
}: EpubViewerProps): JSX.Element {
  const t = useT();
  const theme = useAppStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  // 主题注册完成标记:加载 effect 内 register 后才允许 theme effect select(防时序缺口)。
  const themesReadyRef = useRef(false);
  const renditionRef = useRef<RenditionLike | null>(null);
  const bookRef = useRef<BookLike | null>(null);
  // 已回放高亮的 id → cfi,增量回放 + 删除清理用。
  const highlightedRef = useRef<Map<string, string>>(new Map());
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [chapter, setChapter] = useState(() => t('epub.locatingChapter'));
  const [selection, setSelection] = useState<EpubSelection | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const jumpNoticeTimer = useRef<number | null>(null);

  const showJumpNotice = useCallback((message: string) => {
    setJumpNotice(message);
    if (jumpNoticeTimer.current) window.clearTimeout(jumpNoticeTimer.current);
    jumpNoticeTimer.current = window.setTimeout(() => setJumpNotice(null), 2500);
  }, []);

  // 加载 + 事件接线 + 初始标注回放。
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError('');
    setSelection(null);
    highlightedRef.current = new Map();

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
        // 动态 import:epubjs 只在此格式下进包,避免主包膨胀。
        const { default: ePub } = await import('epubjs');
        // epubjs 构造函数只认 string | ArrayBuffer(Uint8Array 会被当 options);
        // ArrayBuffer 必须 openAs:'binary' —— 'epub' 走 URL request 路径会挂起。
        const epubInput = new Uint8Array(res.value.data).buffer;
        const book = ePub(epubInput, { openAs: 'binary' }) as BookLike;
        bookRef.current = book;
        await book.ready;
        if (cancelled) return;
        const container = containerRef.current;
        if (!container) return;
        const rendition = book.renderTo(container, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: 'auto',
        });
        // 窗口隐藏(远程/虚拟显示、最小化)时 Chromium 冻结 rAF,epubjs 渲染队列
        // (Queue.tick = requestAnimationFrame)会永久挂起 → 队列降级 setTimeout。
        const queueTick = (cb: () => void): void => {
          window.setTimeout(cb, 16);
        };
        if (rendition.q) rendition.q.tick = queueTick;
        if (rendition.manager?.q) rendition.manager.q.tick = queueTick;
        renditionRef.current = rendition;

        // 深浅主题注入(2026-08-13):epubjs 默认白纸书页,深色壳下刺眼割裂。
        // register 深色主题后按当前偏好 select;主题切换由下方 effect 再 select。
        rendition.themes?.register('lorra-dark', {
          body: 'background: #26231d !important; color: #d8d4c8 !important;',
          'a, a:link, a:visited': 'color: #6e9acb !important;',
          'h1, h2, h3, h4, h5, h6': 'color: #edeae3 !important;',
          img: 'filter: brightness(.85);',
        });
        themesReadyRef.current = true;
        if (theme === 'dark') rendition.themes?.select('lorra-dark');

        rendition.on('relocated', (location) => {
          const loc = location as { start?: { href?: string } };
          setChapter(chapterFromHref(loc.start?.href ?? '', t('epub.bodyText')));
        });
        rendition.on('selected', (cfi, contents) => {
          const c = contents as { window?: Window };
          const text = c.window?.getSelection()?.toString().trim() ?? '';
          if (text) setSelection({ cfi: cfi as string, text });
          c.window?.getSelection()?.removeAllRanges();
        });

        for (const ann of annotations) {
          if (ann.kind !== 'epub' || ann.anchor.type !== 'cfi') continue;
          try {
            rendition.annotations.highlight(
              ann.anchor.cfi,
              {},
              undefined,
              'annotation-hl',
              fillFor(theme),
            );
            highlightedRef.current.set(ann.id, ann.anchor.cfi);
          } catch {
            // CFI 失效(章节被删) → 降级:列表仍可读,不渲染高亮
          }
        }
        await rendition.display();
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
      themesReadyRef.current = false;
      renditionRef.current?.destroy();
      bookRef.current?.destroy();
      renditionRef.current = null;
      bookRef.current = null;
    };
    // 仅 fileId/reloadKey 触发重载;标注与主题变化走下面的增量回放 effect,
    // 避免每次划线都销毁重建整本书(丢阅读位置)。
  }, [fileId, reloadKey]);

  // 主题切换 → 书内页面同步(注册已在加载 effect 内完成;未就绪时跳过,
  // 加载 effect 已按当时的 theme 做过初始 select)。
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition?.themes || !themesReadyRef.current) return;
    if (theme === 'dark') rendition.themes.select('lorra-dark');
    else rendition.themes.default();
  }, [theme, status]);

  // 增量回放:annotations 变化(新高亮/删除)时同步 iframe 内 mark。
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition || status !== 'ready') return;
    const live = new Set(annotations.map((a) => a.id));
    // 新增
    for (const ann of annotations) {
      if (ann.kind !== 'epub' || ann.anchor.type !== 'cfi') continue;
      if (highlightedRef.current.has(ann.id)) continue;
      try {
        rendition.annotations.highlight(
          ann.anchor.cfi,
          {},
          undefined,
          'annotation-hl',
          fillFor(theme),
        );
        highlightedRef.current.set(ann.id, ann.anchor.cfi);
      } catch {
        // 同上:降级跳过
      }
    }
    // 删除:按 cfi 移除 epubjs 标注 + 手动 unwrap iframe 内同名 mark(尽力而为)。
    for (const [id, cfi] of highlightedRef.current) {
      if (live.has(id)) continue;
      highlightedRef.current.delete(id);
      try {
        rendition.annotations.remove(cfi, 'highlight');
      } catch {
        // ignore:best-effort
      }
    }
  }, [annotations, status, theme]);

  const buildDraft = useCallback(
    (text: string, note?: string): AnnotationDraft | null => {
      if (!selection) return null;
      return {
        id: crypto.randomUUID(),
        kind: 'epub',
        text: text.length > 500 ? `${text.slice(0, 500)}…` : text,
        note,
        anchor: { type: 'cfi', cfi: selection.cfi },
        createdAt: new Date().toISOString(),
      };
    },
    [selection],
  );

  // Office 式开关:同 CFI 再次「高亮」= 取消(移除),杜绝色块叠加。
  const handleHighlight = useCallback(
    (text: string) => {
      const draft = buildDraft(text);
      if (!draft) return;
      const existing = findOverlappingAnnotation(annotations, draft);
      if (existing) {
        onRemoveAnnotation(existing.id);
        setSelection(null);
        return;
      }
      onAnnotate(draft);
      setSelection(null);
    },
    [buildDraft, onAnnotate, onRemoveAnnotation, annotations],
  );

  // 笔记:已有划线则更新 note(同 id upsert),否则新建带笔记的划线。
  const handleNote = useCallback(
    (text: string, note: string) => {
      const draft = buildDraft(text, note);
      if (!draft) return;
      const existing = findOverlappingAnnotation(annotations, draft);
      if (existing) {
        onAnnotate({ ...draft, id: existing.id });
        setSelection(null);
        return;
      }
      onAnnotate(draft);
      setSelection(null);
    },
    [buildDraft, onAnnotate, annotations],
  );

  const handleAskAi = useCallback(
    (text: string) => {
      onAskAi(text);
      setSelection(null);
    },
    [onAskAi],
  );

  const jumpToAnnotation = useCallback(
    (id: string) => {
      const ann = annotations.find((a) => a.id === id);
      const rendition = renditionRef.current;
      if (ann?.anchor.type !== 'cfi' || !rendition) {
        showJumpNotice(t('doc.annotationJumpFailed'));
        return;
      }
      void rendition.display(ann.anchor.cfi).catch(() => {
        showJumpNotice(t('doc.annotationJumpFailed'));
      });
    },
    [annotations, showJumpNotice, t],
  );

  const goPage = useCallback((dir: 'prev' | 'next') => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    const p = dir === 'prev' ? rendition.prev() : rendition.next();
    void p.catch(() => {
      // 已到首/末页:忽略
    });
  }, []);

  if (status === 'error') {
    return (
      <div className="viewer-error" role="alert">
        <p>{t('epub.renderFailed')}</p>
        <p className="viewer-error-detail">{error}</p>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
          <RotateCcw size={14} aria-hidden="true" /> {t('epub.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="epub-viewer">
      <div className="epub-toolbar">
        <button
          type="button"
          onClick={() => goPage('prev')}
          aria-label={t('epub.prevPage')}
          disabled={status !== 'ready'}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <span className="epub-chapter">{chapter}</span>
        <button
          type="button"
          onClick={() => goPage('next')}
          aria-label={t('epub.nextPage')}
          disabled={status !== 'ready'}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
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
      {status === 'loading' ? <p className="viewer-loading">{t('epub.loading')}</p> : null}
      <div className="epub-viewport" ref={containerRef} />
      <SelectionToolbar
        controlled={
          selection ? { visible: true, text: selection.text } : { visible: false, text: '' }
        }
        onHighlight={handleHighlight}
        onNote={handleNote}
        onAskAi={handleAskAi}
        onClose={() => setSelection(null)}
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
