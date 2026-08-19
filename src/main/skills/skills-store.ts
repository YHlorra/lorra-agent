import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Result as ResultRuntime } from 'better-result';

import type { Result } from '../../shared/result';
import { toLorraError } from '../../shared/result';
import type {
  BudgetStatus,
  SkillBudget,
  SkillInfo,
  SkillIssue,
  SkillScope,
  SkillSource,
} from '../../shared/skills-api';
import {
  SKILL_BUDGET_GOOD_TOKENS,
  SKILL_BUDGET_WARN_TOKENS,
  SKILL_DESC_CHARS_MAX,
  SKILL_FILE_BYTES_MAX,
  SKILL_TOKEN_ESTIMATE_DIVISOR,
} from '../../shared/skills-api';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';

/**
 * 技能发现/健康/预算（V1-2）——管理页 xray 的数据底座。
 *
 * 发现语义对齐 pi SDK（node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js）：
 * - 目录含 SKILL.md → 技能根，不递归；否则根下平铺 .md 算技能；递归子目录找 SKILL.md
 * - realpath（canonicalizePath）去重，同文件只列一次；同名碰撞先到者胜（源顺序）
 * - name 回退父目录名；缺 description → 技能无效（missing-description）
 * - description>1024 → warning 仍全量注入（预算按全量）；disable-model-invocation → 不注入
 *
 * 与 SDK 的差异（有意，design D7/D11）：
 * - >1MB 文件跳过加载标「too-large」（SDK 无 size 上限，读入前 stat 防 DoS）
 * - frontmatter name/description 非字符串 → 显式健康项「frontmatter-type-error」（SDK 静默丢弃）
 * - 断链（broken symlink/junction）→ 「missing-file」健康项（SDK 跳过）
 * - 遍历带 visited-realpath + 最大深度防循环（SDK 靠 catch{} 吞 RangeError）
 *
 * 全部 Result<T, LorraError>；异常经 Result.tryPromise 收敛，不手写 try/catch 包装。
 */

// ---- 常量 ----

/** 系统管理种子（per-workspace 播种链路专属）：灰标「内部·未注入」，不进「有问题」计数、不进预算。 */
export const SYSTEM_MANAGED_SKILL_NAMES = ['memory-maintenance', 'ofk-digest'] as const;

/**
 * 种子文件名集合 = SYSTEM_MANAGED ∪ [daily-review, deep-review]。
 * 复盘/meta 种子自 2026-08-18 起归 lorra 全局库（builtin-skill-seeder），UI 以普通技能
 * 出现（systemManaged=false，可手动触发）；但收集器仍按「lorra 写的种子」跳过（不收集、
 * 不动位置）——与 UI 灰标解耦，收集语义不变。skill-manager 的启停拒绝只认 SYSTEM_MANAGED。
 */
export const SEED_FILE_SKILL_NAMES = [
  ...SYSTEM_MANAGED_SKILL_NAMES,
  'daily-review',
  'deep-review',
] as const;

/** 遍历器最大深度（防 symlink 环卡死主进程，design Sec #4）。 */
const MAX_SCAN_DEPTH = 32;

// ---- 公开类型 ----

export interface SkillScanOpts {
  /** 测试注入；缺省 os.homedir（tool-safety/trusted-paths 同款注入模式）。 */
  homedir?: string;
  /** 用户显式隐藏名单（AppSettings.disabledSkills），软禁用：从提示清单剔除、不进预算。 */
  disabledSkills?: string[];
  /** 技能收集根（getSkillCollectionRoot 结果）；缺省 = 默认 ~/.agents/skills。 */
  collectionRoot?: string;
  /** 当前工作区停用名单（AppSettings.workspaceSkillOverrides[wsRealpath]）：从提示清单剔除、不进预算。 */
  wsOverrides?: string[];
  /** 启用的 agent-plugins 技能根路径清单（第 6 源；由 agent-plugins/loader 提供，调用方注入）。 */
  agentPluginSkillPaths?: string[];
}

/** 扫描内部结构（供 skill-manager 组装 SkillXray；stats/dangling 由 skill-stats/cleanDangling 提供）。 */
export interface SkillScan {
  skills: SkillInfo[];
  budget: SkillBudget;
  workspacePath: string;
}

// ---- 四源路径（顺序即去重优先级，对齐 SDK resolve 次序去掉 .pi 后）----

/** SDK findGitRepoRoot 同款：从 startDir 逐级上溯找 .git（文件或目录均可，package-manager.js @263）。 */
function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isSamePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * 祖先 .agents/skills 目录集（SDK collectAncestorAgentsSkillDirs @269 同款）：
 * 从 wsPath 逐级上溯，git 根 break；非 git 工作区上溯至文件系统根兜底；
 * 排除项 = ~/.agents/skills 本身（SDK 单独作为 user scope 无条件加入，非「排除 home」）。
 */
function collectAncestorAgentsSkillDirs(startDir: string, home: string): string[] {
  const dirs: string[] = [];
  const userAgentsSkills = path.join(home, '.agents', 'skills');
  const gitRoot = findGitRoot(startDir);
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.agents', 'skills');
    if (!isSamePath(candidate, userAgentsSkills)) dirs.push(candidate);
    if (gitRoot && isSamePath(dir, gitRoot)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * 收集根默认值解析（settings 是纯持久化层，解析放本模块）：
 * settings.skillCollectionRoot 为空串 → ~/.agents/skills。
 */
export function getSkillCollectionRoot(settings: { skillCollectionRoot?: string }): string {
  return settings.skillCollectionRoot && settings.skillCollectionRoot.trim() !== ''
    ? settings.skillCollectionRoot
    : path.join(os.homedir(), '.agents', 'skills');
}

/**
 * 六源路径集（顺序即去重优先级）：收集根 → 祖先 .agents/skills → ~/.lorra/skills（lorra 全局库）→
 * ~/.agents/skills（user 源）→ ~/.claude/skills（claude 源）→ <ws>/.lorra/skills（工作区，最后，
 * 与 SDK additionalSkillPaths 一致）。
 * 收集根最前：被收集技能 winner 优先（与 SDK resolve 次序同构——收集根即 additionalSkillPaths 首位，
 * resource-loader.js:329-333 实证 additionalSkillPaths 排在工作区前）；与用户源同路径时去重
 * （收集根默认即 ~/.agents/skills）。
 * 管理页扫描与 session-persistence 剔除合并共用此函数；路径集不判存在（加载时判，SDK 同款）。
 */
export function getSkillSourcePaths(wsPath: string, opts: SkillScanOpts = {}): string[] {
  const home = opts.homedir ?? os.homedir();
  const ws = path.resolve(wsPath);
  const collectionRoot = opts.collectionRoot
    ? path.resolve(opts.collectionRoot)
    : path.join(home, '.agents', 'skills');
  const userSkills = path.join(home, '.agents', 'skills');
  const claudeSkills = path.join(home, '.claude', 'skills');
  return [
    // 收集根与用户源同路径时只列一次（默认值即同路径）。
    ...(isSamePath(collectionRoot, userSkills) ? [] : [collectionRoot]),
    ...collectAncestorAgentsSkillDirs(ws, home),
    path.join(lorraConfigDir(), 'skills'),
    userSkills,
    claudeSkills,
    path.join(ws, '.lorra', 'skills'),
  ];
}

/**
 * sourceOf：收集根 realpath 前缀边界判定最前（root 本身或 root + 分隔符前缀；
 * `<root>abc` 不匹配 `<root>`——前缀边界带分隔符）；原四源逻辑不变。
 */
function sourceOf(
  sourcePath: string,
  ws: string,
  home: string,
  collectionRoot: string,
): SkillSource {
  const wsSkills = path.join(ws, '.lorra', 'skills');
  const lorraSkills = path.join(lorraConfigDir(), 'skills');
  const userSkills = path.join(home, '.agents', 'skills');
  const claudeSkills = path.join(home, '.claude', 'skills');
  const root = path.resolve(collectionRoot);
  const p = path.resolve(sourcePath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (isSamePath(p, root) || lower(p).startsWith(lower(rootWithSep))) return 'collection';
  if (isSamePath(sourcePath, wsSkills)) return 'workspace';
  if (isSamePath(sourcePath, lorraSkills)) return 'lorra-global';
  if (isSamePath(sourcePath, userSkills)) return 'user';
  if (isSamePath(sourcePath, claudeSkills)) return 'claude';
  return 'ancestor';
}

/** scope 映射（D4）：collection/lorra-global/user/claude/agent-plugin → global；workspace/ancestor → project。 */
function scopeOf(source: SkillSource): SkillScope {
  return source === 'collection' ||
    source === 'lorra-global' ||
    source === 'user' ||
    source === 'claude' ||
    source === 'agent-plugin'
    ? 'global'
    : 'project';
}

// ---- frontmatter 解析（轻量，对齐 SDK parseFrontmatter 语义）----

interface ParsedFrontmatter {
  name: unknown;
  description: unknown;
  disableModelInvocation: unknown;
}

/**
 * 轻量 frontmatter 解析：--- 块 + 单行 `key: value`（值支持引号字符串/布尔/数字/null），
 * 不引 YAML 库（renderer markdown-meta 同款纪律）。语义对齐 SDK parseFrontmatter：
 * 内容须以 --- 起始且有独立闭合行；无 frontmatter → 空字段。
 * export：skills-collector / skills-git 复用（技能名口径 = frontmatter name → 目录名回退），
 * 不得写第二份解析。
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) {
    return { name: undefined, description: undefined, disableModelInvocation: undefined };
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) {
    return { name: undefined, description: undefined, disableModelInvocation: undefined };
  }
  const fields: Record<string, unknown> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    let value: unknown;
    if (raw === '') value = null;
    else if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    )
      value = raw.slice(1, -1);
    else if (/^(true|false)$/i.test(raw)) value = raw.toLowerCase() === 'true';
    else if (/^(null|~)$/i.test(raw)) value = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else value = raw;
    fields[m[1]] = value;
  }
  return {
    name: fields.name,
    description: fields.description,
    disableModelInvocation: fields['disable-model-invocation'],
  };
}

/** SDK canonicalizePath 同款：realpath，失败回退原路径（缺失条目不崩）。 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** SDK loadSkillFromFile 同款：name 回退父目录名（平铺文件 = 源根名）。 */
function fallbackName(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

/** 不可读文件（missing-file / too-large）的展示名：SKILL.md 形状取父目录，平铺取文件主干。 */
function unreadableName(filePath: string): string {
  const base = path.basename(filePath);
  if (base.toLowerCase() === 'skill.md') return path.basename(path.dirname(filePath));
  return path.basename(filePath, path.extname(filePath));
}

function unreadableSkill(
  filePath: string,
  source: SkillSource,
  code: 'missing-file' | 'too-large',
): SkillInfo {
  return {
    name: unreadableName(filePath),
    source,
    scope: scopeOf(source),
    filePath,
    realPath: canonicalize(filePath),
    rootDir: canonicalize(path.dirname(filePath)),
    description: '',
    descriptionChars: 0,
    estimatedTokens: 0,
    // 中性默认；enabled/systemManaged/isDuplicate 由 scanWorkspace 汇总阶段统一回填，
    // disabledInWs/globallyHidden 由 xray 组装统一刷真值（扫描层不依赖 settings）。
    enabled: true,
    disabledInWs: false,
    globallyHidden: false,
    systemManaged: false,
    disableModelInvocation: false,
    isDuplicate: false,
    issues: [
      code === 'missing-file'
        ? { code, message: '技能文件缺失或不可读' }
        : { code, message: '技能文件超过 1MB，已跳过加载' },
    ],
  };
}

/** 单文件加载 + 健康判定（读入前 stat：>1MB 跳过；stat/read 失败 → missing-file）。 */
function loadSkillFile(filePath: string, source: SkillSource): SkillInfo {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return unreadableSkill(filePath, source, 'missing-file');
  }
  if (size > SKILL_FILE_BYTES_MAX) {
    return unreadableSkill(filePath, source, 'too-large');
  }
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return unreadableSkill(filePath, source, 'missing-file');
  }

  const fm = parseFrontmatter(content);
  const issues: SkillIssue[] = [];

  let name: string;
  if (fm.name !== undefined && fm.name !== null && typeof fm.name !== 'string') {
    issues.push({
      code: 'frontmatter-type-error',
      message: `frontmatter name 非字符串（${typeof fm.name}），已回退目录名`,
    });
    name = fallbackName(filePath);
  } else {
    name = typeof fm.name === 'string' && fm.name !== '' ? fm.name : fallbackName(filePath);
  }

  let description = '';
  if (typeof fm.description === 'string') {
    description = fm.description;
  }
  if (description === '' || description.trim() === '') {
    if (typeof fm.description === 'string') {
      issues.push({
        code: 'missing-description',
        message: '缺少 description（技能不会被注入提示清单）',
      });
    } else if (fm.description === undefined || fm.description === null) {
      issues.push({
        code: 'missing-description',
        message: '缺少 description（技能不会被注入提示清单）',
      });
    } else {
      issues.push({
        code: 'frontmatter-type-error',
        message: `frontmatter description 非字符串（${typeof fm.description}）`,
      });
    }
  } else if (description.length > SKILL_DESC_CHARS_MAX) {
    issues.push({
      code: 'description-too-long',
      message: `description 超过 ${SKILL_DESC_CHARS_MAX} 字符（${description.length}），仍会全量注入`,
    });
  }

  const descriptionChars = description.length;
  return {
    name,
    source,
    scope: scopeOf(source),
    filePath,
    realPath: canonicalize(filePath),
    rootDir: canonicalize(path.dirname(filePath)),
    description,
    descriptionChars,
    estimatedTokens: Math.round(descriptionChars / SKILL_TOKEN_ESTIMATE_DIVISOR),
    enabled: true,
    disabledInWs: false,
    globallyHidden: false,
    systemManaged: false,
    disableModelInvocation: fm.disableModelInvocation === true,
    isDuplicate: false,
    issues,
  };
}

/**
 * 目录扫描（SDK loadSkillsFromDirInternal @125 同款）：
 * 第一遍 SKILL.md → 技能根立即返回；第二遍目录递归（只找 SKILL.md）+ 根下平铺 .md
 * （仅 includeRootFiles 时）。visited-realpath + MAX_SCAN_DEPTH 防循环（design Sec #4）。
 */
function scanDirForSkills(
  dir: string,
  source: SkillSource,
  includeRootFiles: boolean,
  visited: Set<string>,
  depth: number,
): SkillInfo[] {
  if (depth > MAX_SCAN_DEPTH || !existsSync(dir)) return [];
  const real = canonicalize(dir);
  if (visited.has(real)) return [];
  visited.add(real);

  const entries = readdirSync(dir, { withFileTypes: true });

  // 第一遍：SKILL.md → 技能根，不递归不载平铺。
  for (const entry of entries) {
    if (entry.name !== 'SKILL.md') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let isFile = false;
      try {
        isFile = statSync(fullPath).isFile();
      } catch {
        // broken SKILL.md 链接 → missing-file（SDK 此处跳过）。
      }
      if (!isFile) return [unreadableSkill(fullPath, source, 'missing-file')];
    }
    return [loadSkillFile(fullPath, source)];
  }

  // 第二遍：目录递归 + 平铺 .md。
  const out: SkillInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = statSync(fullPath);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        if (entry.name.endsWith('.md')) out.push(unreadableSkill(fullPath, source, 'missing-file'));
        continue;
      }
    }
    if (isDir) {
      out.push(...scanDirForSkills(fullPath, source, false, visited, depth + 1));
    } else if (isFile && includeRootFiles && entry.name.endsWith('.md')) {
      out.push(loadSkillFile(fullPath, source));
    }
  }
  return out;
}

// ---- 去重 / 汇总 / 预算 ----

/** 副本徽章口径（V1）：同名碰撞跨「工作区源 ↔ 其它源」且 realpath 不同。 */
function spansWorkspaceAndOther(winnerSource: SkillSource, sources: Set<SkillSource>): boolean {
  if (winnerSource === 'workspace') return [...sources].some((s) => s !== 'workspace');
  return sources.has('workspace');
}

function computeBudget(
  skills: SkillInfo[],
  disabled: Set<string>,
  wsExcluded: Set<string>,
): SkillBudget {
  // 启用集 = 五源发现 − 系统种子 − disabledSkills − workspaceSkillOverrides[当前ws]
  // − disableModelInvocation（SDK 不注入）。
  const enabled = skills.filter(
    (s) =>
      !s.systemManaged &&
      !s.disableModelInvocation &&
      !disabled.has(s.name) &&
      !wsExcluded.has(s.name),
  );
  const charSum = enabled.reduce((acc, s) => acc + s.descriptionChars, 0);
  const estimatedTokens = Math.round(charSum / SKILL_TOKEN_ESTIMATE_DIVISOR);
  const status: BudgetStatus =
    estimatedTokens <= SKILL_BUDGET_GOOD_TOKENS
      ? 'good'
      : estimatedTokens <= SKILL_BUDGET_WARN_TOKENS
        ? 'warn'
        : 'over';
  return {
    estimatedTokens,
    goodLine: SKILL_BUDGET_GOOD_TOKENS,
    warnLine: SKILL_BUDGET_WARN_TOKENS,
    status,
    enabledCount: enabled.length,
    charSum,
  };
}

function scanWorkspace(wsPath: string, opts: SkillScanOpts): SkillScan {
  const home = opts.homedir ?? os.homedir();
  const ws = path.resolve(wsPath);
  const collectionRoot = opts.collectionRoot ?? path.join(home, '.agents', 'skills');
  const disabled = new Set(opts.disabledSkills ?? []);
  const wsExcluded = new Set(opts.wsOverrides ?? []);
  const sourcePaths = getSkillSourcePaths(ws, opts);

  const visited = new Set<string>();
  const seenReal = new Set<string>();
  const byName = new Map<string, SkillInfo>();
  // 同名碰撞记录：name → 参与碰撞的源集合（用于 isDuplicate 口径，realpath 相同的先被 seenReal 滤掉）。
  const nameLosers = new Map<string, Set<SkillSource>>();

  for (const sourcePath of sourcePaths) {
    const source = sourceOf(sourcePath, ws, home, collectionRoot);
    for (const skill of scanDirForSkills(sourcePath, source, true, visited, 0)) {
      if (seenReal.has(skill.realPath)) continue; // realpath 去重（junction 同文件只列一次）
      seenReal.add(skill.realPath);
      const existing = byName.get(skill.name);
      if (existing) {
        let sources = nameLosers.get(skill.name);
        if (!sources) {
          sources = new Set();
          nameLosers.set(skill.name, sources);
        }
        sources.add(existing.source);
        sources.add(skill.source);
        // 同名碰撞：先到者胜，后者丢弃（对齐 SDK loadSkills 同名 winner 语义）。
      } else {
        byName.set(skill.name, skill);
      }
    }
  }

  // 第 6 源：启用的 agent-plugins 技能根（source='agent-plugin'，scope=global）。
  // 排在既有五源之后、去重优先级最后（agent-plugin 技能与散装技能同名时散装胜）。
  for (const pluginSkillsRoot of opts.agentPluginSkillPaths ?? []) {
    for (const skill of scanDirForSkills(pluginSkillsRoot, 'agent-plugin', false, visited, 0)) {
      if (seenReal.has(skill.realPath)) continue;
      seenReal.add(skill.realPath);
      const existing = byName.get(skill.name);
      if (existing) {
        let sources = nameLosers.get(skill.name);
        if (!sources) {
          sources = new Set();
          nameLosers.set(skill.name, sources);
        }
        sources.add(existing.source);
        sources.add(skill.source);
      } else {
        byName.set(skill.name, skill);
      }
    }
  }

  const skills = [...byName.values()].map((s) => {
    const systemManaged = (SYSTEM_MANAGED_SKILL_NAMES as readonly string[]).includes(s.name);
    const collided = nameLosers.get(s.name);
    return {
      ...s,
      systemManaged,
      enabled: !systemManaged && !disabled.has(s.name),
      isDuplicate: collided !== undefined && spansWorkspaceAndOther(s.source, collided),
    };
  });

  return { skills, budget: computeBudget(skills, disabled, wsExcluded), workspacePath: ws };
}

/**
 * 全量扫描：四源发现 + 去重 + 健康 + 预算。异常收敛为 Result（skills-scan-failed），
 * 扫描内预期失败（断链/过大/不可读）走健康项，不冒泡。
 */
export function scanSkills(wsPath: string, opts: SkillScanOpts = {}): Promise<Result<SkillScan>> {
  return ResultRuntime.tryPromise({
    try: async () => scanWorkspace(wsPath, opts),
    catch: (cause) => toLorraError(cause, 'skills-scan-failed'),
  });
}
