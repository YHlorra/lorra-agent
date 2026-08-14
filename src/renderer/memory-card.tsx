/**
 * 会话内记忆只读展示卡(1.6)。
 *
 * memory 工具成功写入(propose/update)后 emit `memory.recorded` 事件,
 * reducer 追加 recordedNotices;会话内不再渲染可操作卡片——候选闸门已拆除
 * ,确认/编辑/拒绝/忽略交互全部移除,用户在记忆页触点纠正。
 *
 * 本组件为纯展示:类别/scope/来源/证据徽标 + 标题 + 内容 + producer/依据。
 * 生效区条目的编辑/撤销按钮由记忆页提供(触点③),不在此卡片内。
 */
import type { JSX } from 'react';
import {
  MEMORY_EVIDENCE_LABELS,
  MEMORY_KIND_LABELS,
  MEMORY_SCOPE_LABELS,
  MEMORY_SOURCE_LABELS,
  type MemoryEntry,
} from '../shared/memory-schema';
import { useT } from './lib/i18n';

export interface MemoryCardProps {
  entry: MemoryEntry;
}

export function MemoryCard({ entry }: MemoryCardProps): JSX.Element {
  const t = useT();
  return (
    <article className="memory-card" data-testid="memory-card" data-entry-id={entry.entryId}>
      <header className="memory-card-head">
        <span className="rev-badge memory-kind-badge">{MEMORY_KIND_LABELS[entry.kind]}</span>
        <span className="rev-badge memory-scope-badge">{MEMORY_SCOPE_LABELS[entry.scope]}</span>
        <span className="rev-badge memory-source-badge">{MEMORY_SOURCE_LABELS[entry.source]}</span>
        <span className="rev-badge memory-evidence-badge">
          {MEMORY_EVIDENCE_LABELS[entry.evidence]}
        </span>
      </header>
      <h3 className="memory-card-title">{entry.title}</h3>
      <p className="memory-card-content">{entry.content}</p>
      <footer className="memory-card-foot">
        <span className="memory-card-producer">
          {t('memoryCard.source', { producer: entry.producer })}
        </span>
        {entry.basis !== '' && (
          <span className="memory-card-basis">{t('memoryCard.basis', { basis: entry.basis })}</span>
        )}
      </footer>
    </article>
  );
}
