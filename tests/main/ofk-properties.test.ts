import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { wsSlugOfWorkspace } from '../../src/main/ofk/ofk-bundle';
import { buildSessionConcept } from '../../src/main/ofk/session-writer';
import type { SessionCategory } from '../../src/shared/ofk-schema';
import {
  isValidOfkRef,
  parseConceptFrontmatter,
  parseSessionConcept,
} from '../../src/shared/ofk-schema';
import { makeFact } from './ofk-test-fixtures';

/**
 * OFK 属性测试(2026-08-13 证明批,fast-check 4.9.0):
 * - P1 round-trip:任意合法 SessionFact → buildSessionConcept → parseSessionConcept
 * 关键字段无损往返(确定性正文的解析闭环)。
 * - P2 slug 幂等:任意 workspace/collector → wsSlugOfWorkspace 不产出路径分隔符、
 * 再次施加同变换结果稳定(布局路径确定性)。
 * - P3 全称性:任意 Unicode 串喂给 frontmatter 解析器 → 不抛异常(对抗输入总全,
 * 解析器对恶意 frontmatter fail-lenient)。
 * - P4 ofkRef 形态:64 位 hex 迁移指针恒合法;含 .. 段的串恒非法。
 */

describe('OFK 属性( 不变量)', () => {
  it('P1 round-trip: 概念文档关键字段无损往返', () => {
    // 标题:yamlStr 契约 = trim 后序列化 → 生成器限定 trim 稳定、无换行(概念标题真源即如此)
    const title = fc
      .string({ minLength: 1, maxLength: 60 })
      .filter((s) => s === s.trim() && !/[\r\n]/.test(s));
    // 工具名:frontmatter 流式数组契约 = 标识符字符集(真源即如此)
    const toolName = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => /^[A-Za-z0-9._-]+$/.test(s));
    fc.assert(
      fc.property(
        fc.record({
          sessionRef: fc
            .string({ minLength: 1, maxLength: 40 })
            .filter((s) => /^[A-Za-z0-9._-]+$/.test(s)),
          title,
          workspace: fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s === s.trim()),
          start: fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 }),
          activeMs: fc.integer({ min: 0, max: 3_600_000 }),
          tokens: fc.integer({ min: 0, max: 100_000 }),
          tools: fc.array(toolName, { maxLength: 8 }),
          unfinished: fc.boolean(),
          containsTodo: fc.boolean(),
        }),
        (g) => {
          const fact = makeFact({
            sessionRef: g.sessionRef,
            title: g.title,
            workspace: g.workspace,
            start: g.start,
            end: g.start + 60_000,
            activeMs: g.activeMs,
            tokens: g.tokens,
            tools: g.tools,
            unfinished: g.unfinished,
            containsTodo: g.containsTodo,
          });
          const category: SessionCategory = 'programming';
          const doc = buildSessionConcept(fact, null, category);
          const parsed = parseSessionConcept(doc);
          expect(parsed).not.toBeNull();
          if (!parsed) return;
          expect(parsed.sessionRef).toBe(fact.sessionRef);
          expect(parsed.title).toBe(fact.title);
          expect(parsed.workspace).toBe(fact.workspace);
          expect(parsed.category).toBe(category);
          expect(Date.parse(parsed.start)).toBe(fact.start);
          expect(Date.parse(parsed.end)).toBe(fact.end);
          expect(parsed.activeMs).toBe(fact.activeMs);
          expect(parsed.tokens).toBe(fact.tokens);
          expect(parsed.unfinished).toBe(fact.unfinished);
          expect(parsed.containsTodo).toBe(fact.containsTodo);
          expect(parsed.tools).toEqual(fact.tools);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('P2 slug 幂等且无路径分隔符', () => {
    // 合法路径字符集(Windows 路径禁 <>"|?* 与控制字符;含 / \ : 分隔符)
    const legalPathChars = fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.:/\\'.split(''),
    );
    fc.assert(
      fc.property(
        fc.record({
          workspace: fc
            .array(legalPathChars, { minLength: 1, maxLength: 100 })
            .map((cs) => cs.join('')),
          collector: fc.constantFrom('pi-sdk', 'claude-code', 'opencode', 'oh-my-pi'),
        }),
        (g) => {
          const slug = wsSlugOfWorkspace(g.workspace, g.collector);
          expect(slug.length).toBeGreaterThan(0);
          expect(slug).not.toMatch(/[\\/:*?"<>|]/);
          // 幂等:slug 已是最简形态,再施加同变换不变
          const again = wsSlugOfWorkspace(slug, g.collector);
          expect(again).toBe(slug);
        },
      ),
      { numRuns: 200 },
    );
    // 非 pi 源:任意串(含非法字符)都被清洗到安全字符集(清洗器兜底)
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 80 }), (s) => {
        const slug = wsSlugOfWorkspace(s, 'claude-code');
        expect(slug).not.toMatch(/[\\/:*?"<>|]/);
        expect(slug.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('P3 全称性: 任意 Unicode 输入不使 frontmatter 解析器抛异常', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        // 对抗输入:解析器要么返回 null 要么返回结构化结果,永不 throw
        let fm: ReturnType<typeof parseConceptFrontmatter> | null | undefined;
        expect(() => {
          fm = parseConceptFrontmatter(s);
        }).not.toThrow();
        expect(() => {
          parseSessionConcept(s);
        }).not.toThrow();
        if (fm !== null && fm !== undefined) {
          expect(typeof fm.frontmatter).toBe('object');
          expect(typeof fm.body).toBe('string');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('P4 ofkRef 形态: 64 位 hex 指针恒合法,含 .. 段恒非法', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 64, maxLength: 64 }), (hexish) => {
        const ref = `/memory/${hexish}.md`;
        if (/^[A-Za-z0-9]+$/.test(hexish)) {
          expect(isValidOfkRef(ref)).toBe(true);
        } else {
          // 含非法字符的段 → 拒绝(校验不误放)
          expect(isValidOfkRef(ref)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
    // 穿越段形态恒拒绝
    for (const evil of [
      '/memory/../x.md',
      '/memory/a/../b.md',
      '/../x',
      '/memory/./x.md',
      '/memory//x.md',
    ]) {
      expect(isValidOfkRef(evil)).toBe(false);
    }
  });

  it('数值/布尔/null 形态标量 round-trip(确定性,防 fast-check 低概率采样漏网)', () => {
    // 这些形态是随机采样低概率区:title/tools 取 0、.0、5.、true、null、~、-1.5
    const title = '0';
    const tools = ['0', '.0', '5.', 'true', 'null', '~', '-1.5'];
    const fact = makeFact({
      sessionRef: 'sess-num',
      title,
      workspace: 'W',
      start: 1_700_000_000_000,
      end: 1_700_000_001_000,
      tools,
    });
    const doc = buildSessionConcept(fact, null, 'chat');
    const parsed = parseSessionConcept(doc);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.title).toBe(title);
    expect(parsed.tools).toEqual(tools);
  });
});
