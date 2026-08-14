import { describe, expect, it } from 'vitest';
import { SEGMENT_BREAK_GAP_MS } from '../../src/shared/gap';
import {
  parseConceptFrontmatter,
  parseDigestSegments,
  parseSessionConcept,
} from '../../src/shared/ofk-schema';

// Requirement(plan Step 3):ofk-schema 解析器支持多行块映射(`- k: v` 项后
// 缩进更深的 `k: v` 行并入该项映射)——日摘要 segments 块解析的前置;标量
// 列表项与单行映射行为不变;parseDigestSegments 逐条校验非法项丢弃。

describe('parseConceptFrontmatter 多行块映射', () => {
  it('segments 块: `- ref: x` 项吸收其下缩进更深的 category/start/end 行', () => {
    const md = [
      '---',
      'type: Daily Digest',
      'segments:',
      '  - ref: sess-a',
      '    category: reading',
      '    start: 2026-08-13T10:00:00.000Z',
      '    end: 2026-08-13T10:30:00.000Z',
      '  - ref: sess-a',
      '    category: chat',
      '    start: 2026-08-13T10:30:00.000Z',
      '    end: 2026-08-13T11:00:00.000Z',
      '---',
      '',
      'body',
    ].join('\n');
    const parsed = parseConceptFrontmatter(md);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.segments).toEqual([
      {
        ref: 'sess-a',
        category: 'reading',
        start: '2026-08-13T10:00:00.000Z',
        end: '2026-08-13T10:30:00.000Z',
      },
      {
        ref: 'sess-a',
        category: 'chat',
        start: '2026-08-13T10:30:00.000Z',
        end: '2026-08-13T11:00:00.000Z',
      },
    ]);
  });

  it('summary 行(含引号包裹的冒号)并入项映射', () => {
    const md = [
      '---',
      'segments:',
      '  - ref: s1',
      '    category: work',
      '    start: 2026-08-13T09:00:00.000Z',
      '    end: 2026-08-13T09:30:00.000Z',
      '    summary: "讨论: 方案"',
      '---',
      '',
      'x',
    ].join('\n');
    const parsed = parseConceptFrontmatter(md);
    expect(parsed?.frontmatter.segments).toEqual([
      {
        ref: 's1',
        category: 'work',
        start: '2026-08-13T09:00:00.000Z',
        end: '2026-08-13T09:30:00.000Z',
        summary: '讨论: 方案',
      },
    ]);
  });

  it('标量列表项行为不变: `- item` 后更深缩进行不并入', () => {
    const md = ['---', 'tags:', '  - alpha', '    beta', '  - gamma', '---', '', 'x'].join('\n');
    const parsed = parseConceptFrontmatter(md);
    expect(parsed?.frontmatter.tags).toEqual(['alpha', 'gamma']);
  });

  it('单行映射列表项(无更深缩进行)行为不变', () => {
    const md = ['---', 'sources:', '  - id: pi-sdk', '  - id: claude', '---', '', 'x'].join('\n');
    const parsed = parseConceptFrontmatter(md);
    expect(parsed?.frontmatter.sources).toEqual([{ id: 'pi-sdk' }, { id: 'claude' }]);
  });

  it('概念文档 sources 块: resource 行并入 id 项(既有文档形态受益,不破坏解析)', () => {
    const md = [
      '---',
      'type: Session',
      'title: t',
      'start: 2026-08-08T01:00:00.000Z',
      'end: 2026-08-08T01:05:00.000Z',
      'sources:',
      '  - id: pi-sdk',
      '    resource: C:\\src\\s.jsonl',
      'generated: { by: process:lorra-cleanse/1, at: 2026-08-08T01:05:00.000Z }',
      '---',
      '',
      'body',
    ].join('\n');
    const parsed = parseConceptFrontmatter(md);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.sources).toEqual([{ id: 'pi-sdk', resource: 'C:\\src\\s.jsonl' }]);
    expect(parsed?.frontmatter.generated).toEqual({
      by: 'process:lorra-cleanse/1',
      at: '2026-08-08T01:05:00.000Z',
    });
    // 概念文档整体解析不受影响
    const doc = parseSessionConcept(md);
    expect(doc).not.toBeNull();
  });
});

describe('parseDigestSegments', () => {
  function fmWithSegments(segments: unknown): Record<string, unknown> {
    return { type: 'Daily Digest', segments };
  }

  it('合法 segments 块 → 返回段列表(ref/category/start/end/summary)', () => {
    const fm = fmWithSegments([
      {
        ref: 'sess-a',
        category: 'reading',
        start: '2026-08-13T10:00:00.000Z',
        end: '2026-08-13T10:30:00.000Z',
        summary: '读第三章',
      },
    ]);
    expect(parseDigestSegments(fm)).toEqual([
      {
        ref: 'sess-a',
        category: 'reading',
        start: '2026-08-13T10:00:00.000Z',
        end: '2026-08-13T10:30:00.000Z',
        summary: '读第三章',
      },
    ]);
  });

  it('无 segments 键 → []', () => {
    expect(parseDigestSegments({ type: 'Daily Digest' })).toEqual([]);
    expect(parseDigestSegments({})).toEqual([]);
  });

  it('segments 非数组 → []', () => {
    expect(parseDigestSegments(fmWithSegments('nope'))).toEqual([]);
    expect(parseDigestSegments(fmWithSegments({ ref: 'x' }))).toEqual([]);
  });

  it('非法条目逐条丢弃: 非法 category / 缺 start / 缺 ref / 时间不可解析', () => {
    const fm = fmWithSegments([
      {
        ref: 'a',
        category: 'nonsense',
        start: '2026-08-13T10:00:00.000Z',
        end: '2026-08-13T10:30:00.000Z',
      },
      { ref: 'b', category: 'work', start: '2026-08-13T10:00:00.000Z' }, // 缺 end
      {
        ref: '',
        category: 'work',
        start: '2026-08-13T10:00:00.000Z',
        end: '2026-08-13T10:30:00.000Z',
      }, // 空 ref
      { ref: 'c', category: 'work', start: 'not-a-date', end: '2026-08-13T10:30:00.000Z' }, // start 不可解析
      {
        ref: 'd',
        category: 'chat',
        start: '2026-08-13T11:00:00.000Z',
        end: '2026-08-13T11:30:00.000Z',
        summary: 42, // summary 非字符串 → 丢弃 summary 但保留条目
      },
    ]);
    expect(parseDigestSegments(fm)).toEqual([
      {
        ref: 'd',
        category: 'chat',
        start: '2026-08-13T11:00:00.000Z',
        end: '2026-08-13T11:30:00.000Z',
      },
    ]);
  });

  it('全部非法 → []', () => {
    const fm = fmWithSegments([
      {
        ref: 'x',
        category: 'bad',
        start: '2026-08-13T10:00:00.000Z',
        end: '2026-08-13T10:30:00.000Z',
      },
    ]);
    expect(parseDigestSegments(fm)).toEqual([]);
  });

  it('端到端: 真实日摘要 frontmatter → parseConceptFrontmatter → parseDigestSegments', () => {
    const md = [
      '---',
      'type: Daily Digest',
      'title: 2026-08-13 摘要',
      'date: 2026-08-13',
      'workspace: C--work-demo',
      'generated: { by: process:lorra-digest/1, at: 2026-08-13T12:00:00.000Z }',
      'segments:',
      '  - ref: sess-a',
      '    category: reading',
      '    start: 2026-08-13T10:00:00.000Z',
      '    end: 2026-08-13T10:30:00.000Z',
      '    summary: "读第三章: 时间线"',
      '  - ref: sess-b',
      '    category: nonsense',
      '    start: 2026-08-13T11:00:00.000Z',
      '    end: 2026-08-13T11:30:00.000Z',
      '---',
      '',
      '正文',
    ].join('\n');
    const parsed = parseConceptFrontmatter(md);
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error('expected parsed frontmatter');
    expect(parseDigestSegments(parsed.frontmatter)).toEqual([
      {
        ref: 'sess-a',
        category: 'reading',
        start: '2026-08-13T10:00:00.000Z',
        end: '2026-08-13T10:30:00.000Z',
        summary: '读第三章: 时间线',
      },
    ]);
  });

  it('SEGMENT_BREAK_GAP_MS 断口常量存在且 = 15 分钟(供 Step 4 边界测试引用)', () => {
    expect(SEGMENT_BREAK_GAP_MS).toBe(15 * 60 * 1000);
  });
});
