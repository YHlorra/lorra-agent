import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MEMORY_CONTENT_MAX_BYTES, type MemoryEntry } from '../../shared/memory-schema';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';
import { getBuiltinSkillSeed } from '../skills/builtin-skill-seeder';
import { localDateString } from './day-summary';
// 类型级引用（esbuild 剔除 type import, 不把 node:sqlite 拉进 vitest client
// 测试图）;方法面按 phase3-contract 定稿调用。
import type { ProposeInput } from './memory-store';
import { assembleReviewPayload, type ReviewPayload, type ReviewRequest } from './review-assembler';
import type { ReviewMeta, ReviewStore } from './review-store';
import { truncateUtf8ToBytes } from './text-bytes';

// 组装契约类型从 review-assembler 再导出,消费方(测试/前端)统一从本模块入口取。
export type {
  ConversationDigest,
  ReviewPayload,
  ReviewRequest,
  ReviewWorkspace,
} from './review-assembler';

/**
 * 复盘生成(spec review-engine D8,PM 方向修正):方法论从硬编码模板改为
 * 工作区技能文件 —— 内置种子(<workspace>/.lorra/skills/<name>.md)原样播种,
 * 用户可改、模型自主判断。
 * - 技能文件缺失 → 原样写入内置种子(?raw 内联原文,不得改写)
 * - 技能文件存在 → 直接用磁盘内容(不覆写)
 * - prompt = 技能文件内容 + 载荷 JSON（用户调整复盘重点 = 直接改技能文件，
 * 2026-08-08 PM 拍板取消 userPrompt 引导段）
 * - invoke 失败/抛错 → Err,绝不落半成品文件
 */

export type ModelInvoke = (prompt: string) => Promise<Result<string>>;

type ReviewSkillName = 'daily-review' | 'deep-review';

/**
 * 复盘技能读取（2026-08-19 起目录形全局路径）：<lorraConfigDir>/skills/<name>/SKILL.md。
 * 不再 per-workspace 播种（写盘由启动期 seedBuiltinSkills 负责，write-if-missing）；
 * 此处只「读 + fallback」：文件缺失 → 内置种子兜底（极端情况，正常启动后文件已在）。
 * 错误码 seed-skill-failed（2026-08-17 收敛，与 loadOrSeedSkill 同口径）。
 */
function loadReviewSkill(name: ReviewSkillName): Result<string> {
  try {
    const target = path.join(lorraConfigDir(), 'skills', name, 'SKILL.md');
    if (existsSync(target)) return ok(readFileSync(target, 'utf8'));
    return ok(getBuiltinSkillSeed(name) ?? '');
  } catch (cause) {
    return err(toLorraError(cause, 'seed-skill-failed'));
  }
}

/** 加载/播种 skill 文件(.lorra/skills/<name>.md):目标缺失 → 写入 seed;存在 → 原样读取。
 * 通用入口,被 memory-maintenance / ofk-digest 两处 per-workspace 种子共用
 * (复盘与 lorra-meta-skill 已迁全局路径,见 builtin-skill-seeder / loadReviewSkill)。
 * 错误码 seed-skill-failed(2026-08-17 收敛):失败模式一致(磁盘 IO/路径错误),
 * message 字段自带 ENOENT 上下文足够定位,无需细分 code。
 */
export function loadOrSeedSkill(workspacePath: string, name: string, seed: string): Result<string> {
  try {
    const target = path.join(workspacePath, '.lorra', 'skills', `${name}.md`);
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, seed);
    }
    return ok(readFileSync(target, 'utf8'));
  } catch (cause) {
    return err(toLorraError(cause, 'seed-skill-failed'));
  }
}

/**
 * 拼装提示:技能文件内容(方法论) + 载荷 JSON。
 */
function composeReviewPrompt(skillContent: string, payload: ReviewPayload): string {
  const json = JSON.stringify(payload, null, 2);
  return [skillContent, `以下为本次复盘的数据(JSON):\n${json}`].join('\n\n');
}

/**
 * 生成复盘:组装(OFK bundle 直读)→ 技能文件加载/播种 → 拼装提示 →
 * invoke → 成功后存档 → 蒸馏 hook(6.4, 失败静默)。
 * invoke 返回 Err → 原样透传;invoke 抛错 → Err code 'model-invoke-failed';
 * 两种情况都不产生半成品报告文件。
 */
export async function generateReview(
  req: ReviewRequest,
  deps: {
    invoke: ModelInvoke;
    store: ReviewStore;
    /** 工作区路径:技能文件按工作区播种/读取。 */
    workspacePath: string;
    /**
     * 蒸馏通道(6.4):复盘成功后的记忆候选写入。缺省走共享 MemoryStore 单例
     * (shared-memory-store, 动态 import 装载);测试可注入假 store 验证蒸馏
     * 契约与失败静默。蒸馏失败(Err/抛错/store 不可用)一律静默,
     * 不影响 generateReview 的 Ok 结果与报告存档。
     */
    proposeMemory?: (input: ProposeInput) => Promise<Result<MemoryEntry>> | Result<MemoryEntry>;
  },
): Promise<Result<ReviewMeta>> {
  try {
    const dateISO = req.dateISO ?? localDateString(new Date());
    const assembled = await assembleReviewPayload(req.kind, dateISO);
    if (assembled.isErr()) return assembled;
    const payload = assembled.value;

    const skillName: ReviewSkillName = req.kind === 'weekly' ? 'deep-review' : 'daily-review';
    const skillResult = loadReviewSkill(skillName);
    if (skillResult.isErr()) return skillResult;

    const prompt = composeReviewPrompt(skillResult.value, payload);
    let invoked: Result<string>;
    try {
      invoked = await deps.invoke(prompt);
    } catch (cause) {
      return err({
        code: 'model-invoke-failed',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (invoked.isErr()) return invoked;
    const markdown = invoked.value;

    const createdAt = Date.now();
    const meta: ReviewMeta = {
      id: `${dateISO}-${req.kind}-${createdAt}`,
      kind: req.kind,
      dateISO,
      createdAt,
    };
    const saved = deps.store.save(meta, markdown);
    if (saved.isErr()) return saved;
    // 蒸馏 hook:报告已存档, 蒸馏是副产品 —— 失败必须静默。
    await distillReviewToMemory(meta, markdown, deps);
    return ok(meta);
  } catch (cause) {
    return err(toLorraError(cause, 'review-generation-failed'));
  }
}

/** 报告标题: 取首个 markdown 标题行; 缺失 → 兜底标题（<每日/每周深度>复盘 <dateISO>）。 */
function extractReportTitle(markdown: string, meta: ReviewMeta): string {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  if (heading) return heading[1].trim();
  return meta.kind === 'weekly' ? `每周深度复盘 ${meta.dateISO}` : `每日复盘 ${meta.dateISO}`;
}

/**
 * 默认蒸馏写入: 共享 MemoryStore 单例。
 * 动态 import 是刻意的模块加载边界——node:sqlite 是实验性内置, 静态引入会把
 * sqlite 拉进 vitest client 测试图导致打包失败（shared-facts-store 同款纪律）。
 */
async function defaultMemoryPropose(input: ProposeInput): Promise<Result<MemoryEntry>> {
  const { getSharedMemoryStore } = await import('./shared-memory-store');
  const shared = getSharedMemoryStore();
  if (shared.isErr()) return err(shared.error);
  return shared.value.propose(input);
}

/**
 * 蒸馏 hook（design D11/D12, 落地锚点「蒸馏 hook」）:报告生成成功后提炼一条
 * procedural_experience 候选（source=review-distillation, evidence=extracted,
 * scope=workspace + workspace=当前工作区, producer=review-distillation,
 * basis=「复盘生成后自动蒸馏」）。只落候选闸门, 不激活。
 * 失败必须静默: 任何异常/Err 都被吞掉, 报告已存档不受影响。
 */
async function distillReviewToMemory(
  meta: ReviewMeta,
  markdown: string,
  deps: {
    workspacePath: string;
    proposeMemory?: (input: ProposeInput) => Promise<Result<MemoryEntry>> | Result<MemoryEntry>;
  },
): Promise<void> {
  try {
    const propose = deps.proposeMemory ?? defaultMemoryPropose;
    const result = await propose({
      kind: 'procedural_experience',
      title: extractReportTitle(markdown, meta),
      content: truncateUtf8ToBytes(markdown, MEMORY_CONTENT_MAX_BYTES),
      producer: 'review-distillation',
      source: 'review-distillation',
      scope: 'workspace',
      workspace: deps.workspacePath,
      evidence: 'extracted',
      basis: '复盘生成后自动蒸馏',
    });
    // Err 静默: 蒸馏失败不影响报告
    void result;
  } catch {
    // store 不可用/动态 import 失败/写入抛错: 一律静默
  }
}
