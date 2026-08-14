import type { FormEvent, JSX, KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { SlashCommandName } from '@/lib/slash-commands';
import { parseSlashCommand, REVIEW_WEEKLY_ARG, SLASH_COMMANDS } from '@/lib/slash-commands';
import type { SessionStatus } from '../shared/agent-events';
import type { LorraError } from '../shared/result';
import type { ReviewKind } from '../shared/review-api';
import { useT } from './lib/i18n';

export type ComposerReference =
  | { id: string; fileName: string; text: string; kind?: 'selection' }
  | { id: string; kind: 'file'; fileId: string; fileName: string };

// IPC 信封兼容 SerializedResult(status)与 LorraResult(ok)两种判别形状(同 review-rail)。
type ReviewResponse<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: LorraError }
  | { ok: true; value: T }
  | { ok: false; error: LorraError };

function unwrapReview<T>(
  res: ReviewResponse<T>,
): { ok: true; value: T } | { ok: false; error: LorraError } {
  if ('status' in res) {
    return res.status === 'ok' ? { ok: true, value: res.value } : { ok: false, error: res.error };
  }
  return res;
}

export interface ComposerProps {
  status: SessionStatus;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** 斜杠命令(pi TUI 风格):返回 true = 已处理(清空输入),false = 未处理。 */
  onCommand?: (command: SlashCommandName) => boolean | Promise<boolean>;
  /** Inline error to render above the textarea; empty string hides it. */
  inlineError?: string;
  /** Model availability: false → show "model unavailable" banner above composer. */
  modelAvailable?: boolean;
  /** Current default model display name; shown in the composer presence row. */
  defaultModelName?: string | null;
  /** Empty state shown when no events yet for the active session. */
  emptyStateMessage?: string;
  /** 引用胶囊(「问 AI」选区文本 / @ 文件):发送时拼进消息体,发送后清空。 */
  references?: ComposerReference[];
  onClearReferences?: () => void;
  /** @ 文件候选:输入框 @ 前缀时查询工作区文件。 */
  onFileCandidates?: (query: string) => Promise<Array<{ fileId: string; name: string }>>;
  /** @ 文件引用发送时读取文件内容快照;返回 null = 读不到(退化为仅文件名)。 */
  onResolveFileRef?: (fileId: string) => Promise<string | null>;
  /** @ 选中文件后追加引用胶囊(由 App 持有引用列表)。 */
  onAppendReference?: (ref: ComposerReference) => void;
}

export function Composer({
  status,
  onSend,
  onAbort,
  onCommand,
  inlineError = '',
  modelAvailable = true,
  defaultModelName,
  emptyStateMessage,
  references,
  onClearReferences,
  onFileCandidates,
  onResolveFileRef,
  onAppendReference,
}: ComposerProps): JSX.Element {
  const t = useT();
  const [message, setMessage] = useState('');
  // 未识别的斜杠命令提示(如 /foo):不清空输入,用户可继续编辑。
  const [commandHint, setCommandHint] = useState<string | null>(null);
  // /review 复盘生成反馈(任务 6.10):pending / 成功 / 退化三态互斥错误,文案同 review-rail。
  const [reviewPending, setReviewPending] = useState<ReviewKind | null>(null);
  const [reviewError, setReviewError] = useState<LorraError | null>(null);
  const [reviewDone, setReviewDone] = useState<ReviewKind | null>(null);
  // IDE 式补全菜单:输入 / 开头弹出候选;menuIndex 高亮,menuDismissed 支持 Esc。
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // @ 文件引用菜单:同斜杠菜单模式,候选来自工作区文件搜索。
  const [fileIndex, setFileIndex] = useState(0);
  const [fileMenuDismissed, setFileMenuDismissed] = useState(false);
  const [fileCandidates, setFileCandidates] = useState<Array<{ fileId: string; name: string }>>([]);
  // Tracks the last text we attempted to send so we can decide, after
  // `onSend` resolves, whether to clear or restore based on the parent's
  // `inlineError` prop. Clearing eagerly would lose user input on failure.
  const lastSendRef = useRef<{ text: string; settled: boolean } | null>(null);
  // Bumped after onSend resolves so the effect re-runs once the parent
  // dispatch has propagated into the `inlineError` prop.
  const [sendTick, setSendTick] = useState(0);
  const busy = status === 'streaming' || status === 'tool-running';
  const sendDisabled = busy || !modelAvailable;
  const errorMessage =
    inlineError.trim() || (status === 'errored' ? t('composer.errorBanner') : '');
  // 退化三态互斥文案(review-rail 同款):model-unavailable / review-timed-out / 其他。
  const reviewErrorHint =
    reviewError?.code === 'model-unavailable'
      ? t('composer.reviewNoModel')
      : reviewError?.code === 'review-timed-out'
        ? // #N2 超时提示:重试指引由前端给出,不依赖后端消息;不得混入 model-unavailable 专属文案。
          t('composer.reviewTimeout')
        : reviewError
          ? t('composer.reviewFailed', { message: reviewError.message })
          : null;

  // Decide clear vs. restore AFTER the parent's dispatch settles:
  // - inlineError non-empty → failure, keep the user's text.
  // - inlineError empty → success, drop the text.
  // The `settled` flag prevents a pre-await tick from clearing prematurely.
  useEffect(() => {
    const pending = lastSendRef.current;
    if (!pending?.settled) return;
    if (inlineError) {
      setMessage(pending.text);
    } else {
      setMessage('');
    }
    lastSendRef.current = null;
  }, [inlineError, sendTick]);

  // 菜单状态:整行 / 前缀 + 未 Esc 关闭 → 弹出;候选按前缀过滤。
  const slashPrefix = /^\/([a-z]*)$/.exec(message.trim())?.[1]?.toLowerCase() ?? null;
  const menuOpen = slashPrefix !== null && !menuDismissed;
  const candidates = menuOpen
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashPrefix ?? ''))
    : [];
  const activeIndex = Math.min(menuIndex, Math.max(candidates.length - 1, 0));

  // @ 文件引用:光标在末尾时 `@前缀` 触发候选(与斜杠菜单互斥)。
  const filePrefixMatch = onFileCandidates ? /(^|\s)@([\w.\-/]*)$/.exec(message) : null;
  const filePrefix = filePrefixMatch?.[2] ?? null;
  const fileMenuOpen = filePrefix !== null && !fileMenuDismissed;
  const activeFileIndex = Math.min(fileIndex, Math.max(fileCandidates.length - 1, 0));

  // 候选按前缀异步加载(搜索主进程工作区)。
  useEffect(() => {
    if (!fileMenuOpen || !onFileCandidates) {
      setFileCandidates([]);
      return;
    }
    let cancelled = false;
    void onFileCandidates(filePrefix ?? '').then((list) => {
      if (!cancelled) setFileCandidates(list);
    });
    return () => {
      cancelled = true;
    };
  }, [filePrefix, fileMenuOpen, onFileCandidates]);

  /** @ 选中文件:删输入末尾 @前缀,追加文件引用胶囊。 */
  function selectFileRef(candidate: { fileId: string; name: string }): void {
    const match = /(^|\s)@([\w.\-/]*)$/.exec(message);
    if (!match) return;
    // 保留 @ 前的空格/行首,只去掉 @前缀 本身。
    setMessage(message.slice(0, match.index + match[1].length));
    setFileMenuDismissed(true);
    onAppendReference?.({
      id: crypto.randomUUID(),
      kind: 'file',
      fileId: candidate.fileId,
      fileName: candidate.name,
    });
  }

  /** 执行 /review:composer 直接经 window.lorra.review.generate 生成(不回调 onCommand)。 */
  async function runReview(kind: ReviewKind): Promise<void> {
    if (reviewPending !== null) return;
    setReviewPending(kind);
    setReviewError(null);
    setReviewDone(null);
    try {
      const res = await window.lorra?.review?.generate({ kind });
      if (!res) throw new Error(t('composer.reviewUnavailable'));
      const unwrapped = unwrapReview(res);
      if (unwrapped.ok) setReviewDone(kind);
      else setReviewError(unwrapped.error);
    } catch (err) {
      setReviewError({
        code: 'review-generate-failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setReviewPending(null);
    }
  }

  /** 执行斜杠命令:处理后清空输入(命令方负责成败反馈)。 */
  async function runCommand(name: SlashCommandName, arg?: string): Promise<void> {
    if (name === 'review') {
      // /review <其他> 参数非法:不清空输入,用户可继续编辑(同未知命令行为)。
      if (arg !== undefined && arg !== REVIEW_WEEKLY_ARG) {
        setCommandHint(t('composer.reviewBadArg', { arg, weekly: REVIEW_WEEKLY_ARG }));
        return;
      }
      await runReview(arg === REVIEW_WEEKLY_ARG ? 'weekly' : 'daily');
      setCommandHint(null);
      setMessage('');
      setMenuDismissed(true);
      return;
    }
    const handled = (await onCommand?.(name)) ?? false;
    if (handled) {
      setCommandHint(null);
      setMessage('');
      setMenuDismissed(true);
    }
  }

  async function send(): Promise<void> {
    const text = message.trim();
    const parsed = parseSlashCommand(text);
    if (parsed.kind === 'command') {
      // 斜杠命令:执行后清空输入(pi TUI 行为);命令处理方负责成败反馈。
      await runCommand(parsed.name, parsed.arg);
      return;
    }
    if (parsed.kind === 'unknown') {
      setCommandHint(
        t('composer.unknownCommand', {
          name: parsed.name,
          hints: SLASH_COMMANDS.map((c) => c.hint).join(' '),
        }),
      );
      return;
    }
    if (commandHint) setCommandHint(null);
    if (!text || busy || !modelAvailable) return;
    // 引用胶囊(「问 AI」选区 + @ 文件):拼进消息体后发送;无论成败发送后都清空
    // 胶囊(失败时用户输入由 lastSendRef 恢复,引用已进消息体,不恢复)。
    const blocks: string[] = [];
    for (const r of references ?? []) {
      if (r.kind === 'file') {
        // @ 文件:发送时读内容快照进 prompt;读不到 → 仅文件名。
        const content = await onResolveFileRef?.(r.fileId);
        if (content) {
          const truncated =
            content.length > 2000 ? `${content.slice(0, 2000)}\n…（已截断）` : content;
          blocks.push(`[文件] ${r.fileName}\n\`\`\`\n${truncated}\n\`\`\``);
        } else {
          blocks.push(`[文件] ${r.fileName}`);
        }
      } else {
        blocks.push(
          `[引用] ${r.fileName}\n> ${r.text.length > 500 ? `${r.text.slice(0, 500)}…` : r.text}`,
        );
      }
    }
    const refBlock = blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
    lastSendRef.current = { text, settled: false };
    try {
      await onSend(refBlock + text);
    } finally {
      onClearReferences?.();
      setFileMenuDismissed(true);
    }
    // Mark settled AND bump tick in the same batch so the effect sees a
    // settled ref with the latest inlineError (parent dispatch happened
    // inside onSend and React will batch them together).
    if (lastSendRef.current) lastSendRef.current.settled = true;
    setSendTick((n) => n + 1);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    send();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // @ 文件菜单:↑/↓ 选择,Enter 选中成胶囊,Esc 关闭。
    if (fileMenuOpen && fileCandidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setFileIndex((i) => Math.min(i + 1, fileCandidates.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setFileIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        selectFileRef(fileCandidates[activeFileIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setFileMenuDismissed(true);
        return;
      }
    }
    // 补全菜单开启:↑/↓ 选择、Tab 补全、Enter 执行高亮项、Esc 关闭(IDE 行为)。
    if (menuOpen && candidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMenuIndex((i) => Math.min(i + 1, candidates.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMenuIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        setMenuDismissed(true);
        setMessage(`/${candidates[activeIndex].name}`);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void runCommand(candidates[activeIndex].name);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    // 斜杠命令(pi TUI):整行命令时 Enter 直接执行(命令无需换行)。
    if (event.key === 'Enter') {
      if (parseSlashCommand(message).kind !== 'none') {
        event.preventDefault();
        send();
        return;
      }
      // Enter 发送(2026-08-09 UX 调整:回车即发送);Ctrl+Enter 换行(textarea 默认插入)。
      if (!event.ctrlKey) {
        event.preventDefault();
        send();
      }
    }
  }

  return (
    <div className="composer-region">
      {emptyStateMessage ? (
        <div className="composer-empty-state" role="status">
          <span className="composer-empty-rule" aria-hidden="true" />
          <p>{emptyStateMessage}</p>
          <span className="composer-empty-rule" aria-hidden="true" />
        </div>
      ) : null}

      {commandHint ? (
        <div className="composer-banner composer-banner-warning" role="status">
          <strong>{t('composer.slashCommand')}</strong>
          <span>{commandHint}</span>
        </div>
      ) : null}

      {/* /review 反馈:生成中 / 成功 / 退化三态错误(文案与判别同 review-rail)。 */}
      {reviewPending !== null && (
        <div className="composer-banner" role="status" data-testid="review-pending">
          <strong>{t('composer.review')}</strong>
          <span>
            {t('composer.reviewing', {
              label:
                reviewPending === 'daily'
                  ? t('composer.review.daily')
                  : t('composer.review.weekly'),
            })}
          </span>
        </div>
      )}
      {reviewDone !== null && (
        <div className="composer-banner" role="status" data-testid="review-done">
          <strong>{t('composer.review')}</strong>
          <span>{t('composer.reviewDone')}</span>
        </div>
      )}
      {reviewError !== null && (
        <div
          className="composer-banner composer-banner-error"
          role="alert"
          data-testid="review-error"
        >
          <strong>{t('composer.review')}</strong>
          <span>{reviewErrorHint}</span>
        </div>
      )}

      {!modelAvailable ? (
        <div className="composer-banner composer-banner-warning" role="status">
          <strong>{t('composer.modelUnavailable')}</strong>
          <span>{t('composer.modelUnavailableDesc')}</span>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="composer-banner composer-banner-error" role="alert">
          <strong>{t('composer.sendFailed')}</strong>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {/* 2026-08-13 去 AI 味:移除 MagicUI 光束扫边(border-beam)。busy 语义由
 思考环 + presence 文案承担(§Thinking Orb 统一视觉语言)。 */}
      <form className={`composer composer-${status}`} onSubmit={handleSubmit}>
        <label htmlFor="agent-message">{t('composer.inputLabel')}</label>
        {references && references.length > 0 ? (
          <ul className="composer-references" aria-label={t('composer.referencesLabel')}>
            {references.map((r) => (
              <li key={r.id} className="composer-reference">
                {r.kind === 'file' && (
                  <span className="composer-reference-kind">{t('composer.referenceFile')}</span>
                )}
                <span className="composer-reference-file">{r.fileName}</span>
                {r.kind !== 'file' && (
                  <span className="composer-reference-text">
                    {r.text.length > 40 ? `${r.text.slice(0, 40)}…` : r.text}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={t('composer.removeReference')}
                  onClick={onClearReferences}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          id="agent-message"
          aria-label={t('composer.inputLabel')}
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            setMenuDismissed(false);
            setMenuIndex(0);
            setFileMenuDismissed(false);
            setFileIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('composer.placeholder')}
          rows={3}
          aria-haspopup="listbox"
        />
        {fileMenuOpen && fileCandidates.length > 0 && (
          <div
            id="file-ref-menu"
            className="slash-menu"
            role="listbox"
            aria-label={t('composer.fileMenu')}
          >
            {fileCandidates.map((c, i) => (
              <button
                type="button"
                id={`file-ref-opt-${c.fileId}`}
                key={c.fileId}
                role="option"
                aria-selected={i === activeFileIndex}
                className={`slash-menu-item${i === activeFileIndex ? ' slash-menu-item-active' : ''}`}
                onMouseEnter={() => setFileIndex(i)}
                onMouseDown={(e) => {
                  // 点击选中:阻止 textarea 失焦导致的菜单关闭时序问题
                  e.preventDefault();
                  selectFileRef(c);
                }}
              >
                <span className="slash-menu-hint">@</span>
                <span className="slash-menu-desc">{c.name}</span>
              </button>
            ))}
          </div>
        )}
        {menuOpen && candidates.length > 0 && (
          <div
            id="slash-command-menu"
            className="slash-menu"
            role="listbox"
            aria-label={t('composer.slashMenu')}
          >
            {candidates.map((c, i) => (
              <button
                type="button"
                id={`slash-opt-${c.name}`}
                key={c.name}
                role="option"
                aria-selected={i === activeIndex}
                className={`slash-menu-item${i === activeIndex ? ' slash-menu-item-active' : ''}`}
                onMouseEnter={() => setMenuIndex(i)}
                onClick={() => void runCommand(c.name)}
              >
                <span className="slash-menu-hint">{c.hint}</span>
                <span className="slash-menu-desc">{t(c.descriptionKey)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-actions">
          <div className="composer-presence" aria-live="polite">
            {status === 'streaming' ? (
              <>
                <span className="composer-status-dot is-streaming" aria-hidden="true" />
                <span>{t('composer.answering')}</span>
              </>
            ) : status === 'tool-running' ? (
              <>
                <span className="composer-spinner" aria-hidden="true" />
                <span>{t('composer.usingTools')}</span>
              </>
            ) : (
              <>
                {defaultModelName && (
                  <span className="composer-model-name">{defaultModelName}</span>
                )}
                <span className="composer-shortcut">{t('composer.sendHint')}</span>
              </>
            )}
          </div>

          {busy ? (
            <button
              className="stop-button"
              type="button"
              onClick={onAbort}
              aria-label={t('composer.stopLabel')}
            >
              <span aria-hidden="true" />
              {t('composer.stop')}
            </button>
          ) : null}
          <button
            className="send-button"
            type="submit"
            disabled={sendDisabled}
            aria-disabled={sendDisabled}
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
