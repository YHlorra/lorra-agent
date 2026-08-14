import { Highlighter } from 'lucide-react';
import type { JSX } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, AnnotationDraft } from '../shared/annotations';
import { AnnotationLayer, anchorAround, findOverlappingAnnotation } from './annotation-layer';
import { AnnotationPanel } from './annotation-panel';
import { EpubViewer } from './epub-viewer';
import { useT } from './lib/i18n';
import { extractMarkdownMeta } from './lib/markdown-meta';
import { EditableMarkdown } from './markdown-editable';
import { PdfViewer } from './pdf-viewer';
import { SelectionToolbar } from './selection-toolbar';

export interface DocumentFileState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  content?: string;
  mtime?: number;
  error?: string;
}

interface DocumentViewerProps {
  file: DocumentFileState;
  fileName: string | null;
  /** 当前文件 id(EPUB/PDF 查看器经 openBinary 读二进制用)。 */
  fileId: string | null;
  /** 当前文件的划线/笔记列表(App 层按 fileId 加载)。 */
  annotations: Annotation[];
  onAnnotate: (draft: AnnotationDraft) => void;
  onRemoveAnnotation: (id: string) => void;
  /** 「问 AI」:把选区文本送入右栏对话(引用胶囊)。 */
  onAskAi: (text: string) => void;
  /** 保存整篇原文(仅 .md);结果决定编辑态去留。 */
  onSaveContent: (content: string) => Promise<'saved' | 'conflict' | 'error'>;
  /** 编辑态变化通知(App 用它守卫 tool.end 自动重取)。 */
  onEditStateChange: (editing: boolean) => void;
}

function isMarkdown(name: string | null): boolean {
  return name ? /\.(md|markdown|mdx)$/i.test(name) : false;
}

function isEpub(name: string | null): boolean {
  return name ? /\.epub$/i.test(name) : false;
}

function isPdf(name: string | null): boolean {
  return name ? /\.pdf$/i.test(name) : false;
}

const MAX_TEXT = 500;

// 中栏文档查看器(design.md .1):.md 走 Markdown 渲染 + 围栏代码高亮,
// 代码文件保留纯文本 pre(.document-content 契约供 e2e 长文档回归)。
// 划线/笔记:选中文字 → 浮动工具条 → 高亮/笔记/问 AI;「划线」按钮开关右侧面板。
export const DocumentViewer = memo(function DocumentViewer({
  file,
  fileName,
  fileId,
  annotations,
  onAnnotate,
  onRemoveAnnotation,
  onAskAi,
  onSaveContent,
  onEditStateChange,
}: DocumentViewerProps): JSX.Element {
  const t = useT();
  const markdown = isMarkdown(fileName);
  const epub = isEpub(fileName);
  const pdf = isPdf(fileName);
  const [panelOpen, setPanelOpen] = useState(false);
  // 跳转失败提示:划线已不在正文(原文被编辑)→ 短暂提示,不做状态持久化。
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  // 编辑/保存状态(阅读编辑合一)。
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLPreElement>(null);
  const jumpNoticeTimer = useRef<number | null>(null);

  // Obsidian 式文档头数据:frontmatter title/tags + 去掉首 H1 的正文。
  const meta = useMemo(
    () =>
      markdown && file.status === 'ready' && file.content
        ? extractMarkdownMeta(file.content)
        : null,
    [markdown, file.status, file.content],
  );

  // 文件切换 → 清编辑态(残留 textarea 不跨文件)。
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    onEditStateChange(false);
  }, [fileId, onEditStateChange]);

  /** 保存包装:置 saving → 委托 App 落盘 → 清 saving,结果原样返回给编辑块。 */
  const saveContent = useCallback(
    async (newFull: string): Promise<'saved' | 'conflict' | 'error'> => {
      setSaving(true);
      try {
        return await onSaveContent(newFull);
      } finally {
        setSaving(false);
      }
    },
    [onSaveContent],
  );

  /** 编辑态:内部(saved-state 文案)与外部(App 的 tool.end 守卫)同步。 */
  const handleEditStateChange = useCallback(
    (editing: boolean) => {
      setEditing(editing);
      onEditStateChange(editing);
    },
    [onEditStateChange],
  );

  const savedStateLabel =
    file.status === 'loading'
      ? t('doc.loading')
      : file.status !== 'ready'
        ? t('doc.noFile')
        : editing
          ? t('doc.editing')
          : saving
            ? t('doc.saving')
            : markdown
              ? t('doc.savedEditable')
              : t('doc.saved');

  const showJumpNotice = useCallback((message: string) => {
    setJumpNotice(message);
    if (jumpNoticeTimer.current) window.clearTimeout(jumpNoticeTimer.current);
    jumpNoticeTimer.current = window.setTimeout(() => setJumpNotice(null), 2500);
  }, []);

  /** 跳转 = 滚动到对应 mark 并闪一下;找不到 → 提示原文已变更。 */
  const jumpToAnnotation = useCallback(
    (id: string) => {
      const mark = articleRef.current?.querySelector(`mark[data-ann-id="${id}"]`);
      if (!mark) {
        showJumpNotice(t('doc.annotationJumpFailed'));
        return;
      }
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      mark.classList.add('annotation-flash');
      window.setTimeout(() => mark.classList.remove('annotation-flash'), 600);
    },
    [showJumpNotice],
  );

  /** 组装 AnnotationDraft:kind 按扩展名 md/code,文本锚点取选区前后各 50 字符。 */
  const buildDraft = useCallback(
    (text: string, note?: string): AnnotationDraft => {
      const root = markdown ? markdownRef.current : codeRef.current;
      const around = root ? anchorAround(root, text) : { before: '', after: '', text: '' };
      return {
        id: crypto.randomUUID(),
        kind: markdown ? 'md' : 'code',
        text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
        note,
        anchor: { type: 'text', before: around.before, after: around.after },
        createdAt: new Date().toISOString(),
      };
    },
    [markdown],
  );

  // Office 式开关:同一段文字再次「高亮」= 取消(移除),杜绝色块叠加。
  const handleHighlight = useCallback(
    (text: string) => {
      const draft = buildDraft(text);
      if (!draft) return;
      const existing = findOverlappingAnnotation(annotations, draft);
      if (existing) {
        onRemoveAnnotation(existing.id);
        return;
      }
      onAnnotate(draft);
    },
    [onAnnotate, onRemoveAnnotation, buildDraft, annotations],
  );
  // 笔记:已有划线则更新 note(同 id upsert),否则新建带笔记的划线。
  const handleNote = useCallback(
    (text: string, note: string) => {
      const draft = buildDraft(text, note);
      if (!draft) return;
      const existing = findOverlappingAnnotation(annotations, draft);
      if (existing) {
        onAnnotate({ ...draft, id: existing.id });
        return;
      }
      onAnnotate(draft);
    },
    [onAnnotate, buildDraft, annotations],
  );

  return (
    <main id="current-document" className="document-pane" aria-label={t('doc.regionLabel')}>
      <header className="document-toolbar">
        {!epub ? (
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
        ) : null}
        <span className="saved-state">{savedStateLabel}</span>
        <button type="button" aria-label={t('doc.moreActions')}>
          •••
        </button>
      </header>
      {jumpNotice ? (
        <p className="annotation-jump-notice" role="status">
          {jumpNotice}
        </p>
      ) : null}
      <article
        ref={articleRef}
        className={`document${epub || pdf ? ' document-reader' : ''}`}
        lang="zh-CN"
      >
        {file.status === 'ready' && file.content ? (
          epub && fileId ? (
            <EpubViewer
              fileId={fileId}
              annotations={annotations}
              onAnnotate={onAnnotate}
              onRemoveAnnotation={onRemoveAnnotation}
              onAskAi={onAskAi}
            />
          ) : pdf && fileId ? (
            <PdfViewer
              fileId={fileId}
              annotations={annotations}
              onAnnotate={onAnnotate}
              onRemoveAnnotation={onRemoveAnnotation}
              onAskAi={onAskAi}
            />
          ) : (
            <>
              {markdown && meta ? (
                <header className="document-hed">
                  <h1 className="document-title">{meta.title ?? fileName}</h1>
                  {meta.tags.length > 0 ? (
                    <ul className="document-tags">
                      {meta.tags.map((tag) => (
                        <li key={tag} className="tag-pill">
                          #{tag}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </header>
              ) : null}
              <AnnotationLayer annotations={annotations}>
                {markdown && meta ? (
                  <div className="document-content" ref={markdownRef}>
                    <EditableMarkdown
                      content={meta.body}
                      fullContent={file.content}
                      toFull={meta.toFull}
                      onSave={saveContent}
                      onEditStateChange={handleEditStateChange}
                    />
                  </div>
                ) : (
                  <pre className="document-content document-plain" ref={codeRef}>
                    {file.content}
                  </pre>
                )}
              </AnnotationLayer>
            </>
          )
        ) : file.status === 'error' ? (
          <p className="document-error" role="alert">
            {file.error}
          </p>
        ) : (
          <p className="document-placeholder">{t('doc.selectFileHint')}</p>
        )}
      </article>
      {!epub ? (
        <SelectionToolbar
          containerRef={articleRef}
          onHighlight={handleHighlight}
          onNote={handleNote}
          onAskAi={onAskAi}
          onClose={() => {}}
        />
      ) : null}
      {!epub && panelOpen ? (
        <AnnotationPanel
          annotations={annotations}
          onJump={jumpToAnnotation}
          onRemove={onRemoveAnnotation}
        />
      ) : null}
    </main>
  );
});
