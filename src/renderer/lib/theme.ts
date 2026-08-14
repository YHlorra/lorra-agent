import type { Lang } from '../../shared/i18n-core';
import { useAppStore } from './app-store';

// 主题与界面偏好持久化:localStorage 单键 lorra-ui,
// 存 { theme, navCollapsed, language }。只读初始值跟随系统 prefers-color-scheme,
// 之后以用户手动选择为准,不做实时系统跟随。

export type Theme = 'light' | 'dark';

export const UI_PREFS_KEY = 'lorra-ui';

export interface UiPrefs {
  theme: Theme;
  navCollapsed: boolean;
  /** 首帧语言缓存:避免英文用户首帧闪中文,App 挂载后以 settings.json 真源校正。 */
  language: Lang;
}

function systemTheme(): Theme {
  try {
    // jsdom 等环境无 matchMedia;可选链 + 守卫保证不炸。
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    return mql?.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function readUiPrefs(): UiPrefs {
  const fallback: UiPrefs = { theme: systemTheme(), navCollapsed: false, language: 'zh' };
  try {
    const raw = window.localStorage?.getItem(UI_PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    const theme: Theme = parsed.theme === 'dark' ? 'dark' : 'light';
    return {
      theme,
      navCollapsed: parsed.navCollapsed === true,
      language: parsed.language === 'en' ? 'en' : 'zh',
    };
  } catch {
    // 损坏/不可读 → 默认值,不抛错。
    return fallback;
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    window.localStorage?.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 写入失败(如隐私模式)静默忽略,不阻断交互。
  }
}

export function applyThemeClass(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function initTheme(): void {
  applyThemeClass(useAppStore.getState().theme);
}
