import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useT } from './lib/i18n';

/**
 * Codex APPROVAL_PROMPT_TYPING_IDLE_DELAY 同思路:审批到达时若用户正在
 * composer 打字,延迟到空闲再弹出,避免打断输入流。
 */
export const APPROVAL_TYPING_IDLE_MS = 1500;

export interface ApprovalModalProps {
  approval: { approvalId: string; toolName: string; target: string; reason: string };
  onRespond: (approvalId: string, decision: 'allowOnce' | 'allowAlways' | 'deny') => Promise<void>;
}

/** 挂载瞬间用户是否正在打字(composer textarea 聚焦且有非空输入)。 */
function isTyping(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement && el.value.trim().length > 0;
}

/**
 * 分级审批模态(升级,Codex 式权限模型):工作区外写入/超阈值写入被
 * 拦截时,全屏遮罩 + 视口内固定卡片接管输入——agent 已挂起等待裁决,模态
 * 不消失用户无法继续对话。允许 → 放行工具执行(会话内记住该 (工具, 目标)
 * 后续直放);拒绝 → 拦截器返回 block + terminate,agent 停止当前轮。
 */
export function ApprovalModal({ approval, onRespond }: ApprovalModalProps): JSX.Element | null {
  // 挂载瞬间若在打字,延迟弹出(不打断输入);空闲后强制出现(agent 在等)。
  const t = useT();
  const [visible, setVisible] = useState(() => !isTyping());
  const [busy, setBusy] = useState(false);
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (visible) {
      // 焦点接管:进入模态(默认停在「拒绝」,安全侧),composer 不可达。
      denyRef.current?.focus();
    }
  }, [visible]);

  useEffect(() => {
    if (visible) return;
    const t = setTimeout(() => setVisible(true), APPROVAL_TYPING_IDLE_MS);
    return () => clearTimeout(t);
  }, [visible]);

  if (!visible) return null;

  async function respond(decision: 'allowOnce' | 'allowAlways' | 'deny'): Promise<void> {
    setBusy(true);
    try {
      await onRespond(approval.approvalId, decision);
    } finally {
      setBusy(false);
    }
  }

  const reasonText = approval.reason.replace(/^approval-required:\s*/, '');

  return (
    <div
      className="approval-modal-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-label={t('approval.title')}
    >
      <div className="approval-modal">
        <p className="approval-modal-title">{t('approval.title')}</p>
        <p className="approval-modal-detail">
          <strong>{approval.toolName}</strong>
          <span className="approval-modal-target" title={approval.target}>
            {approval.target}
          </span>
        </p>
        <p className="approval-modal-reason">{reasonText}</p>
        <div className="approval-modal-actions">
          {/* Codex 式三选项:允许一次(不记会话)/ 总是允许(会话内直放)/ 拒绝 */}
          <button
            type="button"
            onClick={() => void respond('allowOnce')}
            disabled={busy}
            title={t('approval.allowOnceDesc')}
          >
            {t('approval.allowOnce')}
          </button>
          <button
            type="button"
            onClick={() => void respond('allowAlways')}
            disabled={busy}
            title={t('approval.allowAlwaysDesc')}
          >
            {t('approval.allowAlways')}
          </button>
          <button type="button" ref={denyRef} onClick={() => void respond('deny')} disabled={busy}>
            {t('approval.deny')}
          </button>
        </div>
      </div>
    </div>
  );
}
