/**
 * 自研轻量 i18n:renderer 与 main 进程共用的纯翻译函数,无 DOM 依赖。
 * 需求只有双语词条替换 + `{param}` 插值,无复数/ICU 规则,不引入 i18next。
 *
 * 约定:
 * - 语言真源 = settings.json 的 `AppSettings.language`(default 'zh'),renderer
 * 首帧读 localStorage 缓存,App 挂载后经 IPC 用真源校正。
 * - 词条 key 扁平点分:`<域>.<组件>.<语义>`,如 `nav.workspace`、`settings.appearance.theme`。
 * - 永不抛错:en 缺词条回退 zh,未知 key 返回 key 本身。
 */

import en from './locales/en.json';
import zh from './locales/zh.json';

export type Lang = 'zh' | 'en';

export type MessageKey = keyof typeof zh;

export function translate(
  lang: Lang,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const dict = lang === 'en' ? en : zh;
  const template = dict[key] ?? zh[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
