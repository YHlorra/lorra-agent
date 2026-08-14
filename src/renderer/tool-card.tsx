import {
  Bot,
  FileCode,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  type LucideIcon,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { useId, useState } from 'react';
import type { MessageKey } from '../shared/i18n-core';
import { useT } from './lib/i18n';

export interface ToolCardProps {
  toolName: string;
  target: string;
  /** Optional id correlating tool events for the same call. */
  callId?: string;
  /** When present, renders the blocked variant (prominent "已阻断" badge). */
  safetyNote?: string;
  /** Final result text; used for tool.end render. */
  result?: string;
  /** Streaming delta for tool.update. */
  delta?: string;
  /** Raw tool-call arguments; pretty-printed when the card is expanded. */
  args?: unknown;
  /** Status: 'running' | 'ok' | 'error'. */
  status: 'running' | 'ok' | 'error';
  /** 默认展开(blocked/error/plan 行由活动条传入,保证原因/计划可见)。 */
  defaultOpen?: boolean;
  /** 存在时 detail 内容用它替换 result/delta/args 渲染(如 PlanCard)。 */
  detailOverride?: ReactNode;
}

const STATUS_LABEL_KEY: Record<ToolCardProps['status'], MessageKey> = {
  running: 'toolCard.status.running',
  ok: 'toolCard.status.ok',
  error: 'toolCard.status.error',
};

/** 工具类型图标:按工具名映射 lucide 图标,未知工具用 Wrench 兜底。 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  read: FileText,
  write: FileCode,
  edit: FileCode,
  glob: FolderSearch,
  grep: Search,
  web_search: Globe,
  websearch: Globe,
  update_plan: ListTodo,
  task: Bot,
  agent: Bot,
  ask_user: Wrench,
  askuser: Wrench,
};

const FALLBACK_TOOL_ICON: LucideIcon = Wrench;

/** True for non-empty objects/arrays/strings; skips undefined/null/empty values. */
function hasArgs(args: unknown): boolean {
  if (args == null) return false;
  if (typeof args === 'string' || Array.isArray(args)) return args.length > 0;
  return typeof args === 'object' && Object.keys(args).length > 0;
}

// ── pi-gui TimelineToolCallItem 纯函数移植(timeline-item.tsx,逐字逻辑)──

/** 写类工具(write/edit/patch/apply):label 显示「已编辑 路径」+ diff 统计。 */
export function isWriteTool(toolName: string): boolean {
  return /write|edit|patch|apply/i.test(toolName);
}

/** 路径压缩:超过 3 段只留末 3 段(可读性)。分隔符兼容 / 与 \。 */
export function shortenPath(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  if (parts.length <= 3) return filePath;
  return parts.slice(-3).join('/');
}

/** 文本是否 diff 输出(unified diff 常见锚点)。 */
export function looksLikeDiff(text: string): boolean {
  return /^diff --git|^Index: |^@@/m.test(text);
}

/** diff 统计:+/- 行数(排除 +++/--- 头行)。 */
export function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

/**
 * 输出文本截断:超过 maxLines 行时保留前 maxLines 行并报告省略行数。
 * 纯函数,导出供测试直接验证边界。
 */
export function truncateLines(
  text: string,
  maxLines = 200,
): { text: string; truncated: boolean; hiddenLines: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, truncated: false, hiddenLines: 0 };
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
    hiddenLines: lines.length - maxLines,
  };
}

/** 复制按钮:成功后短暂显示「已复制」,2 秒后恢复;clipboard 不可用时静默。 */
function CopyButton({ label, content }: { label: string; content: string }): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tool-copy-btn"
      aria-label={label}
      onClick={() => {
        try {
          void navigator.clipboard.writeText(content).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            },
            () => {
              /* 写入失败:静默保持 copy 态 */
            },
          );
        } catch {
          /* clipboard 不可用:静默保持 copy 态 */
        }
      }}
    >
      {copied ? t('toolCard.copied') : t('toolCard.copy')}
    </button>
  );
}

export function ToolCard({
  toolName,
  target,
  callId,
  safetyNote,
  result,
  delta,
  args,
  status,
  defaultOpen = false,
  detailOverride,
}: ToolCardProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const t = useT();
  const generatedId = useId();
  const detailId = `tool-detail-${callId ?? generatedId.replace(/:/g, '')}`;
  const blocked = Boolean(safetyNote);
  const detail = safetyNote ?? result ?? delta;
  const argsPresent = hasArgs(args);
  const hasDetailContent = Boolean(detail) || argsPresent || Boolean(detailOverride);
  const TypeIcon = TOOL_ICONS[toolName] ?? FALLBACK_TOOL_ICON;
  const argsText = argsPresent ? JSON.stringify(args, null, 2) : '';
  const truncated = detail ? truncateLines(detail) : { text: '', truncated: false, hiddenLines: 0 };
  const lineCount = truncated.text ? truncated.text.split('\n').length : 0;
  // pi-gui 紧凑行:write 成功 → 「已编辑 末3段路径」;diff 输出 → +N/-M 统计。
  const writeOk = isWriteTool(toolName) && status === 'ok' && Boolean(target);
  const compactLabel = writeOk ? t('toolCard.edited', { path: shortenPath(target) }) : null;
  const diffStats =
    isWriteTool(toolName) && result && looksLikeDiff(result) ? countDiffStats(result) : null;

  return (
    <article
      className={`tool-event tool-card-status-${blocked ? 'blocked' : status}`}
      data-call-id={callId}
    >
      <button
        className="tool-summary"
        type="button"
        aria-expanded={open}
        aria-controls={hasDetailContent ? detailId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <TypeIcon className="tool-type-icon" size={14} aria-hidden="true" />
        {blocked ? (
          <span className="tool-blocked-badge">{t('toolCard.blocked')}</span>
        ) : (
          <span className="tool-status-pip" aria-hidden="true" />
        )}
        {compactLabel ? (
          <span className="tool-label">{compactLabel}</span>
        ) : (
          <strong className="tool-name">{toolName}</strong>
        )}
        {!isWriteTool(toolName) || blocked ? (
          <span className="tool-target" title={target}>
            {target}
          </span>
        ) : null}
        {diffStats ? (
          <span className="tool-diff-stats">
            <span className="tool-stat-add">+{diffStats.added}</span>{' '}
            <span className="tool-stat-del">-{diffStats.removed}</span>
          </span>
        ) : null}
        {!blocked ? (
          <span className="tool-meta-inline">
            {toolName} · {t(STATUS_LABEL_KEY[status])}
          </span>
        ) : null}
        <span className="chevron" aria-hidden="true">
          ›
        </span>
      </button>

      {open && hasDetailContent ? (
        <div className={`tool-detail${blocked ? ' tool-detail-blocked' : ''}`} id={detailId}>
          {detailOverride ??
            (blocked ? (
              <p className="safety-note">{detail}</p>
            ) : (
              <>
                {argsPresent ? (
                  <div className="tool-detail-section tool-detail-input">
                    <span className="tool-detail-section-title">
                      {t('toolCard.input')}
                      <CopyButton label={t('toolCard.copyInput')} content={argsText} />
                    </span>
                    <pre className="tool-args">{argsText}</pre>
                  </div>
                ) : null}
                {detail ? (
                  <div className="tool-detail-section tool-detail-output">
                    <span className="tool-detail-section-title">
                      {t('toolCard.output')}
                      <CopyButton label={t('toolCard.copyOutput')} content={detail} />
                    </span>
                    <div className="tool-output">
                      <div className="tool-output-lines" aria-hidden="true">
                        {Array.from({ length: lineCount }, (_, i) => (
                          <div key={i}>{i + 1}</div>
                        ))}
                      </div>
                      <pre className="tool-output-text">{truncated.text}</pre>
                    </div>
                    {truncated.truncated ? (
                      <div className="tool-truncated-note">
                        … {t('toolCard.truncated', { count: truncated.hiddenLines })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ))}
        </div>
      ) : null}
    </article>
  );
}
