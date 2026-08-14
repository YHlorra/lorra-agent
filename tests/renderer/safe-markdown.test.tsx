/**
 * SafeMarkdown 对抗测试(2026-08-13 证明批)——技能描述等第三方 markdown 的渲染安全。
 *
 * 规范真源: 2026-08-12/13 spec「渲染纪律」+「信任边界声明」
 * (技能内容 = 指令级信任,但 UI 渲染仍需协议消毒)。
 *
 * 消毒契约(src/renderer/safe-markdown.tsx):
 * - <a href>:仅 https?:// | mailto: | # | / ;javascript:/data:/vbscript:/file: 一律剥除。
 * - <img src>:仅 https?:// 或 ./ ../ 相对路径;javascript:/data: 一律剥除。
 * - 原始 HTML:react-markdown 默认不渲染(不执行)。
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SafeMarkdown } from '../../src/renderer/safe-markdown';

function anchors(content: string): HTMLAnchorElement[] {
  const { container } = render(<SafeMarkdown content={content} />);
  return Array.from(container.querySelectorAll('a'));
}

function imgs(content: string): HTMLImageElement[] {
  const { container } = render(<SafeMarkdown content={content} />);
  return Array.from(container.querySelectorAll('img'));
}

describe('SafeMarkdown 协议消毒(对抗)', () => {
  it('链接语法 javascript: 被剥除 href', () => {
    const [a] = anchors('[x](javascript:alert(1))');
    expect(a).toBeDefined();
    expect(a.hasAttribute('href')).toBe(false);
  });

  it('链接语法 data: / vbscript: 被剥除 href', () => {
    for (const url of ['data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
      const [a] = anchors(`[x](${url})`);
      expect(a.hasAttribute('href')).toBe(false);
    }
  });

  it('合法 https / mailto 链接保留 href', () => {
    const [httpsA] = anchors('[ok](https://example.com/skill)');
    expect(httpsA.getAttribute('href')).toBe('https://example.com/skill');
    const [mailA] = anchors('[ok](mailto:a@b.c)');
    expect(mailA.getAttribute('href')).toBe('mailto:a@b.c');
  });

  it('图片语法 javascript: / data: 被剥除 src', () => {
    const [jsImg] = imgs('![i](javascript:alert(1))');
    expect(jsImg).toBeDefined();
    expect(jsImg.hasAttribute('src')).toBe(false);
    const [dataImg] = imgs('![i](data:image/png;base64,AAAA)');
    expect(dataImg).toBeDefined();
    expect(dataImg.hasAttribute('src')).toBe(false);
  });

  it('原始 HTML(script / img onerror)不渲染不执行', () => {
    const { container } = render(
      <SafeMarkdown content={'<script>window.__xss = 1</script><img src=x onerror="window.__xss=2">正常文本'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined();
    expect(container.textContent).toContain('正常文本');
  });
});
