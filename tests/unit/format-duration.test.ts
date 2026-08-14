import { describe, expect, it } from 'vitest';
import { type DurationTr, formatDuration } from '../../src/renderer/lib/format-duration';
import { type MessageKey, translate } from '../../src/shared/i18n-core';

// formatDuration:文案经 tr 词条;测试用真实 zh 词典,断言中文字面量不变。
const zhTr: DurationTr = (key, params) => translate('zh', key as MessageKey, params);

describe('formatDuration', () => {
  it('秒级:不足 1 分钟显示 N秒,不足 1 秒按 1秒', () => {
    expect(formatDuration(35_000, zhTr)).toBe('35秒');
    expect(formatDuration(500, zhTr)).toBe('1秒');
  });

  it('分级:不足 1 小时显示 N分N秒', () => {
    expect(formatDuration(205_000, zhTr)).toBe('3分25秒');
  });

  it('小时级:显示 N小时[N分],零值位省略', () => {
    expect(formatDuration(7_200_000, zhTr)).toBe('2小时');
    expect(formatDuration(7_260_000, zhTr)).toBe('2小时1分');
  });

  it('进位边界:round 总秒数后对 60 取模,不出现 60秒/59分60秒', () => {
    expect(formatDuration(59_400, zhTr)).toBe('59秒');
    expect(formatDuration(59_600, zhTr)).toBe('1分');
    expect(formatDuration(60_000, zhTr)).toBe('1分');
    expect(formatDuration(3_599_600, zhTr)).toBe('1小时');
  });

  it('边界:非有限数或 <= 0 返回空串', () => {
    expect(formatDuration(0, zhTr)).toBe('');
    expect(formatDuration(Number.NaN, zhTr)).toBe('');
    expect(formatDuration(-1, zhTr)).toBe('');
  });
});
