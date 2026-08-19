import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateReview, type ModelInvoke } from '../../src/main/memory/review-generator';
import { type ReviewMeta, ReviewStore } from '../../src/main/memory/review-store';
import { lorraConfigDir } from '../../src/main/pi-sdk-driver/lorra-config-dir';
import { getBuiltinSkillSeed } from '../../src/main/skills/builtin-skill-seeder';
import { MEMORY_CONTENT_MAX_BYTES, type MemoryEntry } from '../../src/shared/memory-schema';
import type { Result } from '../../src/shared/result';
import { err, ok } from '../../src/shared/result';
import type { ReviewRequest } from '../../src/shared/review-api';
import { freshUserData, seedConcept, seedDigest } from './ofk-test-fixtures';

// Requirement: 复盘技能文件（2026-08-18 起全局路径 ~/.lorra/skills）+ 每日/每周复盘生成
// （无硬编码模块勾选）。
// 契约:
// - ReviewRequest 无 modules 无 userPrompt: { kind, dateISO? }（PM 2026-08-08 取消
// 提示词引导——复盘重点由技能文件承载,用户直接改文件）
// - 技能文件 <lorraConfigDir>/skills/{daily,deep}-review.md:生成器只「读 + fallback」——
// 缺失时用内置种子(getBuiltinSkillSeed)兜底,**不写盘**(写盘由启动期 seedBuiltinSkills
// 负责,write-if-missing);磁盘当前内容为方法论提示,不覆盖。
// - generateReview(req, deps{ facts, invoke, store, workspacePath })

const SEEDS = fileURLToPath(new URL('../../src/main/skills/builtin-skill-seeds', import.meta.url));
const DAILY_SEED = path.join(SEEDS, 'daily-review.md');
const DEEP_SEED = path.join(SEEDS, 'deep-review.md');

function skillPath(workspace: string, kind: 'daily' | 'weekly'): string {
  return path.join(
    workspace,
    '.lorra',
    'skills',
    kind === 'daily' ? 'daily-review.md' : 'deep-review.md',
  );
}

function globalSkillPath(kind: 'daily' | 'weekly'): string {
  return path.join(
    lorraConfigDir(),
    'skills',
    kind === 'daily' ? 'daily-review.md' : 'deep-review.md',
  );
}

/** 清空全局技能目录(测试文件内共享同一 LORRA_E2E_USERDATA,防用例间泄漏)。 */
function resetGlobalSkills(): void {
  rmSync(path.join(lorraConfigDir(), 'skills'), { recursive: true, force: true });
}

/** 模拟用户已放置/修改技能文件(写全局路径;父目录可能尚不存在)。 */
function writeSkill(_workspace: string, kind: 'daily' | 'weekly', content: string): void {
  const file = globalSkillPath(kind);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function daily(dateISO = '2026-08-08'): ReviewRequest {
  return { kind: 'daily', dateISO };
}

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function expectErrCode(result: Result<unknown>): string {
  expect(result.isErr()).toBe(true);
  return result.match({
    ok: () => {
      throw new Error('expected Err, got Ok');
    },
    err: (e) => e.code,
  });
}

describe('generateReview（技能文件方法论）', () => {
  let workspace: string;
  let storeDir: string;
  let store: ReviewStore;

  let userdata: string;

  beforeEach(async () => {
    workspace = mkdtempSync(path.join(tmpdir(), 'lorra-review-ws-'));
    storeDir = mkdtempSync(path.join(tmpdir(), 'lorra-review-store-'));
    store = expectOk<ReviewStore>(ReviewStore.open(storeDir));
    // 全局技能目录:文件内共享同一 LORRA_E2E_USERDATA,先清空防用例间泄漏。
    resetGlobalSkills();
    // OFK bundle:概念 + 新鲜日摘要(2099)→ ensureDayCompiled 不触发真实模型。
    userdata = freshUserData();
    await seedConcept({
      day: '2026-08-08',
      workspace: 'C:\\work\\demo',
      sessionRef: 'sess-x',
      title: 'Fix the flaky login test',
    });
    await seedDigest('C--work-demo', '2026-08-08', '测试摘要');
  });
  afterEach(async () => {
    store.close();
    vi.unstubAllEnvs();
    // 蒸馏 hook 默认通道会打开共享 memory.db → 释放句柄后再删临时目录(Windows EBUSY)。
    const { resetSharedMemoryStoreForTest } = await import(
      '../../src/main/memory/shared-memory-store'
    );
    resetSharedMemoryStoreForTest();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(userdata, { recursive: true, force: true });
  });

  it('全局技能缺失时内置种子兜底 daily: 不写盘, prompt 用种子方法论', async () => {
    const wsSkill = skillPath(workspace, 'daily');
    const globalSkill = globalSkillPath('daily');
    expect(existsSync(wsSkill)).toBe(false);
    expect(existsSync(globalSkill)).toBe(false);

    let captured = '';
    const invoke = vi.fn<ModelInvoke>(async (prompt) => {
      captured = prompt;
      return ok('# 每日复盘');
    });
    const meta = expectOk<ReviewMeta>(
      await generateReview(daily(), {
        invoke,
        store,
        workspacePath: workspace,
      }),
    );

    // 生成器只读 + fallback,不写盘(写盘由启动期 seedBuiltinSkills 负责)。
    expect(existsSync(wsSkill)).toBe(false);
    expect(existsSync(globalSkill)).toBe(false);
    // 兜底内容 = 内置种子: prompt 含种子方法论片段(「全局概览」三层结构指引),
    // 且与 builtin-skill-seeds/daily-review.md 字节一致(?raw 保真 CRLF)。
    expect(captured).toContain('全局概览');
    expect(getBuiltinSkillSeed('daily-review')).toBe(readFileSync(DAILY_SEED, 'utf8'));
    expect(meta.kind).toBe('daily');
    expect(expectOk<ReviewMeta[]>(store.list())).toHaveLength(1);
  });

  it('全局技能缺失时内置种子兜底 deep: weekly 用 deep-review 种子, prompt 用其内容', async () => {
    const wsSkill = skillPath(workspace, 'weekly');
    expect(existsSync(wsSkill)).toBe(false);

    let captured = '';
    const invoke = vi.fn<ModelInvoke>(async (prompt) => {
      captured = prompt;
      return ok('# 每周深度复盘');
    });
    const meta = expectOk<ReviewMeta>(
      await generateReview(
        { kind: 'weekly', dateISO: '2026-08-08' },
        { invoke, store, workspacePath: workspace },
      ),
    );

    expect(existsSync(wsSkill)).toBe(false);
    expect(existsSync(globalSkillPath('weekly'))).toBe(false);
    expect(getBuiltinSkillSeed('deep-review')).toBe(readFileSync(DEEP_SEED, 'utf8'));
    expect(captured).toContain('项目 Roadmap 分析'); // deep 种子三维度之一
    expect(meta.kind).toBe('weekly');
  });

  it('个性化修改生效: 用户改全局技能文件后再生成, prompt 用修改后内容且文件不被覆盖', async () => {
    const custom = 'CUSTOM-METHODOLOGY: 重点分析 token 用量与工具效率\n';
    writeSkill(workspace, 'daily', custom);

    let captured = '';
    const invoke = vi.fn<ModelInvoke>(async (prompt) => {
      captured = prompt;
      return ok('# 每日复盘');
    });
    await generateReview(daily(), { invoke, store, workspacePath: workspace });

    expect(captured).toContain('CUSTOM-METHODOLOGY');
    // 生成器只读:已有文件保持用户修改,不被覆盖;工作区路径不产生副本。
    expect(readFileSync(globalSkillPath('daily'), 'utf8')).toBe(custom);
    expect(existsSync(skillPath(workspace, 'daily'))).toBe(false);
  });

  it('成功路径: 组装→prompt(技能内容+payload)→invoke→存档→返回 meta（无 modules）', async () => {
    writeSkill(workspace, 'daily', 'skill methodology body\n');
    let captured = '';
    const invoke = vi.fn<ModelInvoke>(async (prompt) => {
      captured = prompt;
      return ok('# 每日复盘\n\n报告正文');
    });

    const meta = expectOk<ReviewMeta>(
      await generateReview(daily(), {
        invoke,
        store,
        workspacePath: workspace,
      }),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(captured).toContain('skill methodology body');
    expect(captured).toContain('Fix the flaky login test'); // payload 内容
    expect(captured).toContain('totalConversations');
    expect(meta.kind).toBe('daily');
    expect(meta.dateISO).toBe('2026-08-08');
    expect(meta.id.length).toBeGreaterThan(0);
    expect(typeof meta.createdAt).toBe('number');
    // 新契约:meta 无 modules。
    expect('modules' in meta).toBe(false);

    const listed = expectOk<ReviewMeta[]>(store.list());
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(meta.id);
    const readBack = expectOk<{ meta: ReviewMeta; markdown: string }>(store.read(meta.id));
    expect(readBack.markdown).toBe('# 每日复盘\n\n报告正文');
    expect(readBack.meta).toEqual(meta);
  });

  it('weekly: 使用 deep-review 技能文件（deep 播种由首用用例覆盖, 此处钉 prompt 用 deep 内容）', async () => {
    writeSkill(workspace, 'weekly', 'DEEP-METHODOLOGY: roadmap/trends/research\n');
    let captured = '';
    const invoke = vi.fn<ModelInvoke>(async (prompt) => {
      captured = prompt;
      return ok('# 周报');
    });
    const meta = expectOk<ReviewMeta>(
      await generateReview(
        { kind: 'weekly', dateISO: '2026-08-08' },
        { invoke, store, workspacePath: workspace },
      ),
    );
    expect(captured).toContain('DEEP-METHODOLOGY');
    expect(meta.kind).toBe('weekly');
  });

  it('生成中途失败: invoke 返回 Err -> 整体 Err, 不落半成品报告文件', async () => {
    const invoke: ModelInvoke = async () =>
      err({ code: 'model-invoke-failed', message: 'provider timeout' });

    const result = await generateReview(daily(), {
      invoke,
      store,
      workspacePath: workspace,
    });

    expect(expectErrCode(result)).toBe('model-invoke-failed');
    expect(expectOk<ReviewMeta[]>(store.list())).toHaveLength(0);
    expect(readdirSync(storeDir).filter((f) => f.endsWith('.md'))).toHaveLength(0);
  });

  it('生成中途失败: invoke 抛异常 -> 整体 Err, 不落半成品', async () => {
    const invoke: ModelInvoke = async () => {
      throw new Error('boom');
    };

    const result = await generateReview(daily(), {
      invoke,
      store,
      workspacePath: workspace,
    });

    expect(expectErrCode(result)).toBe('model-invoke-failed');
    expect(expectOk<ReviewMeta[]>(store.list())).toHaveLength(0);
  });
});

// 蒸馏通道(design D11/D12, 落地锚点「蒸馏 hook」/ 任务 6.4):
// generateReview 成功后自动把报告提炼为一条记忆候选
// (kind=procedural_experience, source=review-distillation, evidence=extracted,
// scope=workspace + workspace=当前工作区, producer=review-distillation,
// basis=「复盘生成后自动蒸馏」), 直落 active(无闸门)。
// 蒸馏失败必须静默: 任何异常/Err 都不影响 generateReview 的 Ok 结果与报告存档。
describe('generateReview 蒸馏 hook（6.4）', () => {
  let workspace: string;
  let storeDir: string;
  let store: ReviewStore;

  let userdata: string;

  beforeEach(async () => {
    workspace = mkdtempSync(path.join(tmpdir(), 'lorra-review-ws-'));
    storeDir = mkdtempSync(path.join(tmpdir(), 'lorra-review-store-'));
    store = expectOk<ReviewStore>(ReviewStore.open(storeDir));
    resetGlobalSkills();
    userdata = freshUserData();
    await seedConcept({
      day: '2026-08-08',
      workspace: 'C:\\work\\demo',
      sessionRef: 'sess-x',
      title: 'Fix the flaky login test',
    });
    await seedDigest('C--work-demo', '2026-08-08', '测试摘要');
  });
  afterEach(async () => {
    store.close();
    vi.unstubAllEnvs();
    // 默认蒸馏通道可能打开过共享 memory.db 句柄 → 释放后再删临时目录(Windows EBUSY)。
    const { resetSharedMemoryStoreForTest } = await import(
      '../../src/main/memory/shared-memory-store'
    );
    resetSharedMemoryStoreForTest();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(userdata, { recursive: true, force: true });
  });

  // 真实 MemoryStore 落库断言依赖 6.2 shared-memory-store 落地; 未落地前该用例红
  // （依赖未落地允许红,须说明）。
  it('生成成功后自动蒸馏: 默认共享单例落一条 review-distillation 生效条目（字段契约）', async () => {
    const userdata = mkdtempSync(path.join(tmpdir(), 'lorra-review-distill-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
    const shared = await import('../../src/main/memory/shared-memory-store');
    try {
      writeSkill(workspace, 'daily', 'skill body\n');
      const invoke: ModelInvoke = async () => ok('# 每日复盘\n\n报告正文');
      const meta = expectOk<ReviewMeta>(
        await generateReview(daily(), {
          invoke,
          store,
          workspacePath: workspace,
        }),
      );

      // 报告正常存档（蒸馏是副产品,不替代存档）。
      expect(expectOk<ReviewMeta[]>(store.list())).toHaveLength(1);
      expect(meta.kind).toBe('daily');

      const memory = expectOk(shared.getSharedMemoryStore());
      // : 无候选列表,生效区按写入通道(source)过滤读回。
      const candidates = expectOk<MemoryEntry[]>(memory.listActive()).filter(
        (e) => e.source === 'review-distillation',
      ) as unknown as Array<Record<string, unknown>>;
      expect(candidates).toHaveLength(1);
      const [entry] = candidates;
      expect(entry.kind).toBe('procedural_experience');
      expect(entry.source).toBe('review-distillation');
      expect(entry.evidence).toBe('extracted');
      expect(entry.scope).toBe('workspace');
      expect(entry.workspace).toBe(workspace);
      expect(entry.producer).toBe('review-distillation');
      expect(entry.basis).toBe('复盘生成后自动蒸馏');
      expect(entry.title).toBe('每日复盘'); // 报告标题 = markdown 首个标题行
      expect(Buffer.byteLength(entry.content as string, 'utf8')).toBeLessThanOrEqual(
        MEMORY_CONTENT_MAX_BYTES,
      );
    } finally {
      vi.unstubAllEnvs();
      shared.resetSharedMemoryStoreForTest();
      rmSync(userdata, { recursive: true, force: true });
    }
  });

  it('未注入蒸馏写入（默认路径）时 generateReview 仍 Ok（store 不可用被静默吞掉）', async () => {
    writeSkill(workspace, 'daily', 'skill body\n');
    const invoke: ModelInvoke = async () => ok('# 每日复盘');
    // 不注入 proposeMemory:走默认共享单例;store 不可用(未落地/打开失败)时
    // 蒸馏异常被吞掉,Ok 结果不受影响。
    const meta = expectOk<ReviewMeta>(
      await generateReview(daily(), {
        invoke,
        store,
        workspacePath: workspace,
      }),
    );
    expect(meta.kind).toBe('daily');
    expect(expectOk<ReviewMeta[]>(store.list())).toHaveLength(1);
  });

  it('蒸馏入参契约: kind/source/evidence/scope/workspace/producer/basis/title 全量落位', async () => {
    writeSkill(workspace, 'daily', 'skill body\n');
    const proposed: unknown[] = [];
    const proposeMemory = async (input: unknown) => {
      proposed.push(input);
      return ok({
        entryId: 'd'.repeat(64),
        schemaVersion: 1,
        ...(input as object),
        lifecycle: 'candidate',
        supersedes: null,
        createdAt: 1,
        updatedAt: 1,
        confirmedAt: null,
      });
    };
    const invoke: ModelInvoke = async () => ok('# 每日复盘\n\n报告正文');

    await generateReview(daily(), {
      invoke,
      store,
      workspacePath: workspace,
      proposeMemory: proposeMemory as never,
    });

    expect(proposed).toHaveLength(1);
    const input = proposed[0] as Record<string, unknown>;
    expect(input.kind).toBe('procedural_experience');
    expect(input.source).toBe('review-distillation');
    expect(input.evidence).toBe('extracted');
    expect(input.scope).toBe('workspace');
    expect(input.workspace).toBe(workspace);
    expect(input.producer).toBe('review-distillation');
    expect(input.basis).toBe('复盘生成后自动蒸馏');
    expect(input.title).toBe('每日复盘');
  });

  it('蒸馏内容 ≤ 2048 字节: 超长报告字节级截断, 不劈开多字节字符', async () => {
    writeSkill(workspace, 'daily', 'skill body\n');
    const proposed: unknown[] = [];
    const proposeMemory = async (input: unknown) => {
      proposed.push(input);
      return ok({} as never);
    };
    // 中文字符 3 字节/个: 远超上限, 截断必须不落在字符中间（无 U+FFFD）。
    const longBody = '你'.repeat(1_100);
    const invoke: ModelInvoke = async () => ok(`# 每日复盘\n\n${longBody}`);

    await generateReview(daily(), {
      invoke,
      store,
      workspacePath: workspace,
      proposeMemory: proposeMemory as never,
    });

    expect(proposed).toHaveLength(1);
    const content = (proposed[0] as Record<string, unknown>).content as string;
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(MEMORY_CONTENT_MAX_BYTES);
    // 截断后仍是合法 utf8 序列（未劈开多字节字符）; 且确实发生了截断。
    expect(Buffer.from(content, 'utf8').toString('utf8')).not.toContain('\uFFFD');
    expect(Buffer.byteLength(longBody, 'utf8')).toBeGreaterThan(MEMORY_CONTENT_MAX_BYTES);
  });

  it('蒸馏标题兜底: 报告无 markdown 标题行 → 用「<每日/每周深度>复盘 <dateISO>」', async () => {
    writeSkill(workspace, 'daily', 'skill body\n');
    const proposed: unknown[] = [];
    const proposeMemory = async (input: unknown) => {
      proposed.push(input);
      return ok({} as never);
    };
    const invoke: ModelInvoke = async () => ok('纯正文没有标题');

    await generateReview(daily('2026-08-08'), {
      invoke,
      store,
      workspacePath: workspace,
      proposeMemory: proposeMemory as never,
    });

    expect(proposed).toHaveLength(1);
    expect((proposed[0] as Record<string, unknown>).title).toBe('每日复盘 2026-08-08');
  });

  it('蒸馏写入抛异常 → generateReview 仍 Ok（静默）, 报告正常存档', async () => {
    writeSkill(workspace, 'daily', 'skill body\n');
    const proposeMemory = async () => {
      throw new Error('memory store exploded');
    };
    const invoke: ModelInvoke = async () => ok('# 每日复盘');

    const meta = expectOk<ReviewMeta>(
      await generateReview(daily(), {
        invoke,
        store,
        workspacePath: workspace,
        proposeMemory: proposeMemory as never,
      }),
    );

    expect(meta.kind).toBe('daily');
    expect(expectOk<ReviewMeta[]>(store.list())).toHaveLength(1);
  });

  it('蒸馏写入返回 Err → generateReview 仍 Ok（静默）', async () => {
    writeSkill(workspace, 'daily', 'skill body\n');
    const proposeMemory = async () => err({ code: 'store-broken', message: '磁盘错误' });
    const invoke: ModelInvoke = async () => ok('# 每日复盘');

    const meta = expectOk<ReviewMeta>(
      await generateReview(daily(), {
        invoke,
        store,
        workspacePath: workspace,
        proposeMemory: proposeMemory as never,
      }),
    );

    expect(meta.kind).toBe('daily');
    expect(expectOk<ReviewMeta[]>(store.list())).toHaveLength(1);
  });
});
