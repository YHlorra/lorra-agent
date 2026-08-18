/**
 * 外部链接协议白名单(2026-08-17):http(s) + mailto。
 * main.ts setWindowOpenHandler 与 window-ipc lorra.app.openExternal 共享同一判定。
 */
const EXTERNAL_URL_PATTERN = /^https?:\/\/|^mailto:/i;

export function isExternalUrl(url: string): boolean {
  return EXTERNAL_URL_PATTERN.test(url);
}
