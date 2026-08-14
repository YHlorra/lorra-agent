import { describe, expect, it, vi } from 'vitest';

// en.json 只 mock 出部分词条:用于验证「en 缺词条回退 zh」的真实回退路径
// (完整词条环境下该分支无法触达)。mock 按 resolved 路径匹配,仅本文件生效。
vi.mock('../../src/shared/locales/en.json', () => ({
  default: {
    'nav.workspace': 'Workspace',
    'settings.workspace.recent.removeError': 'Failed to remove “{name}”. Try again.',
  },
}));

import { type MessageKey, translate } from '../../src/shared/i18n-core';

describe('translate(i18n 核心)', () => {
  it('zh 取中文字条', () => {
    expect(translate('zh', 'nav.workspace')).toBe('工作台');
    expect(translate('zh', 'settings.groups.appearance')).toBe('外观');
  });

  it('en 取英文字条', () => {
    expect(translate('en', 'nav.workspace')).toBe('Workspace');
  });

  it('en 缺词条回退 zh,不回退成空串', () => {
    // en.json mock 只含 nav.workspace;其余 key 走 zh 兜底。
    expect(translate('en', 'nav.today')).toBe('今日');
    expect(translate('en', 'settings.title')).toBe('设置');
  });

  it('未知 key 返回 key 本身,永不抛错', () => {
    expect(translate('zh', 'no.such.key' as MessageKey)).toBe('no.such.key');
    expect(translate('en', 'no.such.key' as MessageKey)).toBe('no.such.key');
  });

  it('{param} 插值替换为传入值', () => {
    expect(translate('zh', 'settings.workspace.recent.removeError', { name: 'proj-a' })).toBe(
      '移除「proj-a」失败，请重试',
    );
  });

  it('缺参数时占位符替换为空串', () => {
    expect(translate('zh', 'settings.workspace.recent.removeError', {})).toBe(
      '移除「」失败，请重试',
    );
  });

  it('数字参数转为字符串', () => {
    expect(translate('en', 'settings.workspace.recent.removeError', { name: 42 })).toBe(
      'Failed to remove “42”. Try again.',
    );
  });
});
