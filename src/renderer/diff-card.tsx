import type { JSX } from 'react';
import { useState } from 'react';
import { stripAnsi } from './lib/ansi';
import { useT } from './lib/i18n';

export type DiffEditState = 'idle' | 'accepted' | 'reverted' | 'error';

export interface DiffCardProps {
  /** SDK edit 工具输出的 diff 文本(可能带 ANSI 颜色)。 */
  diff: string;
  fileName: string;
  /** = 工具调用 toolCallId,与编辑记录关联。 */
  editId: string;
  /** 在中栏打开该文件。 */
  onOpen: () => void;
  onAccept: (editId: string) => Promise<boolean>;
  onRevert: (editId: string) => Promise<{ ok: boolean; fileId?: string; error?: string }>;
  /** 复原成功后回调(中栏重取文件)。 */
  onReverted?: (fileId: string) => void;
}

const MAX_DIFF_CHARS = 20_000;

/**
 * 对话内 diff 卡片(Codex 式):AI 执行 edit/write 后展示 diff + 接受/复原/
 * 在中栏打开。diff 展示统一用 SDK 输出的 diff 文本(不依赖 git),复原走编辑记录。
 */
export function DiffCard({
  diff,
  fileName,
  editId,
  onOpen,
  onAccept,
  onRevert,
  onReverted,
}: DiffCardProps): JSX.Element {
  const t = useT();
  const [state, setState] = useState<DiffEditState>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stripped = stripAnsi(diff);
  const body =
    stripped.length > MAX_DIFF_CHARS
      ? `${stripped.slice(0, MAX_DIFF_CHARS)}${t('diffCard.truncatedSuffix')}`
      : stripped;

  async function handleAccept(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const ok2 = await onAccept(editId);
      setState(ok2 ? 'accepted' : 'error');
    } catch {
      setState('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevert(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await onRevert(editId);
      if (res.ok) {
        setState('reverted');
        if (res.fileId) onReverted?.(res.fileId);
      } else {
        setState('error');
        setError(res.error ?? t('diffCard.revertFailed'));
      }
    } catch {
      setState('error');
      setError(t('diffCard.revertFailed'));
    } finally {
      setBusy(false);
    }
  }

  const settled = state === 'accepted' || state === 'reverted';

  return (
    <div className="diff-card">
      <span className="diff-card-file">{fileName}</span>
      <pre className="diff-card-code">{body}</pre>
      {settled ? (
        <div className="diff-card-actions">
          <span
            className={`diff-card-state diff-card-state-${state}`}
            role="status"
            aria-live="polite"
          >
            {state === 'accepted' ? t('diffCard.accepted') : t('diffCard.reverted')}
          </span>
          <button type="button" onClick={onOpen}>
            {t('diffCard.openInMiddle')}
          </button>
        </div>
      ) : (
        <div className="diff-card-actions">
          <button type="button" onClick={() => void handleAccept()} disabled={busy}>
            {t('diffCard.accept')}
          </button>
          <button type="button" onClick={() => void handleRevert()} disabled={busy}>
            {t('diffCard.revert')}
          </button>
          <button type="button" onClick={onOpen}>
            {t('diffCard.openInMiddle')}
          </button>
        </div>
      )}
      {state === 'error' && error ? (
        <p className="diff-card-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
