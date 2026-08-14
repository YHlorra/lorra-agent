import { useCallback } from 'react';
import { type Lang, type MessageKey, translate } from '../../shared/i18n-core';
import { useAppStore } from './app-store';

/**
 * 渲染层翻译 hook:绑定当前 store 语言,语言切换即重渲染。
 * 用法:`const t = useT; t('nav.workspace')` 或 `t('settings.workspace.recent.removeError', { name })`。
 */
export function useT(): (key: MessageKey, params?: Record<string, string | number>) => string {
  const language = useAppStore((s: { language: Lang }) => s.language);
  return useCallback(
    (key: MessageKey, params?: Record<string, string | number>) => translate(language, key, params),
    [language],
  );
}
