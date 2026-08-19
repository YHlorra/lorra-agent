import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';

/**
 * 内置技能目录注册表（2026-08-18 批）：
 *
 * Vite `?raw` glob 动态枚举 `./builtin-skill-seeds/*.md`（包内嵌，eager → build 时
 * 打包进产物）。新增内置技能只需往目录丢一个新 .md（frontmatter `name` + `description`
 * + 方法论正文），**无需改任何代码**——下次应用启动 `seedBuiltinSkills` 自动写盘。
 *
 * 落地路径 = <lorraConfigDir>/skills/<name>.md（lorra 全局库，非工作区）：
 * - write-if-missing：已存在不覆写（用户编辑过保留，同 memory-maintenance 纪律）。
 * - 失败静默：单文件失败不影响其它；console.warn 记录，不抛（不阻塞启动/激活）。
 * - 启动调用一次即「动态添加」：lorra 升级新增 .md → 重启时自动落盘。
 *
 * 与 per-workspace 种子（memory-maintenance / ofk-digest，走 review-generator
 * loadOrSeedSkill）定位不同：内置三件套（daily-review / deep-review / lorra-meta-skill）
 * 归 lorra 全局库，SDK 经 agentDir=<lorraConfigDir> 自动发现。
 */

// eager + ?raw + default → Record<key, string>（vite/client 类型；显式断言防推断漂移）。
const SEEDS = import.meta.glob('./builtin-skill-seeds/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 内置技能名：`./builtin-skill-seeds/<name>.md` 的 basename（去 .md）。 */
export const BUILTIN_SKILL_NAMES: readonly string[] = Object.keys(SEEDS).map((key) =>
  path.posix.basename(key, '.md'),
);

/** 严格匹配 name（= 文件名），返回嵌入内容；未注册 → undefined。 */
export function getBuiltinSkillSeed(name: string): string | undefined {
  return SEEDS[`./builtin-skill-seeds/${name}.md`];
}

/** 落地 <lorraConfigDir>/skills/<name>.md，write-if-missing；单文件失败静默（console.warn）。 */
export function seedBuiltinSkills(): void {
  for (const name of BUILTIN_SKILL_NAMES) {
    const seed = getBuiltinSkillSeed(name);
    if (seed === undefined) continue; // glob 键与 name 推导不一致的防御（理论不可达）。
    const target = path.join(lorraConfigDir(), 'skills', `${name}.md`);
    try {
      if (existsSync(target)) continue; // write-if-missing：用户编辑过不覆写。
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, seed);
    } catch (cause) {
      console.warn(`[builtin-skill-seeder] seed ${name} failed:`, cause);
    }
  }
}
