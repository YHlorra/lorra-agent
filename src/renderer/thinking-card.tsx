import type { JSX } from 'react';
import { useId, useState } from 'react';
import { useAppStore } from './lib/app-store';
import { formatDuration } from './lib/format-duration';
import { useT } from './lib/i18n';
import { SafeMarkdown } from './safe-markdown';

export interface ThinkingCardProps {
  /** Correlates the thinking stream to the assistant message it precedes. */
  messageId: string;
  /** 思考段序号(多段思考时用于稳定 key 与标识)。 */
  segmentIndex?: number;
  /** Accumulated thinking text. */
  thinking: string;
  /** True while thinking.partial streams; false once thinking.final lands. */
  running?: boolean;
  /** True when the driver withheld the raw thinking (e.g. redacted by policy). */
  thinkingRedacted?: boolean;
  /** 该条思考的耗时(ms);无有效时间信息时不显示。 */
  durationMs?: number;
}

/**
 * 思考段(消息流内联):默认展开显示思考全文(流式时文字实时滚动,
 * 参考 pi-tui/codex——思考文字直接可见,不是干标题),点击标题可折叠成
 * 一行摘要;折叠后若仍在流式期,单行预览实时显示最新文字。
 * 设置页「默认隐藏思考链」开启时,新挂载的思考卡默认折叠(只读一次挂载值,
 * 运行中翻转设置不影响已存在的卡片——「默认」只约束新卡片)。
 * 弱化样式与正文区分(设计:思考是过程,文本是结论)。
 */
export function ThinkingCard({
  messageId,
  segmentIndex,
  thinking,
  running = false,
  thinkingRedacted = false,
  durationMs,
}: ThinkingCardProps): JSX.Element {
  const defaultHideThinking = useAppStore((s) => s.defaultHideThinking);
  const [open, setOpen] = useState(() => !defaultHideThinking);
  const t = useT();
  const generatedId = useId();
  const detailId = `thinking-detail-${messageId}-${segmentIndex ?? 0}-${generatedId.replace(/:/g, '')}`;
  const hasDetail = thinkingRedacted || thinking.length > 0;
  const durationText = durationMs !== undefined ? formatDuration(durationMs, t) : '';
  const label = running
    ? t('thinkingCard.label')
    : durationText
      ? t('thinkingCard.withDuration', { duration: durationText })
      : t('thinkingCard.label');

  return (
    <article
      className={`thinking-event thinking-status-${running ? 'running' : 'done'}`}
      data-message-id={messageId}
      data-segment-index={segmentIndex ?? 0}
    >
      <button
        className="thinking-summary"
        type="button"
        aria-expanded={open}
        aria-controls={hasDetail ? detailId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {running ? (
          <span className="tool-status-spinner" aria-hidden="true" />
        ) : (
          <span className="status-dot" aria-hidden="true" />
        )}
        <strong className="thinking-label">{label}</strong>
        <span className="thinking-status">
          {running ? t('thinkingCard.running') : t('thinkingCard.done')}
        </span>
        {running && thinking.length > 0 ? (
          <span className="thinking-preview" aria-hidden="true">
            {thinking}
          </span>
        ) : null}
        <span className="chevron" aria-hidden="true">
          ›
        </span>
      </button>

      {open && hasDetail ? (
        <div className="thinking-detail" id={detailId}>
          {thinkingRedacted ? (
            <p className="thinking-redacted-note">{t('thinkingCard.redacted')}</p>
          ) : null}
          {thinking.length > 0 ? (
            <SafeMarkdown content={thinking} variant="chat" className="thinking-text" />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
