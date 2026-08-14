import { describe, expect, it } from 'vitest';
import { setMainLanguage, tMain } from '../../src/main/i18n';

// main 进程语言缓存:setMainLanguage 切换后 tMain 立即用新语言。
// 变异测试发现「setMainLanguage 被忽略」分支无测试覆盖,补此文件钉死。
describe('main 进程 i18n 缓存', () => {
  it('默认 zh,setMainLanguage(en) 后 tMain 输出英文', () => {
    setMainLanguage('zh');
    expect(tMain('errors.memory.noChange')).toBe('内容未变化');

    setMainLanguage('en');
    expect(tMain('errors.memory.noChange')).toBe('Content unchanged');

    setMainLanguage('zh');
    expect(tMain('errors.memory.noChange')).toBe('内容未变化');
  });

  it('带参数词条在 en 下插值', () => {
    setMainLanguage('en');
    expect(tMain('errors.webTools.searchFailed', { message: 'boom' })).toBe(
      'web_search failed: boom',
    );
  });
});
