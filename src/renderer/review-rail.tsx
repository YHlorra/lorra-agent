import { ClipboardCheck, FileText, X } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/app-store';
import { cn } from '@/lib/utils';
import type { LorraError } from '../shared/result';
import type { GenerateArgs, ReviewKind, ReviewMeta, StoredReview } from '../shared/review-api';
import { useT } from './lib/i18n';
import { SafeMarkdown } from './safe-markdown';

/**
 * 复盘栏(agent-memory-today-timeline 前端)。
 * 挂在今日页右栏 rail:今日复盘/本周深度复盘入口 + 历史列表 + 居中 modal 阅读。
 * PM 方向修正(2026-08-08):模块勾选与用户提示词输入均已取消——复盘重点由
 * 技能文件承载,引导用户直接修改 <工作区>/.lorra/skills/daily-review.md 或
 * deep-review.md(修改即时生效)。
 * 视觉对齐 ui-design/today-timeline-v2.html 复盘栏与报告阅读弹窗部分;
 * 数据经 window.lorra.review 只读消费,modal 只读渲染 markdown(SafeMarkdown)。
 */

// IPC 信封:preload 直传 SerializedResult({ok,value}/{ok,error}),消费端按 ok 判别。

function createdTs(meta: ReviewMeta): number {
  const t = new Date(meta.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function ReviewRail(): JSX.Element {
  const setPage = useAppStore((s) => s.setPage);
  const t = useT();
  const kindLabel = (kind: ReviewKind): string =>
    t(kind === 'daily' ? 'review.kind.daily' : 'review.kind.weekly');
  const [reviews, setReviews] = useState<ReviewMeta[] | null>(null);
  const [pendingKind, setPendingKind] = useState<ReviewKind | null>(null);
  const [generateError, setGenerateError] = useState<LorraError | null>(null);
  // modal 阅读态(只读投影)。
  const [modalMeta, setModalMeta] = useState<ReviewMeta | null>(null);
  const [modalContent, setModalContent] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const readingIdRef = useRef<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const res = await window.lorra?.review?.list();
      if (!res) throw new Error(t('review.channelUnavailable'));
      if (res.ok) setReviews(res.value);
    } catch {
      setReviews([]);
    }
  }, [t]);

  // 挂载时只读一次列表(复盘存档持久化,非实时真理源)。
  // 用 useLayoutEffect:今日页 rail 与 timeline 同帧挂载时,确保列表先于
  // 时间线数据提交(先渲染出历史条目,再等今日数据)。
  const didInit = useRef(false);
  useLayoutEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void refreshList();
  }, [refreshList]);

  /** 生成复盘:模型自主判断维度,方法论由技能文件承载;成功 → 刷新列表;失败 → 局部错误提示,列表无半成品。 */
  const generate = useCallback(
    async (kind: ReviewKind) => {
      if (pendingKind !== null) return;
      setPendingKind(kind);
      setGenerateError(null);
      try {
        // 请求形状(PM 方向修正):modules 与 userPrompt 均已移除,只带 kind。
        const req: GenerateArgs = { kind };
        const res = await window.lorra?.review?.generate(req);
        if (!res) throw new Error(t('review.channelUnavailable'));
        if (!res.ok) {
          setGenerateError(res.error);
        } else {
          await refreshList();
        }
      } catch (err) {
        setGenerateError({
          code: 'review-generate-failed',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setPendingKind(null);
      }
    },
    [pendingKind, refreshList, t],
  );

  const readReport = useCallback(
    async (id: string) => {
      readingIdRef.current = id;
      setModalLoading(true);
      setModalError(null);
      try {
        const res = await window.lorra?.review?.read({ id });
        if (!res) throw new Error(t('review.channelUnavailable'));
        if (res.ok) setModalContent(res.value.markdown);
        else setModalError(res.error.message);
      } catch (err) {
        setModalError(err instanceof Error ? err.message : String(err));
      } finally {
        setModalLoading(false);
      }
    },
    [t],
  );

  const openModal = useCallback(
    (meta: ReviewMeta, trigger?: HTMLElement) => {
      triggerRef.current = trigger ?? null;
      setModalMeta(meta);
      setModalContent(null);
      setModalError(null);
      setModalLoading(true);
      void readReport(meta.id);
    },
    [readReport],
  );

  const closeModal = useCallback(() => {
    setModalMeta(null);
    setModalContent(null);
    setModalError(null);
    setModalLoading(false);
    // 关闭后焦点返还触发条目(可访问性契约)。
    triggerRef.current?.focus();
    triggerRef.current = null;
  }, []);

  // Esc 关闭 modal。
  useEffect(() => {
    if (!modalMeta) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalMeta, closeModal]);

  // #N4 modal 打开焦点移入:进入后 document.activeElement 为「关闭」按钮(focus trap 入口)。
  useLayoutEffect(() => {
    if (modalMeta) closeBtnRef.current?.focus();
  }, [modalMeta]);

  const sorted = useMemo(() => {
    if (!reviews) return [];
    return [...reviews].sort((a, b) => createdTs(b) - createdTs(a));
  }, [reviews]);

  const generateHint =
    generateError?.code === 'model-unavailable'
      ? t('review.error.noModel')
      : generateError?.code === 'review-timed-out'
        ? // #N2 超时提示:重试指引由前端给出,不依赖后端消息;不得混入 model-unavailable 专属文案。
          t('review.error.timeout')
        : generateError
          ? t('review.error.failed', { message: generateError.message })
          : null;

  return (
    <>
      <div className="reviews-head">
        <span>{t('review.heading')}</span>
        <span className="rev-count">
          {reviews ? t('review.archiveCount', { count: sorted.length }) : ''}
        </span>
      </div>

      <div className="reviews-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pendingKind !== null}
          onClick={() => void generate('daily')}
        >
          <ClipboardCheck aria-hidden="true" />
          {t('review.generateDaily')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pendingKind !== null}
          onClick={() => void generate('weekly')}
        >
          <FileText aria-hidden="true" />
          {t('review.generateWeekly')}
        </button>
      </div>

      {/* 技能文件引导(PM 2026-08-08):取消提示词输入——复盘重点由用户直接
 修改技能文件定义,修改即时生效,无需重启。 */}
      <div className="reviews-skill-hint" data-testid="review-skill-hint">
        <span>{t('review.skillHint.prefix')}</span>
        <code>.lorra/skills/daily-review.md</code>
        <span>{t('review.skillHint.weeklyPrefix')}</span>
        <code>deep-review.md</code>
        <span>{t('review.skillHint.suffix')}</span>
      </div>

      {generateHint && (
        <div className="rev-error" role="alert" data-testid="review-error">
          <span>{generateHint}</span>
          {generateError?.code === 'model-unavailable' && (
            <button type="button" className="rev-error-link" onClick={() => setPage('providers')}>
              {t('review.goConfigure')}
            </button>
          )}
        </div>
      )}

      {pendingKind !== null && (
        <div className="rev-pending" data-testid="review-pending">
          <span className="orb" aria-hidden="true" />
          <span className="p-text">
            {t('review.generating', {
              label:
                pendingKind === 'daily' ? t('review.generateDaily') : t('review.generateWeekly'),
            })}
          </span>
        </div>
      )}

      <div className="reviews-list">
        {reviews === null && <div className="rev-list-empty">{t('review.listLoading')}</div>}
        {reviews !== null && sorted.length === 0 && (
          <div className="rev-list-empty" data-testid="review-empty">
            {t('review.listEmpty')}
          </div>
        )}
        {sorted.map((r) => (
          <button
            key={r.id}
            type="button"
            className="rev-item"
            data-testid="review-item"
            data-id={r.id}
            onClick={(e) => openModal(r, e.currentTarget)}
          >
            <FileText aria-hidden="true" />
            <span className="rev-meta">
              <span className="rev-key">
                {r.dateISO} · {kindLabel(r.kind)}
              </span>
            </span>
            <span className={cn('rev-badge', r.kind === 'daily' ? 'daily' : 'weekly')}>
              {r.kind === 'daily' ? t('review.badge.daily') : t('review.badge.weekly')}
            </span>
          </button>
        ))}
      </div>

      {/* 报告阅读 modal:只读 markdown,无任何编辑控件。Esc / 关闭按钮可关。 */}
      {modalMeta && (
        <div className="modal-backdrop">
          <div
            className="modal review-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('review.modal.label')}
          >
            <div className="modal-head">
              <span className={cn('rev-badge', modalMeta.kind === 'daily' ? 'daily' : 'weekly')}>
                {kindLabel(modalMeta.kind)}
              </span>
              <span className="modal-key">{modalMeta.dateISO}</span>
              <button
                type="button"
                className="modal-close"
                aria-label={t('review.modal.close')}
                ref={closeBtnRef}
                onClick={closeModal}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="modal-body">
              {modalLoading && (
                <div className="rev-pending">
                  <span className="orb" aria-hidden="true" />
                  <span className="p-text">{t('review.modal.loading')}</span>
                </div>
              )}
              {modalError !== null && (
                <div className="review-modal-error" role="alert">
                  <p className="review-modal-error-title">{t('review.modal.errorTitle')}</p>
                  <p className="review-modal-error-msg">{modalError}</p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void readReport(readingIdRef.current ?? modalMeta.id)}
                  >
                    {t('review.modal.retry')}
                  </button>
                </div>
              )}
              {!modalLoading && modalError === null && modalContent !== null && (
                <SafeMarkdown
                  content={modalContent}
                  variant="document"
                  className="review-modal-body"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
