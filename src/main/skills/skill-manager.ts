import type { Dirent, Stats } from 'node:fs';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Result as ResultRuntime } from 'better-result';

import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import type {
  CollectResult,
  InstallResult,
  SkillGitStatus,
  SkillReadResult,
  SkillXray,
} from '../../shared/skills-api';
import { SKILL_FILE_BYTES_MAX } from '../../shared/skills-api';
import { collectAgentPluginSkillPaths } from '../agent-plugins/loader';
import { readSettings, writeSettings } from '../workspace/settings';
import { getSkillStats } from './skill-stats';
import { collectSkills as collectScatteredSkills } from './skills-collector';
import {
  getGitStatuses,
  getLocalGitStatuses,
  installSkill as gitInstallSkill,
  updateAll as gitUpdateAll,
} from './skills-git';
import { getSkillCollectionRoot, SYSTEM_MANAGED_SKILL_NAMES, scanSkills } from './skills-store';

/**
 * 技能管理编排（V1-4 + 2026-08-13 批）：
 * 全局隐藏（软禁用）+ 按工作区停用（newmax 式开关）+ 收集 + git 安装/更新 + 悬空清理。
 *
 * - setSkillEnabled：写 AppSettings.disabledSkills（**全局隐藏**语义，软禁用：只从
 * <available_skills> 提示清单剔除，不拦截 agent 主动 read）；详情弹层内开关消费；
 * name ∈ 本次发现集合；系统管理种子拒绝。
 * - setWorkspaceEnabled：写 AppSettings.workspaceSkillOverrides[wsRealpath]（**按工作区
 * 停用**，恒合并进 skillsOverride）；表格行内开关消费；系统管理种子拒绝。
 * - collectSkills / installSkill / checkUpdates / updateAll：收集与 git 编排
 * （收集根 = getSkillCollectionRoot(readSettings)）。
 * - scanDanglingLinks / cleanDangling：悬空 junction/symlink 判定与清理（V1 语义不变）。
 * - resolveWorkspacePath：realpath + 存在性校验；wsPath 未传时回退当前工作区。
 *
 * 全部 Result<T, LorraError>；异常经 Result.tryPromise 收敛，不手写 try/catch 包装。
 */

/** 遍历器最大深度（防链接环卡死主进程，design Sec #4 同款）。 */
const MAX_SCAN_DEPTH = 32;

/**
 * realpath + 存在性校验。wsPath 未传 → 回退当前工作区（recentWorkspaces 首个）；
 * 没有当前工作区 → err 要求显式传参（IPC 侧调用方与文档须注明该语义）。
 * 返回的路径为 realpath（D9：settings.json 的 recentWorkspaces 可篡改，必须 realpath 二次校验）。
 */
export async function resolveWorkspacePath(wsPath?: string): Promise<Result<string>> {
  if (wsPath !== undefined && wsPath !== '') {
    try {
      return ok(realpathSync(wsPath));
    } catch {
      return err({ code: 'invalid-workspace-path', message: '工作区路径无效' });
    }
  }
  const settings = await readSettings();
  const current = settings.recentWorkspaces[0];
  if (!current) {
    return err({ code: 'no-active-workspace', message: '未找到当前工作区，请显式传入工作区路径' });
  }
  try {
    return ok(realpathSync(current));
  } catch {
    return err({
      code: 'invalid-workspace-path',
      message: '当前工作区路径无效，请显式传入工作区路径',
    });
  }
}

/**
 * 全局隐藏（软禁用）：enabled=false → disabledSkills 加入 name；true → 移除。
 * name 校验 = 非空字符串 ∈ 本次发现集合（D9 Arch F8）；系统管理种子（复盘种子）
 * 拒绝操作（Crit F11，UI 开关禁用 + 「由系统管理」）。写回走 writeSettings 原子写，
 * 幂等：重复隐藏不重复入列。2026-08-13 起语义为「全局隐藏」（详情弹层内开关），
 * 表格行内开关改走 setWorkspaceEnabled。
 */
export async function setSkillEnabled(
  name: string,
  enabled: boolean,
  opts: { wsPath?: string } = {},
): Promise<Result<void>> {
  if (typeof name !== 'string' || name.trim() === '') {
    return err({ code: 'invalid-skill-name', message: '技能名称无效' });
  }
  // 种子优先于发现集合判定：无论扫描状态如何，三种子恒返回「由系统管理」（UI 语义确定）。
  if ((SYSTEM_MANAGED_SKILL_NAMES as readonly string[]).includes(name)) {
    return err({ code: 'system-managed-skill', message: '该技能由系统管理' });
  }
  const wsRes = await resolveWorkspacePath(opts.wsPath);
  if (wsRes.isErr()) return wsRes;
  const scanRes = await scanSkills(wsRes.value);
  if (scanRes.isErr()) return scanRes;
  const known = new Set(scanRes.value.skills.map((s) => s.name));
  if (!known.has(name)) {
    return err({ code: 'skill-not-found', message: '技能不存在' });
  }
  const settings = await readSettings();
  const next = new Set(settings.disabledSkills ?? []);
  if (enabled) next.delete(name);
  else next.add(name);
  await writeSettings({ ...settings, disabledSkills: [...next] });
  return ok(undefined);
}

/**
 * 按工作区停用/启用（newmax 式，2026-08-13 批 D3）：enabled=false → name 加入
 * workspaceSkillOverrides[wsRealpath]；true → 移除（不存在 → 空操作成功）。
 * 名单恒合并进 skillsOverride（无 opt-in gate，buildSkillsOverride 语义）。
 * name 校验 = 非空字符串；系统管理种子拒绝（UI 语义确定，无论扫描状态）。
 * wsPath 缺省回退当前工作区（resolveWorkspacePath 同口径）；写回走 writeSettings。
 */
export async function setWorkspaceEnabled(
  name: string,
  enabled: boolean,
  wsPath?: string,
): Promise<Result<void>> {
  if (typeof name !== 'string' || name.trim() === '') {
    return err({ code: 'invalid-skill-name', message: '技能名称无效' });
  }
  if ((SYSTEM_MANAGED_SKILL_NAMES as readonly string[]).includes(name)) {
    return err({ code: 'system-managed-skill', message: '该技能由系统管理' });
  }
  const wsRes = await resolveWorkspacePath(wsPath);
  if (wsRes.isErr()) return wsRes;
  const wsReal = wsRes.value;
  const settings = await readSettings();
  const overrides = settings.workspaceSkillOverrides ?? {};
  const list = new Set(overrides[wsReal] ?? []);
  if (enabled) list.delete(name);
  else list.add(name);
  await writeSettings({
    ...settings,
    workspaceSkillOverrides: { ...overrides, [wsReal]: [...list] },
  });
  return ok(undefined);
}

/**
 * 悬空扫描（V1 只清悬空链接，不删实体—— organize 才处理实体）。
 * 遍历 <ws>/.lorra/skills：lstat 判定 isSymbolicLink（win32 junction dirent
 * isSymbolicLink=true）→ 目标 stat 失败 ENOENT → 悬空，记相对路径（/ 分隔符归一）；
 * 实体目录递归、实体文件跳过；链接不跟随（防越界与防循环），visited-realpath +
 * 最大深度双保险（design Sec #4）。skills 目录本身不存在 → 空清单。
 */
export async function scanDanglingLinks(wsPath?: string): Promise<Result<string[]>> {
  // better-result v3 tryPromise 会把 try 返回的 Result 再包一层 ok（嵌套），
  // 故错误分支在 tryPromise 外提前返回，try 内只返回普通值（数组）。
  const dirRes = await resolveSkillsDir(wsPath);
  if (dirRes.isErr()) return dirRes;
  const skillsDir = dirRes.value;
  if (!existsSync(skillsDir)) return ok([]);
  return ResultRuntime.tryPromise({
    try: async () => collectDanglingLinks(skillsDir, skillsDir, new Set(), 0).sort(),
    catch: (cause) => toLorraError(cause, 'dangling-scan-failed'),
  });
}

/**
 * 悬空判定单一事实源：lstat 是链接（win32 junction 亦 isSymbolicLink）∧ 目标 stat
 * ENOENT。实体目录/实体文件/链接环（ELOOP）/目标存在 → 一律 false。
 */
export function isDanglingLink(p: string): boolean {
  let lst: Stats;
  try {
    lst = lstatSync(p);
  } catch {
    return false;
  }
  if (!lst.isSymbolicLink()) return false;
  try {
    statSync(p);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * 删除前复检的悬空 unlink：非悬空（扫描后被换成实体/链接目标已恢复）→ 拒绝删除
 * 返回 false;unlink 失败(权限/占用)→ 抛错(调用方计入失败项,可重试)。
 * 这是 cleanDangling 的 TOCTOU 锁定:扫描与删除之间被换掉的文件绝不被 unlink。
 */
export function unlinkDangling(p: string): boolean {
  if (!isDanglingLink(p)) return false;
  unlinkSync(p);
  return true;
}

/**
 * 悬空清理：unlink 每个悬空链接（实体目录在清单外永不被删）。unlink 失败收集错误：
 * 全部成功 → ok({ cleaned: n })；部分失败 → err（「已清理 X 个，失败 Y 个」，code
 * 留给日志）。失败项保留，可重试。
 */
export async function cleanDangling(wsPath?: string): Promise<Result<{ cleaned: number }>> {
  const listRes = await scanDanglingLinks(wsPath);
  if (listRes.isErr()) return listRes;
  const dirRes = await resolveSkillsDir(wsPath);
  if (dirRes.isErr()) return dirRes;
  // 删除前复检(unlinkDangling 内 lstat 再判定):扫描后若链接已被换掉(实体/目标已恢复),
  // 拒绝删除——TOCTOU 锁定,实体文件绝不被误 unlink。unlink 失败(权限/占用)计入失败项。
  let cleaned = 0;
  const failures: string[] = [];
  for (const rel of listRes.value) {
    try {
      if (unlinkDangling(path.join(dirRes.value, rel))) cleaned += 1;
    } catch {
      failures.push(rel);
    }
  }
  if (failures.length > 0) {
    return err({
      code: 'clean-dangling-partial',
      message: `已清理 ${cleaned} 个悬空链接，失败 ${failures.length} 个`,
    });
  }
  return ok({ cleaned });
}

// ---- 悬空链接判定与安全删除（FM-8 TOCTOU 锁定）----

/**
 * 悬空判定单一事实源：lstat 是链接（win32 junction 亦 isSymbolicLink）∧ 目标 stat
 * ENOENT。实体目录/实体文件/链接环（ELOOP）/目标存在 → 一律 false。
 */
/** 工作区 realpath → <ws>/.lorra/skills（cleanDangling/scanDanglingLinks 共用）。 */
async function resolveSkillsDir(wsPath?: string): Promise<Result<string>> {
  const wsRes = await resolveWorkspacePath(wsPath);
  if (wsRes.isErr()) return wsRes;
  return ok(path.join(wsRes.value, '.lorra', 'skills'));
}

/**
 * xray 一次拉全量（design D9，管理页数据流）：skills + stats + budget + dangling
 * + gitStatus + collectionRoot + workspacePath。
 * - skills/budget 来自 scanSkills（disabledSkills / workspaceSkillOverrides[当前ws]
 * 经 readSettings 注入：预算排除 = disabledSkills ∪ ws 停用名单 ∪ 系统种子 ∪
 * disableModelInvocation；systemManaged 种子已在 skills-store 的 budget 中排除）
 * - 组装时刷每个 SkillInfo 的 disabledInWs / globallyHidden 真值（扫描层默认 false，
 * 避免扫描层依赖 settings）；enabled 保持全局隐藏口径（!systemManaged ∧
 * !disabledSkills.has(name)），行内开关消费 disabledInWs。
 * - stats 来自 getSkillStats（SkillStatsInput = { name, realPath, rootDir }）
 * - dangling 来自 scanDanglingLinks（当前工作区作用域）
 * - gitStatus 来自 getLocalGitStatuses（只读本地 .git 状态，不触发网络 fetch；
 * checkUpdates 通道才 fetch）
 * 任一步失败 → 整体 err（错误文案 PM 语域，code 留给日志）。
 */
export async function getSkillXray(wsPath?: string): Promise<Result<SkillXray>> {
  const wsRes = await resolveWorkspacePath(wsPath);
  if (wsRes.isErr()) return wsRes;
  const ws = wsRes.value;

  const settings = await readSettings();
  const disabledSkills = settings.disabledSkills ?? [];
  const wsOverrides = settings.workspaceSkillOverrides?.[ws] ?? [];
  const collectionRoot = getSkillCollectionRoot(settings);
  const disabledPlugins = new Set(settings.disabledPlugins ?? []);
  const pluginRoot =
    settings.agentPluginRoot && settings.agentPluginRoot.trim() !== ''
      ? settings.agentPluginRoot
      : undefined;
  // 第 6 源：启用的 agent-plugins 技能根（loader 按 disabledPlugins 过滤）。
  const agentPluginSkills = await collectAgentPluginSkillPaths({
    ...(pluginRoot !== undefined ? { root: pluginRoot } : {}),
    disabled: disabledPlugins,
  });
  const scanRes = await scanSkills(ws, {
    disabledSkills,
    collectionRoot,
    wsOverrides,
    agentPluginSkillPaths: agentPluginSkills.map((s) => s.skillsRoot),
  });
  if (scanRes.isErr()) return scanRes;
  const scan = scanRes.value;

  const hidden = new Set(disabledSkills);
  const wsDisabled = new Set(wsOverrides);
  const skills = scan.skills.map((s) => ({
    ...s,
    disabledInWs: wsDisabled.has(s.name),
    globallyHidden: hidden.has(s.name),
  }));

  const statsRes = await getSkillStats(
    skills.map((s) => ({ name: s.name, realPath: s.realPath, rootDir: s.rootDir })),
  );
  if (statsRes.isErr()) return statsRes;

  const danglingRes = await scanDanglingLinks(ws);
  if (danglingRes.isErr()) return danglingRes;

  const gitRes = await getLocalGitStatuses(collectionRoot);
  if (gitRes.isErr()) return gitRes;

  return ok({
    skills,
    stats: statsRes.value,
    budget: scan.budget,
    dangling: danglingRes.value,
    gitStatus: gitRes.value,
    collectionRoot,
    workspacePath: ws,
  });
}

/**
 * 读取技能文件内容（composer /skill 触发，2026-08-14）：复用 getSkillXray 的
 * 完整发现面（五源 + 停用名单同一口径），按名定位后读 realPath 原文。
 * - 未知技能 → skill-not-found（与 setSkillEnabled 同 code/文案）。
 * - 文件 > SKILL_FILE_BYTES_MAX（1MB）→ skill-too-large（防把巨型文件灌进 prompt）。
 * - 读取失败 → skill-read-failed（toLorraError 收口）。
 * 消费方（composer）负责截断提示词，本函数只保证文件级安全上限。
 */
export async function readSkillContent(name: string): Promise<Result<SkillReadResult>> {
  const xrayRes = await getSkillXray();
  if (xrayRes.isErr()) return xrayRes;
  const skill = xrayRes.value.skills.find((s) => s.name === name);
  if (!skill) return err({ code: 'skill-not-found', message: '技能不存在' });
  try {
    const st = statSync(skill.realPath);
    if (st.size > SKILL_FILE_BYTES_MAX) {
      return err({ code: 'skill-too-large', message: '技能文件过大，无法触发' });
    }
    const content = await readFile(skill.realPath, 'utf8');
    return ok({ name: skill.name, content });
  } catch (cause) {
    return err(toLorraError(cause, 'skill-read-failed'));
  }
}

// ---- 收集与 git 编排（2026-08-13 批 D7）----

/** 收集散乱技能：resolveWorkspacePath 校验 → skills-collector（扫描 recentWorkspaces + ~/.claude/skills）。 */
export async function collectSkills(wsPath?: string): Promise<Result<CollectResult>> {
  const wsRes = await resolveWorkspacePath(wsPath);
  if (wsRes.isErr()) return wsRes;
  const settings = await readSettings();
  const collectionRoot = getSkillCollectionRoot(settings);
  return collectScatteredSkills(wsRes.value, { collectionRoot });
}

/** 安装技能：https git URL → clone 到收集根 + 元数据注册。 */
export async function installSkill(gitUrl: string): Promise<Result<InstallResult>> {
  const settings = await readSettings();
  const collectionRoot = getSkillCollectionRoot(settings);
  return gitInstallSkill(gitUrl, collectionRoot);
}

/** 检查更新：收集根全部 git 技能 fetch 后判定 behind/dirty（checkUpdates 通道才网络 fetch）。 */
export async function checkUpdates(): Promise<Result<Record<string, SkillGitStatus>>> {
  const settings = await readSettings();
  const collectionRoot = getSkillCollectionRoot(settings);
  return getGitStatuses(collectionRoot);
}

/** 统一拉取：dirty 跳过，非 dirty --ff-only；结果 PM 语域文案由 IPC 层透出。 */
export async function updateAll(): Promise<Result<{ updated: string[]; skipped: string[] }>> {
  const settings = await readSettings();
  const collectionRoot = getSkillCollectionRoot(settings);
  return gitUpdateAll(collectionRoot);
}

/**
 * 递归收集悬空链接（lstat 判定、不跟随）：
 * - 符号链接（含 win32 junction）：目标 stat 成功 → 正常链接跳过（不递归）；ENOENT → 悬空
 * （链接环 stat 失败为 ELOOP 系而非 ENOENT，不判悬空——核心保障是不跟随即不卡死）。
 * - 实体目录：递归（visited-realpath + 深度上限双保险；实目录自身不会成环，防御性守卫）。
 * - 实体文件/其它：跳过。
 * 返回路径相对 skillsDir（base），/ 分隔符归一。
 */
function collectDanglingLinks(
  dir: string,
  base: string,
  visited: Set<string>,
  depth: number,
): string[] {
  if (depth > MAX_SCAN_DEPTH) return [];
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return [];
  }
  if (visited.has(real)) return [];
  visited.add(real);

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 不可读目录：跳过（best-effort，扫描不冒泡）。
  }

  const out: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let st: Stats;
    try {
      st = lstatSync(fullPath);
    } catch {
      continue; // 竞态删除 → 跳过。
    }
    if (st.isSymbolicLink() && isDanglingLink(fullPath)) {
      out.push(path.relative(base, fullPath).split(path.sep).join('/'));
    } else if (st.isDirectory()) {
      out.push(...collectDanglingLinks(fullPath, base, visited, depth + 1));
    }
  }
  return out;
}
