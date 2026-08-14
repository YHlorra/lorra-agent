/**
 * Main 进程语言缓存:启动时从 settings.json 读一次,`lorra.settings.set`
 * 带 language 时更新。下一次生成用户可见 message 即用新语言,无需重启。
 */

import { type Lang, type MessageKey, translate } from '../shared/i18n-core';

let current: Lang = 'zh';

export function setMainLanguage(lang: Lang): void {
  current = lang;
}

export function getMainLanguage(): Lang {
  return current;
}

/** Main 进程用户可见文案翻译(仅 UI-facing message;prompt/toolText/日志不动)。 */
export function tMain(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(current, key, params);
}
