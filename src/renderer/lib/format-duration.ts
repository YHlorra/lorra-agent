import type { MessageKey } from '../../shared/i18n-core';

/**
 * 毫秒 → 人类可读时长,算法对齐 pi-gui formatWorkedDuration
 * (timeline-item.tsx):先 round 总秒数再对 60 取模,消除进位误差。
 * 规则:<60s → N秒(不足 1 秒按 1秒);<1h → N分[N秒];否则 N小时[N分]。
 * 零值位不显示(2小时0分 → 2小时)。
 * 输入非有限数或 <= 0 → 空串(调用方据此不渲染耗时段)。
 * 文案经 tr 词条,由调用组件传入 useT 结果。
 */
export type DurationTr = (key: MessageKey, params?: Record<string, string | number>) => string;

export function formatDuration(ms: number, tr: DurationTr): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return tr('duration.seconds', { n: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0
      ? tr('duration.minutesSeconds', { m: minutes, s: seconds })
      : tr('duration.minutes', { m: minutes });
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0
    ? tr('duration.hoursMinutes', { h: hours, m: remMinutes })
    : tr('duration.hours', { h: hours });
}
