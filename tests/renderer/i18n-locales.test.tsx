import { describe, expect, it } from 'vitest';
import en from '../../src/shared/locales/en.json';
import zh from '../../src/shared/locales/zh.json';

describe('locales 词条完整性()', () => {
  it('en.json 覆盖 zh.json 全部词条(防漏翻)', () => {
    const zhKeys = Object.keys(zh);
    const missingInEn = zhKeys.filter((k) => !(k in en));
    expect(missingInEn).toEqual([]);
  });

  it('en.json 无多余词条(防双语漂移)', () => {
    const enKeys = Object.keys(en);
    const extraInEn = enKeys.filter((k) => !(k in zh));
    expect(extraInEn).toEqual([]);
  });
});
