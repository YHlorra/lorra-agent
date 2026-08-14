import fc from 'fast-check';
import { describe, it } from 'vitest';
import { type Lang, type MessageKey, translate } from '../../src/shared/i18n-core';
import zh from '../../src/shared/locales/zh.json';

// 属性不变量:翻译函数的三条全局不变量,fast-check 随机词条/输入验证。
const ALL_KEYS = Object.keys(zh) as MessageKey[];
const LANGS: Lang[] = ['zh', 'en'];

describe('translate 属性不变量 (fast-check)', () => {
  it('任一已定义词条在 zh/en 下都非空(en 缺词回退 zh 保证)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_KEYS),
        fc.constantFrom(...LANGS),
        (key, lang) => translate(lang, key).length > 0,
      ),
      { numRuns: 1000 },
    );
  });

  it('全部 {param} 占位符提供值后,输出无残留占位符', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_KEYS), (key) => {
        const template = translate('zh', key);
        const placeholders = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const params = Object.fromEntries(placeholders.map((name) => [name, 'VALUE']));
        const out = translate('zh', key, params);
        return !/\{\w+\}/.test(out);
      }),
      { numRuns: 1000 },
    );
  });

  it('未知 key 返回 key 本身,永不抛错(两种语言同行为)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (key) => {
        if (key in zh) return true; // 已定义词条不适用
        const asKey = key as MessageKey;
        return translate('zh', asKey) === key && translate('en', asKey) === key;
      }),
      { numRuns: 1000 },
    );
  });
});
