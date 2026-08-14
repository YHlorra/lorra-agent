import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ReviewMeta, ReviewStore } from '../../src/main/memory/review-store';
import type { Result } from '../../src/shared/result';

// Requirement: 报告存档与历史 —— 生成报告以 Markdown 存档至 reviews 目录，
// 历史列表按时间倒序；应用内阅读 MUST NOT 修改报告原文。
// 同款契约：open 不建目录（目录不存在 -> Err）。

function meta(overrides: Partial<ReviewMeta> = {}): ReviewMeta {
  return {
    id: 'review-1',
    kind: 'daily',
    dateISO: '2026-08-08',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  // better-result 联合类型:isOk 断言后经 match 窄化取 value。
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function expectErr(result: {
  isErr(): boolean;
  match(handlers: {
    ok: () => unknown;
    err: (e: { code: string; message: string }) => string;
  }): string;
}): string {
  expect(result.isErr()).toBe(true);
  return result.match({
    ok: () => {
      throw new Error('expected Err, got Ok');
    },
    err: (e) => e.code,
  });
}

describe('ReviewStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-reviews-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('open 已存在目录 Ok; save 落盘（reviews 目录出现报告文件）', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    const saved = store.save(meta(), '# 复盘报告\n\n正文');
    expect(saved.isOk()).toBe(true);

    expect(readdirSync(dir).length).toBeGreaterThan(0); // 目录新增对应报告文件
    store.close();
  });

  it('save 返回与输入一致的 meta', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    const m = meta();
    const saved = expectOk<ReviewMeta>(store.save(m, '# x'));
    expect(saved).toEqual(m);
    store.close();
  });

  it('报告持久化: save 后 list 出现该条目（Scenario 报告持久化）', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    const m = meta();
    store.save(m, '# x');

    const listed = expectOk<ReviewMeta[]>(store.list());
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(m);
    store.close();
  });

  it('list 按时间倒序（createdAt 降序）', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    store.save(meta({ id: 'old', createdAt: 1_000 }));
    store.save(meta({ id: 'mid', createdAt: 2_000 }));
    store.save(meta({ id: 'new', createdAt: 3_000 }));

    const listed = expectOk<ReviewMeta[]>(store.list());
    expect(listed.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    store.close();
  });

  it('read 回读一致: meta 与 markdown 原文与保存时相同', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    const m = meta();
    const markdown = '# 每日复盘\n\n- 要点一\n- 要点二\n';
    store.save(m, markdown);

    const readBack = expectOk<{ meta: ReviewMeta; markdown: string }>(store.read(m.id));
    expect(readBack.meta).toEqual(m);
    expect(readBack.markdown).toBe(markdown);
    store.close();
  });

  it('应用内阅读只读: 重复 read 内容一致, 文件字节不被修改', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    const m = meta();
    const markdown = '# 复盘报告\n\n原文内容';
    store.save(m, markdown);

    const filesBefore = new Map(readdirSync(dir).map((f) => [f, statSync(path.join(dir, f)).size]));
    const first = expectOk<{ markdown: string }>(store.read(m.id));
    const second = expectOk<{ markdown: string }>(store.read(m.id));

    expect(first.markdown).toBe(markdown);
    expect(second.markdown).toBe(first.markdown);
    for (const [f, size] of filesBefore) {
      expect(statSync(path.join(dir, f)).size).toBe(size); // 阅读不改文件
    }
    store.close();
  });

  it('退化: read 缺失 id -> Err', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    expectErr(store.read('does-not-exist'));
    store.close();
  });

  it('退化: read 损坏的报告文件 -> Err', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    // 报告文件布局由实现决定；写一份无法解析的垃圾文件模拟损坏。
    writeFileSync(path.join(dir, 'corrupt.md'), 'not a review file {{{');
    expectErr(store.read('corrupt'));
    store.close();
  });

  it('退化: 非法 id（路径穿越/分隔符/空格/中文/空串）save 与 read 均 Err（#N3 SAFE_ID）', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    // '../' 路径穿越、'/' 与 '\\' 分隔符、空格、中文、空串 —— 一律拒绝。
    const badIds = ['../evil', 'a/b', 'a\\b', 'my review', '复盘报告', ''];
    for (const bad of badIds) {
      expect(expectErr(store.save(meta({ id: bad }), '# x'))).toBe('review-invalid-id');
      expect(expectErr(store.read(bad))).toBe('review-invalid-id');
    }
    // 非法 id 不落盘。
    expect(readdirSync(dir)).toHaveLength(0);
    store.close();
  });

  it('旧存档兼容: meta 缺 modules 不报错, 旧版带 modules 字段的文件也能读（方向修正）', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    // 新形状:无 modules 的 meta 正常存档与回读。
    const m = meta();
    store.save(m, '# x');
    const readBack = expectOk<{ meta: ReviewMeta; markdown: string }>(store.read(m.id));
    expect(readBack.meta).toEqual(m);
    expect('modules' in readBack.meta).toBe(false);
    // 旧版存档:meta 首行带 modules 字段 —— 多余字段被容忍,读取不报错。
    writeFileSync(
      path.join(dir, 'legacy.md'),
      `${JSON.stringify({ ...m, modules: ['summary'] })}\n# 旧报告`,
      'utf8',
    );
    const legacy = expectOk<{ meta: ReviewMeta; markdown: string }>(store.read('legacy'));
    expect(legacy.markdown).toBe('# 旧报告');
    store.close();
  });

  it('退化: open 目录不存在 -> Err（同款契约，不建目录）', () => {
    expectErr(ReviewStore.open(path.join(dir, 'missing', 'nested')));
  });

  it('退化: open 指向文件路径 -> Err', () => {
    const filePath = path.join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    expectErr(ReviewStore.open(filePath));
  });

  it('持久化: close 后重新 open, list/read 数据仍在', () => {
    const store = expectOk<ReviewStore>(ReviewStore.open(dir));
    const m = meta();
    store.save(m, '# 持久化报告');
    store.close();

    const reopened = expectOk<ReviewStore>(ReviewStore.open(dir));
    const listed = expectOk<ReviewMeta[]>(reopened.list());
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(m.id);
    expect(expectOk<{ markdown: string }>(reopened.read(m.id)).markdown).toBe('# 持久化报告');
    reopened.close();
  });
});
