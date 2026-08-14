import { describe, expect, it } from 'vitest';
import { extractMarkdownMeta } from '../../src/renderer/lib/markdown-meta';

describe('extractMarkdownMeta', () => {
  it('frontmatter title/tags + 正文内联 tag 合并去重保序', () => {
    const full = `---
title: 我的文档
tags:
  - alpha
  - '#beta'
---

正文 #alpha #gamma 继续 #beta 结尾
`;
    const meta = extractMarkdownMeta(full);
    expect(meta.title).toBe('我的文档');
    expect(meta.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('无 frontmatter:取第一个 H1 为标题,并从 body 删除该 H1', () => {
    const full = '# 大标题\n\n## 小节\n\n正文';
    const meta = extractMarkdownMeta(full);
    expect(meta.title).toBe('大标题');
    expect(meta.body).toBe('\n\n## 小节\n\n正文');
  });

  it('frontmatter title 优先于 H1', () => {
    const full = `---
title: 文档标题
---

# H1 标题

正文
`;
    const meta = extractMarkdownMeta(full);
    expect(meta.title).toBe('文档标题');
  });

  it('无 frontmatter 无 H1 → title=null,body 为全文', () => {
    const full = '只有正文\n没有标题';
    const meta = extractMarkdownMeta(full);
    expect(meta.title).toBeNull();
    expect(meta.body).toBe(full);
    expect(meta.tags).toEqual([]);
  });

  it('tags 字段为逗号分隔字符串时归一化为单元素数组', () => {
    const full = '---\ntitle: x\ntags: "single"\n---\n\n正文';
    const meta = extractMarkdownMeta(full);
    expect(meta.tags).toEqual(['single']);
  });

  it('toFull:body 偏移映射回原文偏移(frontmatter + H1 切除)', () => {
    const full = `---
title: 文档
---

# 标题

段落一

段落二
`;
    const meta = extractMarkdownMeta(full);
    // remark-frontmatter 的 yaml 节点 end.offset 含定界行尾换行 → fmEnd = 17。
    const paraOffset = meta.body.indexOf('段落一');
    expect(meta.toFull(paraOffset)).toBe(full.indexOf('段落一'));
    expect(meta.toFull(0)).toBe(17);
    expect(meta.toFull(meta.body.length)).toBe(full.length);
  });

  it('toFull:无 H1 时仅加 frontmatter 长度', () => {
    const full = '---\ntitle: x\n---\n\n正文';
    const meta = extractMarkdownMeta(full);
    expect(meta.body).toBe('\n\n正文');
    expect(meta.toFull(0)).toBe(full.indexOf('\n\n正文'));
    expect(meta.toFull(2)).toBe(full.indexOf('正文'));
    expect(meta.toFull(meta.body.length)).toBe(full.length);
  });

  it('heading 内的 #tag 不提取为标签(与渲染插件同规则)', () => {
    const full = '# 标题 #notag\n\n正文 #realtag';
    const meta = extractMarkdownMeta(full);
    expect(meta.tags).toEqual(['realtag']);
  });

  it('frontmatter title 为空字符串 → 回退 H1', () => {
    const full = '---\ntitle: ""\n---\n\n# 备用标题\n\n正文';
    const meta = extractMarkdownMeta(full);
    expect(meta.title).toBe('备用标题');
  });
});
