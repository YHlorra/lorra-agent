import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '@/lib/app-store';
import { applyThemeClass, readUiPrefs, UI_PREFS_KEY, writeUiPrefs } from '@/lib/theme';

// 主题与图标栏折叠偏好+ 界面语言:lorra-ui 单键持久化契约。
describe('UI 偏好持久化(lorra-ui)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    useAppStore.setState({
      page: 'workspace',
      theme: 'light',
      navCollapsed: false,
      language: 'zh',
    });
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  describe('readUiPrefs', () => {
    it('Given 空存储 When 读取 Then 返回默认浅色+展开+中文(jsdom 无 matchMedia 走 light)', () => {
      expect(readUiPrefs()).toEqual({ theme: 'light', navCollapsed: false, language: 'zh' });
    });

    it('Given 预置合法 JSON When 读取 Then 解析成功', () => {
      localStorage.setItem(
        UI_PREFS_KEY,
        JSON.stringify({ theme: 'dark', navCollapsed: true, language: 'en' }),
      );
      expect(readUiPrefs()).toEqual({ theme: 'dark', navCollapsed: true, language: 'en' });
    });

    it('Given 损坏 JSON When 读取 Then 回退默认值且不抛错', () => {
      localStorage.setItem(UI_PREFS_KEY, '{not-json');
      expect(readUiPrefs()).toEqual({ theme: 'light', navCollapsed: false, language: 'zh' });
    });

    it('Given 未知 theme 值 When 读取 Then 按浅色处理', () => {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ theme: 'neon', navCollapsed: false }));
      expect(readUiPrefs()).toEqual({ theme: 'light', navCollapsed: false, language: 'zh' });
    });

    it('Given language 缺省/未知 When 读取 Then 按 zh 处理', () => {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ theme: 'dark', language: 'ja' }));
      expect(readUiPrefs().language).toBe('zh');
    });
  });

  describe('writeUiPrefs / applyThemeClass', () => {
    it('When 写入 When 读取 localStorage 内容正确', () => {
      writeUiPrefs({ theme: 'dark', navCollapsed: true, language: 'zh' });
      expect(JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? 'null')).toEqual({
        theme: 'dark',
        navCollapsed: true,
        language: 'zh',
      });
    });

    it('Given 浅色 When applyThemeClass(dark) Then html 加 dark 类,切回 light 移除', () => {
      applyThemeClass('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      applyThemeClass('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  describe('store 联动', () => {
    it('When setTheme(dark) Then state 更新且写入 localStorage(保留 language)', () => {
      useAppStore.getState().setTheme('dark');
      expect(useAppStore.getState().theme).toBe('dark');
      const parsed = JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? '{}');
      expect(parsed.theme).toBe('dark');
      expect(parsed.language).toBe('zh');
    });

    it('When toggleNav Then navCollapsed 翻转且持久化,再点还原', () => {
      useAppStore.getState().toggleNav();
      expect(useAppStore.getState().navCollapsed).toBe(true);
      const parsed = JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? '{}');
      expect(parsed.navCollapsed).toBe(true);

      useAppStore.getState().toggleNav();
      expect(useAppStore.getState().navCollapsed).toBe(false);
    });

    it('Given 预置 dark When setTheme(light) Then 持久化覆盖为 light', () => {
      useAppStore.getState().setTheme('dark');
      useAppStore.getState().setTheme('light');
      const parsed = JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? '{}');
      expect(parsed.theme).toBe('light');
    });
  });
});
