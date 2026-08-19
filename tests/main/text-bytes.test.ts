import { describe, expect, it } from 'vitest';
import { truncateBytes, truncateUtf8ToBytes } from '../../src/main/memory/text-bytes';

/**
 * text-bytes 字节截断契约(2026-08-18 修复):
 * - 容量不变量:返回字节 ≤ maxBytes(严格)。
 * - 码点安全:返回串可无损往返 utf8(无孤代理项 → 不出现 U+FFFD)。
 * - 最优性:astral 字符(代理对)整对可容纳时整对保留,不做多余丢弃。
 *
 * 回归背景:旧实现二分到 UTF-16 码元边界,截断点落在代理对中间时返回孤代理项,
 * 编码后成 U+FFFD(Buffer.from('\ud83d').toString('utf8') → '\uFFFD')。
 * 以下用例在旧代码上失败(truncateUtf8ToBytes('😀',3) 曾返回 '\ud83d')。
 */

/** 往返无 U+FFFD(代理项被 U+FFFD 替换即判失败)。 */
function roundtripClean(s: string): boolean {
  return !Buffer.from(s, 'utf8').toString('utf8').includes('\uFFFD');
}

describe('truncateUtf8ToBytes（前缀截断,码点安全）', () => {
  it('容量不变量:≤ maxBytes;不劈开多字节字符', () => {
    const cases: Array<[string, number]> = [
      ['😀', 3],
      ['a😀b', 4],
      ['a😀b', 5],
      ['a😀b', 6],
      ['你😀好', 3],
      ['你😀好', 6],
      ['😀😀😀', 4],
      ['😀😀😀', 8],
    ];
    for (const [s, max] of cases) {
      const out = truncateUtf8ToBytes(s, max);
      expect(Buffer.byteLength(out, 'utf8'), `${JSON.stringify(s)}/${max}`).toBeLessThanOrEqual(
        max,
      );
      expect(roundtripClean(out), `${JSON.stringify(s)}/${max} 产生 U+FFFD`).toBe(true);
    }
  });

  it('回归:截断点落在代理对中间 → 不返回孤代理项', () => {
    expect(roundtripClean(truncateUtf8ToBytes('😀', 3))).toBe(true);
    // 旧实现返回 '\ud83d'(孤高代理)→ 编码后 U+FFFD。
    expect(truncateUtf8ToBytes('😀', 3)).toBe('');
  });

  it('最优性:整对可容纳时整对保留', () => {
    expect(truncateUtf8ToBytes('a😀b', 5)).toBe('a😀'); // 1+4=5 字节,整对放得下
    expect(truncateUtf8ToBytes('a😀b', 4)).toBe('a'); // 整对放不下 → 丢弃
    expect(truncateUtf8ToBytes('😀😀', 4)).toBe('😀');
  });

  it('已 ≤ maxBytes 时原样返回', () => {
    expect(truncateUtf8ToBytes('你', 3)).toBe('你');
    expect(truncateUtf8ToBytes('', 0)).toBe('');
  });
});

describe('truncateBytes（尾部截断=保留后缀,码点安全）', () => {
  it('容量不变量:≤ maxBytes;不劈开多字节字符', () => {
    const cases: Array<[string, number]> = [
      ['a😀', 3],
      ['a😀', 4],
      ['ab😀', 2],
      ['ab😀', 5],
      ['a😀b', 5],
      ['你😀好', 3],
      ['😀😀😀', 4],
    ];
    for (const [s, max] of cases) {
      const out = truncateBytes(s, max);
      expect(Buffer.byteLength(out, 'utf8'), `${JSON.stringify(s)}/${max}`).toBeLessThanOrEqual(
        max,
      );
      expect(roundtripClean(out), `${JSON.stringify(s)}/${max} 产生 U+FFFD`).toBe(true);
    }
  });

  it('回归:截断点落在代理对中间 → 不返回孤代理项', () => {
    expect(roundtripClean(truncateBytes('a😀', 3))).toBe(true);
    // 旧实现返回 '\ude00'(孤低代理)→ 编码后 U+FFFD;且整对 '😀'(4B) 放不下 → 空。
    expect(truncateBytes('a😀', 3)).toBe('');
  });

  it('最优性:整对可容纳时从整对起保留后缀', () => {
    expect(truncateBytes('ab😀', 5)).toBe('b😀'); // 1+4=5 字节,整对放得下
    expect(truncateBytes('a😀b', 5)).toBe('😀b'); // 从代理对起点开始(5 字节)
    expect(truncateBytes('ab😀', 2)).toBe(''); // 2 字节放不下任何码点起后缀
  });

  it('已 ≤ maxBytes 时原样返回', () => {
    expect(truncateBytes('你', 3)).toBe('你');
    expect(truncateBytes('', 0)).toBe('');
  });
});

describe('容量不变量穷举(astral × maxBytes 扫描)', () => {
  it('多组字符串 × 多档上限:全部 ≤ maxBytes 且往返干净', () => {
    const samples = ['😀a', 'a😀b', '你😀好', '😀😀😀', 'abc', '中文字符串', 'a😀b你c😀d'];
    for (const s of samples) {
      for (let max = 0; max <= Buffer.byteLength(s, 'utf8') + 1; max += 1) {
        const p = truncateUtf8ToBytes(s, max);
        const q = truncateBytes(s, max);
        expect(
          Buffer.byteLength(p, 'utf8'),
          `${JSON.stringify(s)} prefix/${max}`,
        ).toBeLessThanOrEqual(max);
        expect(
          Buffer.byteLength(q, 'utf8'),
          `${JSON.stringify(s)} suffix/${max}`,
        ).toBeLessThanOrEqual(max);
        expect(roundtripClean(p), `${JSON.stringify(s)} prefix/${max} FFFD`).toBe(true);
        expect(roundtripClean(q), `${JSON.stringify(s)} suffix/${max} FFFD`).toBe(true);
      }
    }
  });
});
