import { Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import type { Annotation } from '../shared/annotations';
import type { MessageKey } from '../shared/i18n-core';
import { useT } from './lib/i18n';

/**
 * 划线面板(右侧滑出,绝对定位于 document-pane 内,不占三栏布局):
 * 当前文件标注列表 + 点击跳转 + hover 删除。md/code/EPUB/PDF 四种查看器共用。
 */

function relativeTime(
  iso: string,
  tr: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return tr('annotationPanel.justNow');
  if (min < 60) return tr('annotationPanel.minutesAgo', { min });
  const hour = Math.floor(min / 60);
  if (hour < 24) return tr('annotationPanel.hoursAgo', { hour });
  const day = Math.floor(hour / 24);
  if (day < 7) return tr('annotationPanel.daysAgo', { day });
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function AnnotationPanel({
  annotations,
  onJump,
  onRemove,
}: {
  annotations: Annotation[];
  onJump: (id: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const t = useT();
  return (
    <aside className="annotation-panel" aria-label={t('annotationPanel.list')}>
      <header className="annotation-panel-header">
        <span>{t('annotationPanel.title')}</span>
        <span className="annotation-count">{annotations.length}</span>
      </header>
      {annotations.length === 0 ? (
        <p className="annotation-panel-empty">{t('annotationPanel.empty')}</p>
      ) : (
        <ul className="annotation-list">
          {annotations.map((ann) => (
            <li key={ann.id}>
              <button
                type="button"
                className="annotation-item"
                onClick={() => onJump(ann.id)}
                title={t('annotationPanel.jump')}
              >
                <span className="annotation-item-text">
                  {ann.text.length > 40 ? `${ann.text.slice(0, 40)}…` : ann.text}
                </span>
                {ann.note ? (
                  <span className="annotation-item-note">
                    {ann.note.length > 60 ? `${ann.note.slice(0, 60)}…` : ann.note}
                  </span>
                ) : null}
                <span className="annotation-item-time">{relativeTime(ann.createdAt, t)}</span>
              </button>
              <button
                type="button"
                className="annotation-remove"
                aria-label={t('annotationPanel.remove')}
                title={t('annotationPanel.remove')}
                onClick={() => onRemove(ann.id)}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
