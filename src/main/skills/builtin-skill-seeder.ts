import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';

/**
 * 内置技能目录注册表（2026-08-18 批，2026-08-19 目录形改造）：
 *
 * 技能 = 目录（对齐 agentskills.io 开放标准 / Codex）：`<name>/SKILL.md` 为精简入口，
 * 细节放 `references/`、模板放 `formats/`、`assets/`，agent 激活后按需读取（progressive
 * disclosure）。pi-ai SDK 原生支持目录形技能（baseDir = SKILL.md 所在目录，相对路径
 * 按技能根解析）——比压平单文件轻，SKILL.md 不再承担全部负担。
 *
 * Vite `?raw` glob 动态枚举 `./builtin-skill-seeds` 下全部文件（递归含子目录，包内嵌，
 * eager → build 时打包进产物）。新增内置技能只需往目录丢一个新 `<name>/SKILL.md`
 * （+ 可选子文件），**无需改任何代码**——下次应用启动 `seedBuiltinSkills` 自动写盘。
 *
 * 落地路径 = <lorraConfigDir>/skills/<name>/<rel>（lorra 全局库，非工作区）：
 * - write-if-missing：已存在不覆写（用户编辑过保留，同 memory-maintenance 纪律）。
 * - 失败静默：单文件失败不影响其它；console.warn 记录，不抛（不阻塞启动/激活）。
 * - 启动调用一次即「动态添加」：lorra 升级新增技能 → 重启时自动落盘。
 *
 * 与 per-workspace 种子（memory-maintenance / ofk-digest，走 review-generator
 * loadOrSeedSkill）定位不同：本目录内置六个技能（daily-review / deep-review /
 * lorra-meta-skill / teach / reference-projects / find-skills）归 lorra 全局库，
 * SDK 经 agentDir=<lorraConfigDir> 自动发现。
 */

// eager + ?raw + default → Record<key, string>（vite/client 类型；显式断言防推断漂移）。
// **/* 只匹配文件（Vite onlyFiles 默认 true），键含目录路径，如 ./builtin-skill-seeds/teach/references/x.md。
const SEEDS = import.meta.glob('./builtin-skill-seeds/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 内置技能名：`./builtin-skill-seeds/<name>/` 顶层目录名（去重 + 排序稳定）。 */
export const BUILTIN_SKILL_NAMES: readonly string[] = [
  ...new Set(
    Object.keys(SEEDS).map((key) => key.replace('./builtin-skill-seeds/', '').split('/')[0]),
  ),
].sort();

/** 严格匹配 name（= 顶层目录名），返回技能目录内「相对路径 → 内容」文件树；未注册 → undefined。 */
export function getBuiltinSkillFiles(name: string): Record<string, string> | undefined {
  const prefix = `./builtin-skill-seeds/${name}/`;
  const files: Record<string, string> = {};
  for (const [key, content] of Object.entries(SEEDS)) {
    if (key.startsWith(prefix)) files[key.slice(prefix.length)] = content;
  }
  return Object.keys(files).length > 0 ? files : undefined;
}

/** SKILL.md 内容（review-generator fallback 等单文件消费方；目录形技能仍以 SKILL.md 为入口）。 */
export function getBuiltinSkillSeed(name: string): string | undefined {
  return getBuiltinSkillFiles(name)?.['SKILL.md'];
}

/**
 * 落地 <lorraConfigDir>/skills/<name>/<rel>（目录形技能树），write-if-missing；
 * 单文件失败静默（console.warn），不中断其余文件。
 */
export function seedBuiltinSkills(): void {
  for (const name of BUILTIN_SKILL_NAMES) {
    const files = getBuiltinSkillFiles(name);
    if (files === undefined) continue; // glob 键与 name 推导不一致的防御（理论不可达）。
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(lorraConfigDir(), 'skills', name, rel);
      try {
        if (existsSync(target)) continue; // write-if-missing：用户编辑过不覆写。
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      } catch (cause) {
        console.warn(`[builtin-skill-seeder] seed ${name}/${rel} failed:`, cause);
      }
    }
  }
}
