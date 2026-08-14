import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInvoke } from '../../src/main/memory/review-generator';
import { compileDay, dayDigestStaleGroups, ensureDayCompiled } from '../../src/main/ofk/day-digest';
import { dayConceptPath, readConcept } from '../../src/main/ofk/ofk-bundle';
import { err, ok } from '../../src/shared/result';
import { at, freshUserData, isoDay, seedConcept, seedDigest } from './ofk-test-fixtures';

// Requirement(step 4):每日摘要编译 —— 缺摘要 → invoke 一次并写回
// category + 日摘要;未过期(概念 generated.at ≤ 日摘要)→ 零 invoke;模型 Err →
// 整体 Err 且该工作区不写任何文件;分类非法值落 uncategorized;category 写回
// 只动 frontmatter 其余字节不动。

const WS = 'C:\\work\\demo';
const SLUG = 'C--work-demo';
const DAY = isoDay(8);
const REF = 'sess-a1';

function digestJson(
  over: {
    categoryBySession?: Record<string, string>;
    segmentsBySession?: Record<string, unknown>;
    digest?: string;
  } = {},
) {
  return JSON.stringify({
    categoryBySession: over.categoryBySession ?? { [REF]: 'work' },
    ...(over.segmentsBySession !== undefined ? { segmentsBySession: over.segmentsBySession } : {}),
    digest: over.digest ?? '今日主要修复了登录测试',
  });
}

describe('ensureDayCompiled', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = freshUserData();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('缺摘要 → invoke 一次,写日摘要 + category 写回', async () => {
    await seedConcept({
      day: DAY,
      workspace: WS,
      sessionRef: REF,
      title: '修复登录测试',
      start: at(8, 9),
    });
    const invoke = vi.fn<ModelInvoke>(async (prompt) => {
      expect(prompt).toContain(REF); // prompt 含会话清单
      return ok(digestJson());
    });

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);

    // 日摘要落盘
    const digest = await readConcept(dayConceptPath(SLUG, DAY));
    expect(digest.isOk()).toBe(true);
    expect(digest.unwrapOr('') ?? '').toContain('type: Daily Digest');
    expect(digest.unwrapOr('') ?? '').toContain('今日主要修复了登录测试');

    // category 写回:概念 frontmatter 变为 work
    const concept = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    const content = concept.unwrapOr('') ?? '';
    expect(content).toContain('category: work');
  });

  it('未过期(概念 generated.at ≤ 日摘要)→ 零 invoke,不重写', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    await seedDigest(SLUG, DAY, '已有摘要');
    const invoke = vi.fn<ModelInvoke>(async () => ok(digestJson()));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();

    // 摘要未被覆盖
    const digest = await readConcept(dayConceptPath(SLUG, DAY));
    expect(digest.unwrapOr('') ?? '').toContain('已有摘要');
  });

  it('模型 Err → 整体 Err,不写日摘要也不改 category', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const invoke: ModelInvoke = async () => err({ code: 'model-unavailable', message: 'no model' });

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isErr()).toBe(true);
    expect(result.match({ ok: () => '', err: (e) => e.code })).toBe('model-unavailable');

    const digest = await readConcept(dayConceptPath(SLUG, DAY));
    expect(digest.isOk()).toBe(true);
    expect(digest.unwrapOr(null)).toBeNull(); // 无日摘要写出

    const concept = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    expect(concept.unwrapOr('') ?? '').toContain('category: uncategorized'); // 未改动
  });

  it('分类非法值 → uncategorized', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const invoke: ModelInvoke = async () =>
      ok(digestJson({ categoryBySession: { [REF]: 'nonsense' } }));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const concept = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    expect(concept.unwrapOr('') ?? '').toContain('category: uncategorized');
  });

  it('category 写回只动 frontmatter 行,其余字节不动', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const before = (await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`)).unwrapOr('') ?? '';
    const invoke: ModelInvoke = async () => ok(digestJson());

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const after = (await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`)).unwrapOr('') ?? '';
    // 剥掉 category 行后逐字节一致
    const stripCategory = (s: string) => s.replace(/^category:.*$/m, '');
    expect(stripCategory(after)).toBe(stripCategory(before));
    expect(after).toContain('category: work');
  });

  it('模型未给某会话类别 → 该概念 category 保持现值(不落 uncategorized)', async () => {
    await seedConcept({
      day: DAY,
      workspace: WS,
      sessionRef: REF,
      title: 't',
      start: at(8, 9),
      category: 'chat',
    });
    const invoke: ModelInvoke = async () =>
      ok(JSON.stringify({ digest: '今日摘要', categoryBySession: {} }));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const concept = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    expect(concept.unwrapOr('') ?? '').toContain('category: chat'); // 保持现值
  });

  it('fence-tolerant: 模型输出包在 ```json 围栏内也可解析', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const invoke: ModelInvoke = async () => ok(`\`\`\`json\n${digestJson()}\n\`\`\``);

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);
    const digest = await readConcept(dayConceptPath(SLUG, DAY));
    expect(digest.unwrapOr('') ?? '').toContain('今日主要修复了登录测试');
  });

  it('segmentsBySession → 日摘要 frontmatter 写 segments 块(D3 形态),category 写回正常', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const invoke: ModelInvoke = async () =>
      ok(
        digestJson({
          segmentsBySession: {
            [REF]: [
              {
                category: 'reading',
                start: '2026-08-08T08:00:00.000Z',
                end: '2026-08-08T08:30:00.000Z',
                summary: '读方案',
              },
              {
                category: 'chat',
                start: '2026-08-08T08:30:00.000Z',
                end: '2026-08-08T09:00:00.000Z',
              },
            ],
          },
        }),
      );

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const digest = (await readConcept(dayConceptPath(SLUG, DAY))).unwrapOr('') ?? '';
    expect(digest).toContain('segments:');
    expect(digest).toContain(`  - ref: ${REF}`);
    expect(digest).toContain('    category: reading');
    expect(digest).toContain('    start: 2026-08-08T08:00:00.000Z');
    expect(digest).toContain('    end: 2026-08-08T08:30:00.000Z');
    expect(digest).toContain('    summary: 读方案');
    expect(digest).toContain('    category: chat');
    // category 写回仍正常(协议升级不破坏既有路径)
    const concept =
      (await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`)).unwrapOr('') ?? '';
    expect(concept).toContain('category: work');
  });

  it('segments 非法项逐条丢弃: 非法 category / 不可解析时间 / 非字符串 summary', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const invoke: ModelInvoke = async () =>
      ok(
        digestJson({
          segmentsBySession: {
            [REF]: [
              {
                category: 'nonsense',
                start: '2026-08-08T08:00:00.000Z',
                end: '2026-08-08T08:30:00.000Z',
              },
              { category: 'work', start: 'not-a-date', end: '2026-08-08T08:30:00.000Z' },
              {
                category: 'work',
                start: '2026-08-08T09:00:00.000Z',
                end: '2026-08-08T09:30:00.000Z',
                summary: 42,
              },
            ],
          },
        }),
      );

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const digest = (await readConcept(dayConceptPath(SLUG, DAY))).unwrapOr('') ?? '';
    expect(digest).toContain('segments:');
    // 仅第 3 项保留(无 summary 行)
    expect(digest).toContain('    start: 2026-08-08T09:00:00.000Z');
    expect(digest).toContain('    end: 2026-08-08T09:30:00.000Z');
    expect(digest).not.toContain('not-a-date');
    expect(digest).not.toContain('nonsense');
    expect(digest).not.toContain('summary:');
  });

  it('无 segmentsBySession 键 → 日摘要不写 segments 块(空对象)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const invoke: ModelInvoke = async () => ok(digestJson());

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const digest = (await readConcept(dayConceptPath(SLUG, DAY))).unwrapOr('') ?? '';
    expect(digest).not.toContain('segments:');
  });

  it('存量摘要无 segments 键 → 视为需重编译(invoke 被调)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    // segments=null → 无 segments 块的存量摘要(即便 generated.at 是 2099 新鲜值)
    await seedDigest(SLUG, DAY, '已有摘要', undefined, null);
    const invoke = vi.fn<ModelInvoke>(async () => ok(digestJson()));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('摘要含 segments 块且未过期 → 零 invoke(带 segments 的存量摘要不重编译)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    // 缺省 segments(undefined)→ 写缺省 segments 块
    await seedDigest(SLUG, DAY, '已有摘要');
    const invoke = vi.fn<ModelInvoke>(async () => ok(digestJson()));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('dayDigestStaleGroups + compileDay 拆分(plan S5/D4)', () => {
  // 第二个工作区:D:\other → slug D--other(pi-sdk 编码)
  const OTHER = 'D:\\other';
  const SLUG_B = 'D--other';
  const REF2 = 'sess-b1';

  let userdata: string;

  beforeEach(() => {
    userdata = freshUserData();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('stale 组只含缺摘要/过期工作区;新鲜组不在其中(不 invoke)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    await seedConcept({ day: DAY, workspace: OTHER, sessionRef: REF2, title: 't2', start: at(8, 10) });
    await seedDigest(SLUG_B, DAY, '新鲜摘要'); // B 新鲜 → 不进 stale

    const result = await dayDigestStaleGroups(DAY);
    expect(result.isOk()).toBe(true);
    const groups = result.unwrapOr([]);
    expect(groups.map((g) => g.slug)).toEqual([SLUG]); // 只有 A(缺摘要)
    expect(groups[0].concepts).toHaveLength(1);
  });

  it('过期摘要(概念 generated.at > 摘要)→ 计入 stale 组', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    await seedDigest(SLUG, DAY, '旧摘要', '2026-01-01T00:00:00.000Z');

    const groups = await dayDigestStaleGroups(DAY);
    expect(groups.unwrapOr([]).map((g) => g.slug)).toEqual([SLUG]);
  });

  it('全部新鲜 → 空组(零 invoke)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    await seedDigest(SLUG, DAY, '新鲜摘要');

    const groups = await dayDigestStaleGroups(DAY);
    expect(groups.isOk()).toBe(true);
    expect(groups.unwrapOr([])).toEqual([]);
  });

  it('当日无概念 → 空组', async () => {
    const groups = await dayDigestStaleGroups(DAY);
    expect(groups.isOk()).toBe(true);
    expect(groups.unwrapOr([])).toEqual([]);
  });

  it('compileDay: 对 stale 组逐组 invoke;带 segments 的编译后二次零 invoke', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const invoke = vi.fn<ModelInvoke>(async () =>
      ok(
        digestJson({
          segmentsBySession: {
            [REF]: [
              {
                category: 'work',
                start: new Date(at(8, 9, 0)).toISOString(),
                end: new Date(at(8, 9, 30)).toISOString(),
              },
            ],
          },
        }),
      ),
    );

    const result = await compileDay(DAY, { invoke });
    expect(result.isOk()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);

    // 编译已写摘要(带 segments + generated.at=now > 概念 end)→ 二次不再编译
    const invoke2 = vi.fn<ModelInvoke>(async () => ok(digestJson()));
    const again = await compileDay(DAY, { invoke: invoke2 });
    expect(again.isOk()).toBe(true);
    expect(invoke2).not.toHaveBeenCalled();
  });

  it('compileDay: 首个组 Err → 整体 Err,后续组不 invoke', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    await seedConcept({ day: DAY, workspace: OTHER, sessionRef: REF2, title: 't2', start: at(8, 10) });
    const invoke = vi.fn<ModelInvoke>(async () => err({ code: 'model-error', message: 'boom' }));

    const result = await compileDay(DAY, { invoke });
    expect(result.isErr()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1); // 首个组失败 → 第二组不编译
  });
});
