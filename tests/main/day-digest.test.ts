import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInvoke } from '../../src/main/memory/review-generator';
import {
  compileDay,
  composeDigestPrompt,
  dayDigestStaleGroups,
  ensureDayCompiled,
  readDayConcepts,
} from '../../src/main/ofk/day-digest';
import { dayConceptPath, readConcept } from '../../src/main/ofk/ofk-bundle';
import { DEFAULT_TAGS } from '../../src/shared/ofk-schema';
import { err, ok } from '../../src/shared/result';
import {
  at,
  FUTURE_GENERATED_AT,
  freshUserData,
  isoDay,
  seedConcept,
  seedDigest,
} from './ofk-test-fixtures';

// Requirement(step 4):每日摘要编译 —— 缺摘要 → invoke 一次并写回
// category + 日摘要;未过期(概念 generated.at ≤ 日摘要)→ 零 invoke;模型 Err →
// 整体 Err 且该工作区不写任何文件;空串分类落 未分类;category 写回
// 只动 frontmatter 其余字节不动。S7:tags 列表参与 stale 判定(tagsSig)。

const WS = 'C:\\work\\demo';
const SLUG = 'C--work-demo';
const DAY = isoDay(8);
const REF = 'sess-a1';

function digestJson(
  over: {
    categoryBySession?: Record<string, string>;
    segmentsBySession?: Record<string, unknown>;
    summaryBySession?: Record<string, string>;
    digest?: string;
  } = {},
) {
  return JSON.stringify({
    categoryBySession: over.categoryBySession ?? { [REF]: 'work' },
    ...(over.segmentsBySession !== undefined ? { segmentsBySession: over.segmentsBySession } : {}),
    ...(over.summaryBySession !== undefined ? { summaryBySession: over.summaryBySession } : {}),
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
    expect(concept.unwrapOr('') ?? '').toContain('category: 未分类'); // 未改动
  });

  it('空串分类值 → 未分类(自由 tag:非空串即合法,nonsense 原样写回)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const invoke: ModelInvoke = async () =>
      ok(digestJson({ categoryBySession: { [REF]: 'nonsense' } }));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const concept = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    expect(concept.unwrapOr('') ?? '').toContain('category: nonsense'); // 非空串即合法
  });

  it('summaryBySession → 概念 description 写回(LLM 归纳作块标题,非用户提示词)', async () => {
    await seedConcept({
      day: DAY,
      workspace: WS,
      sessionRef: REF,
      title: 'Complete assignment thoroughly',
      start: at(8, 9),
    });
    const invoke: ModelInvoke = async () =>
      ok(digestJson({ summaryBySession: { [REF]: '彻底完成作业:源码梳理与三项修复' } }));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const concept = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    const content = concept.unwrapOr('') ?? '';
    expect(content).toContain('description: 彻底完成作业:源码梳理与三项修复');
    // title 保持原始用户提示词(块标题展示由聚合层取 description 优先)
    expect(content).toContain('title: Complete assignment thoroughly');
  });

  it('summaryBySession 空串/非字符串 → 丢弃,description 保持播种初值', async () => {
    await seedConcept({
      day: DAY,
      workspace: WS,
      sessionRef: REF,
      title: 't-orig',
      start: at(8, 9),
    });
    const invoke: ModelInvoke = async () =>
      ok(digestJson({ summaryBySession: { [REF]: '   ' } as Record<string, string> }));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);

    const concept = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    expect(concept.unwrapOr('') ?? '').toContain('description: t-orig');
  });

  it('冻结会话 → summary 不写回(旧段逐字节不变,description 不动)', async () => {
    await seedConcept({
      day: DAY,
      workspace: WS,
      sessionRef: REF,
      title: 't-orig',
      start: at(8, 9),
    });
    // 先编译一次(写 description v1 + 摘要 generated 2099)
    await ensureDayCompiled(DAY, {
      invoke: async () => ok(digestJson({ summaryBySession: { [REF]: '归纳v1' } })),
    });
    const before = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    expect(before.unwrapOr('') ?? '').toContain('description: 归纳v1');

    // 概念未增长 + tags 一致 → 冻结:模型新 summary 不写回
    const invoke = vi.fn<ModelInvoke>(async () =>
      ok(digestJson({ summaryBySession: { [REF]: '归纳v2' } })),
    );
    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);
    expect(invoke).not.toHaveBeenCalled(); // 未过期 → 零 invoke
    const after = await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`);
    expect(after.unwrapOr('') ?? '').toContain('description: 归纳v1');
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

  it('segments 非法项逐条丢弃: 不可解析时间 / 非字符串 summary;category 非空串即合法', async () => {
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
    // 第 1 项(nonsense,2026-08-14 起非空串即合法)与第 3 项保留;第 3 项无 summary 行
    expect(digest).toContain('    category: nonsense');
    expect(digest).toContain('    start: 2026-08-08T08:00:00.000Z');
    expect(digest).toContain('    start: 2026-08-08T09:00:00.000Z');
    expect(digest).toContain('    end: 2026-08-08T09:30:00.000Z');
    expect(digest).not.toContain('not-a-date');
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

  it('存量摘要无 segments 键 + 概念未更新 → 零 invoke(2026-08-14 永久 stale 修复)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    // segments=null → 无 segments 块的存量摘要(generated.at 2099 新鲜值)
    await seedDigest(SLUG, DAY, '已有摘要', undefined, null);
    const invoke = vi.fn<ModelInvoke>(async () => ok(digestJson()));

    const result = await ensureDayCompiled(DAY, { invoke });
    expect(result.isOk()).toBe(true);
    // 不再因缺 segments 块重编译(该陷阱曾导致每次开页都 invoke)
    expect(invoke).not.toHaveBeenCalled();
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
    await seedConcept({
      day: DAY,
      workspace: OTHER,
      sessionRef: REF2,
      title: 't2',
      start: at(8, 10),
    });
    await seedDigest(SLUG_B, DAY, '新鲜摘要'); // B 新鲜 → 不进 stale

    const result = await dayDigestStaleGroups(DAY, [...DEFAULT_TAGS]);
    expect(result.isOk()).toBe(true);
    const groups = result.unwrapOr([]);
    expect(groups.map((g) => g.slug)).toEqual([SLUG]); // 只有 A(缺摘要)
    expect(groups[0].concepts).toHaveLength(1);
  });

  it('过期摘要(概念 generated.at > 摘要)→ 计入 stale 组', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    await seedDigest(SLUG, DAY, '旧摘要', '2026-01-01T00:00:00.000Z');

    const groups = await dayDigestStaleGroups(DAY, [...DEFAULT_TAGS]);
    expect(groups.unwrapOr([]).map((g) => g.slug)).toEqual([SLUG]);
  });

  it('全部新鲜 → 空组(零 invoke)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    await seedDigest(SLUG, DAY, '新鲜摘要');

    const groups = await dayDigestStaleGroups(DAY, [...DEFAULT_TAGS]);
    expect(groups.isOk()).toBe(true);
    expect(groups.unwrapOr([])).toEqual([]);
  });

  it('当日无概念 → 空组', async () => {
    const groups = await dayDigestStaleGroups(DAY, [...DEFAULT_TAGS]);
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
    await seedConcept({
      day: DAY,
      workspace: OTHER,
      sessionRef: REF2,
      title: 't2',
      start: at(8, 10),
    });
    const invoke = vi.fn<ModelInvoke>(async () => err({ code: 'model-error', message: 'boom' }));

    const result = await compileDay(DAY, { invoke });
    expect(result.isErr()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1); // 首个组失败 → 第二组不编译
  });

  it('tags 变化 → stale(即使概念与摘要均未动):tagsSig 不匹配即重编译', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    // 摘要以 DEFAULT_TAGS 编译过(新鲜,含 segments + 2099 generatedAt)
    await seedDigest(SLUG, DAY, '新鲜摘要');

    // 相同 tags → 空组
    const same = await dayDigestStaleGroups(DAY, [...DEFAULT_TAGS]);
    expect(same.unwrapOr([])).toEqual([]);

    // 不同 tags(用户新增标签)→ 组出现(触发全量重编译)
    const changed = await dayDigestStaleGroups(DAY, [...DEFAULT_TAGS, '写作']);
    expect(changed.unwrapOr([]).map((g) => g.slug)).toEqual([SLUG]);
  });

  it('存量摘要无 tags 行 → tagsSig 空 ≠ 当前列表 → stale(自动补齐 tags)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    await seedDigest(SLUG, DAY, '旧摘要', FUTURE_GENERATED_AT, undefined, null); // 无 tags 行

    const groups = await dayDigestStaleGroups(DAY, [...DEFAULT_TAGS]);
    expect(groups.unwrapOr([]).map((g) => g.slug)).toEqual([SLUG]);
  });
});

describe('composeDigestPrompt(plan S7 tags 入参)', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = freshUserData();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('composeDigestPrompt: prompt 携带 tags 列表(LLM 从列表选标签)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });
    const conceptsRes = await readDayConcepts(DAY);
    const concepts = conceptsRes.unwrapOr([]);

    const prompt = composeDigestPrompt(DAY, SLUG, concepts, ['工作', '写作']);
    expect(prompt).toContain('"tags": [\n    "工作",\n    "写作"\n  ]');
    expect(prompt).toContain(REF);
  });
});

describe('ensureDayCompiled 冻结(2026-08-14 增量编译)', () => {
  const REF2 = 'sess-freeze-b';

  let userdata: string;

  beforeEach(() => {
    userdata = freshUserData();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(userdata, { recursive: true, force: true });
  });

  function segSpec(category: string, summary: string, hour: number, minute = 0) {
    return {
      category,
      start: new Date(at(8, hour, minute)).toISOString(),
      end: new Date(at(8, hour, minute + 30)).toISOString(),
      summary,
    };
  }

  it('冻结:概念未增长的会话旧段逐字节保留;增长会话用模型新段;category 写回跳过冻结 ref', async () => {
    // refA:09:00 起(09:30 结束 → generatedAt 09:30)
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0)); // 第一次编译时刻(digest generatedAt = 12:00)
    try {
      // 第一次编译:refA 写入「旧段」
      const invoke1 = vi.fn<ModelInvoke>(async () =>
        ok(
          digestJson({
            segmentsBySession: { [REF]: [segSpec('阅读', '旧段', 9)] },
          }),
        ),
      );
      const r1 = await ensureDayCompiled(DAY, { invoke: invoke1 });
      expect(r1.isOk()).toBe(true);

      // 新增 refB:13:00 起(13:30 结束 → generatedAt 13:30 > digest 12:00 → 增长)
      await seedConcept({
        day: DAY,
        workspace: WS,
        sessionRef: REF2,
        title: 't2',
        start: at(8, 13),
      });

      // 第二次编译:模型对 refA/refB 都返回全新段 + category
      const invoke2 = vi.fn<ModelInvoke>(async () =>
        ok(
          digestJson({
            categoryBySession: { [REF]: '编程', [REF2]: '工作' },
            segmentsBySession: {
              [REF]: [segSpec('写作', '模型新段(应被冻结覆盖)', 9)],
              [REF2]: [segSpec('工作', 'refB 新段', 13)],
            },
          }),
        ),
      );
      const r2 = await ensureDayCompiled(DAY, { invoke: invoke2 });
      expect(r2.isOk()).toBe(true);
      expect(invoke2).toHaveBeenCalledTimes(1);

      const digest = (await readConcept(dayConceptPath(SLUG, DAY))).unwrapOr('') ?? '';
      // refA 段 = 第一次内容(冻结,逐字节不变)
      expect(digest).toContain('    category: 阅读');
      expect(digest).toContain('    summary: 旧段');
      expect(digest).not.toContain('    category: 写作');
      expect(digest).not.toContain('模型新段');
      // refB 段 = 模型新段
      expect(digest).toContain('    summary: refB 新段');
      // category 写回:冻结 refA 跳过(保持第一次编译的 work,不被模型 '编程' 覆盖),
      // 增长 refB 写 工作
      const conceptA =
        (await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF}.md`)).unwrapOr('') ?? '';
      expect(conceptA).toContain('category: work');
      expect(conceptA).not.toContain('category: 编程');
      const conceptB =
        (await readConcept(`sessions/${SLUG}/2026/${DAY}/${REF2}.md`)).unwrapOr('') ?? '';
      expect(conceptB).toContain('category: 工作');
    } finally {
      vi.useRealTimers();
    }
  });

  it('删减可达:tag 列表变化 → 全量重编译(冻结关闭,模型输出整体替换)', async () => {
    await seedConcept({ day: DAY, workspace: WS, sessionRef: REF, title: 't', start: at(8, 9) });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0));
    try {
      const invoke1 = vi.fn<ModelInvoke>(async () =>
        ok(
          digestJson({
            segmentsBySession: { [REF]: [segSpec('工作', '第一版', 9)] },
          }),
        ),
      );
      const r1 = await ensureDayCompiled(DAY, { invoke: invoke1, tags: ['工作', '写作'] });
      expect(r1.isOk()).toBe(true);

      // tags 变化(新增「设计」)→ 冻结关闭 → 旧段被模型输出整体替换
      const invoke2 = vi.fn<ModelInvoke>(async () =>
        ok(
          digestJson({
            segmentsBySession: { [REF]: [segSpec('设计', '第二版', 9)] },
          }),
        ),
      );
      const r2 = await ensureDayCompiled(DAY, {
        invoke: invoke2,
        tags: ['工作', '写作', '设计'],
      });
      expect(r2.isOk()).toBe(true);
      expect(invoke2).toHaveBeenCalledTimes(1);

      const digest = (await readConcept(dayConceptPath(SLUG, DAY))).unwrapOr('') ?? '';
      expect(digest).toContain('summary: 第二版');
      expect(digest).not.toContain('第一版');
      // 摘要记录新 tags(下次同 tags 不再 stale)
      expect(digest).toContain('tags: [工作, 写作, 设计]');
      const again = await ensureDayCompiled(DAY, {
        invoke: invoke2,
        tags: ['工作', '写作', '设计'],
      });
      expect(again.isOk()).toBe(true);
      expect(invoke2).toHaveBeenCalledTimes(1); // 未再触发
    } finally {
      vi.useRealTimers();
    }
  });
});
