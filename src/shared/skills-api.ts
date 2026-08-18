/**
 * 技能管理共享契约（V1-1）：IPC 通道名、预算/健康常量、跨进程类型。
 * 主进程 skills-store 与渲染端技能页的唯一事实源 —— 两侧均从本模块导入，
 * 任何一侧改动常量都会静默破坏对端，测试锁定行为契约。
 */

// ---- 通道常量（skills-ipc 注册 / preload 透传）----
export const SKILLS_IPC = Object.freeze({
  /** 一次拉全量：技能列表 + 统计 + 预算 + 悬空清单 + git 状态 + 收集根（作用域 = 当前工作区）。 */
  xray: 'lorra.skills.xray',
  /** 全局隐藏（软禁用：只从 <available_skills> 提示清单剔除，不拦截 agent 主动 read）。 */
  setEnabled: 'lorra.skills.setEnabled',
  /** 悬空 junction/symlink 清理（lstat 判定，只 unlink 不删实体）。 */
  cleanDangling: 'lorra.skills.cleanDangling',
  /** 收集散乱技能：把各项目/用户目录下的技能实体收编到收集根，原位建 junction/symlink。 */
  collect: 'lorra.skills.collect',
  /** 检查收集根内 git 技能更新（网络 fetch，更新 xray 的 gitStatus）。 */
  checkUpdates: 'lorra.skills.checkUpdates',
  /** 统一拉取收集根内所有非 dirty 的 git 技能（--ff-only）。 */
  updateAll: 'lorra.skills.updateAll',
  /** 按工作区停用/启用（newmax 式）：写 workspaceSkillOverrides[wsRealpath]。 */
  setWsEnabled: 'lorra.skills.setWsEnabled',
  /** 读取技能文件内容（composer /skill 触发，2026-08-14）；未知技能 → skill-not-found。 */
  read: 'lorra.skills.read',
} as const);

// ---- 预算常量（PM 拍板定稿：token 唯一单位，三级分级 2,000/4,000）----

/** 良好线 = Claude Code skillListingBudgetFraction 默认 1%×200k ≈ 2,000 tokens。 */
export const SKILL_BUDGET_GOOD_TOKENS = 2000;
/** 超限线 = PM 拍板取整（newmax 基线 15,000 字符 ÷3.5 ≈ 4,286 → 4000）。 */
export const SKILL_BUDGET_WARN_TOKENS = 4000;
/** token 估算系数（中英混合口径，3.5 字符/token；UI 标注「估算」）。 */
export const SKILL_TOKEN_ESTIMATE_DIVISOR = 3.5;
/** pi SDK MAX_DESCRIPTION_LENGTH：description >1024 → 「描述过长」（SDK warning，仍全量注入）。 */
export const SKILL_DESC_CHARS_MAX = 1024;
/** 技能文件 >1MB 跳过加载并标「过大」（读入前 stat，防 DoS）。 */
export const SKILL_FILE_BYTES_MAX = 1024 * 1024;
/** 会话 jsonl >64MB 跳过统计（防 DoS 上限）。 */
export const SKILL_STATS_JSONL_BYTES_MAX = 64 * 1024 * 1024;
/** 触发统计 45 天窗口。 */
export const SKILL_STATS_WINDOW_DAYS = 45;
/** git 操作（clone/fetch/pull/status/rev-list）超时上限。 */
export const SKILL_GIT_TIMEOUT_MS = 30000;

// ---- 发现/健康 ----

/** 技能来源：收集根 / 祖先 .agents/skills / lorra 全局库 / 用户自有 / 工作区 / agent-plugin 插件。 */
export type SkillSource =
  | 'collection'
  | 'workspace'
  | 'lorra-global'
  | 'user'
  | 'ancestor'
  | 'agent-plugin';

/**
 * 可见性作用域：global = 处处触发（collection/lorra-global/user 源）；
 * project = 仅该项目会话触发（workspace/ancestor 源）。
 */
export type SkillScope = 'global' | 'project';

/**
 * 健康状态码：
 * - missing-description：缺 description（SDK 不加载，UI 标「缺描述」）
 * - description-too-long：>1024（SDK warning，仍全量注入、预算按全量）
 * - missing-file：文件缺失/不可读（残留语义，扫描时 stat 失败）
 * - frontmatter-type-error：name/description 非字符串（显式健康项而非静默丢弃）
 * - too-large：>1MB（跳过加载）
 */
export type SkillHealth =
  | 'ok'
  | 'missing-description'
  | 'description-too-long'
  | 'missing-file'
  | 'frontmatter-type-error'
  | 'too-large';

export interface SkillIssue {
  /** 日志/判定用；UI 展示直接消费 message（PM 语域）。 */
  code: SkillHealth;
  message: string;
}

export interface SkillInfo {
  /** 生效名（frontmatter name 或回退名）。 */
  name: string;
  source: SkillSource;
  /** 可见性作用域：global（处处触发）/ project（仅该项目会话触发）。 */
  scope: SkillScope;
  /** 发现路径（SKILL.md 或平铺 .md 的绝对路径；junction 情形 = 源顺序先者路径）。 */
  filePath: string;
  /** canonicalizePath 语义（realpath，失败回退 filePath）。 */
  realPath: string;
  /** 技能根 realpath：目录形技能 = SKILL.md 所在目录，平铺 = 源根（触发统计命中边界 / 激活 baseDir）。 */
  rootDir: string;
  description: string;
  descriptionChars: number;
  estimatedTokens: number;
  /** 有效注入态：非系统种子且不在用户禁用名单。 */
  enabled: boolean;
  /** 当前工作区停用状态（技能名 ∈ workspaceSkillOverrides[当前 ws realpath]；页面行内开关消费）。 */
  disabledInWs: boolean;
  /** 全局隐藏（技能名 ∈ disabledSkills；详情弹层内开关消费）。 */
  globallyHidden: boolean;
  /** 系统剔除种子（复盘种子等），UI 灰标「内部·未注入」，不进「有问题」计数、不进预算。 */
  systemManaged: boolean;
  /** frontmatter disable-model-invocation（SDK 不注入提示清单）。 */
  disableModelInvocation: boolean;
  /** 同名技能跨工作区源与其它源（realpath 不同）→ 标副本徽章。 */
  isDuplicate: boolean;
  issues: SkillIssue[];
}

// ---- 统计（V1-2 不实现 jsonl 解析；类型供 skill-manager 组装 xray）----

export interface SkillStats {
  totalCount: number;
  /** 45 天窗口内触发次数（会话级去重）。 */
  recentCount: number;
  /** 最近一次触发时刻（ms epoch）；从未触发 → null。 */
  lastUsedAt: number | null;
  /** per-workspace 归桶（会话条目 cwd 字段），键 = 真实工作区路径。 */
  byWorkspace: Record<string, number>;
}

// ---- 预算 ----

/** 三级分级：≤2000 良好（accent）/ ≤4000 警告（warm-brown #8A4A33）/ >4000 超限（danger）。 */
export type BudgetStatus = 'good' | 'warn' | 'over';

export interface SkillBudget {
  /** token 估算 = round(Σ 启用技能 description 字符数 ÷ 3.5)。 */
  estimatedTokens: number;
  /** 建议参考线（良好线 = SKILL_BUDGET_GOOD_TOKENS）。 */
  goodLine: number;
  /** 建议参考线（超限线 = SKILL_BUDGET_WARN_TOKENS）。 */
  warnLine: number;
  status: BudgetStatus;
  /** 启用集技能数（三源发现 − 系统种子 − disabledSkills − disableModelInvocation）。 */
  enabledCount: number;
  /** Σ 启用技能 description 字符数（token 之前的数据层单位）。 */
  charSum: number;
}

// ---- xray 全量（管理页一次拉取）----

/** git 技能状态（key = 技能名；behind/dirty 由只读本地 .git 判定，网络 fetch 只在 checkUpdates 通道）。 */
export interface SkillGitStatus {
  gitUrl: string;
  /** 本地落后远端（HEAD..@{u} 计数 > 0）。 */
  behind: boolean;
  /** 工作树有未提交修改（status --porcelain 非空）。 */
  dirty: boolean;
}

/** 收集结果（moved/linked 计数口径 = 成功条目数；conflicts/notes 为 PM 语域中文文案，直接进 UI）。 */
export interface CollectResult {
  moved: number;
  linked: number;
  conflicts: string[];
  notes: string[];
}

/** 安装结果。 */
export interface InstallResult {
  name: string;
  path: string;
}

export interface SkillXray {
  skills: SkillInfo[];
  stats: Record<string, SkillStats>;
  budget: SkillBudget;
  /** 悬空 junction/symlink 路径清单（当前工作区；有悬空才显示「清理悬空」）。 */
  dangling: string[];
  /** git 技能状态（key = 技能名；只读本地 .git 判定，不触发网络 fetch）。 */
  gitStatus: Record<string, SkillGitStatus>;
  /** 技能收集根（默认 ~/.agents/skills，可在设置自定义）。 */
  collectionRoot: string;
  workspacePath: string;
  /** 用户主目录（渲染端做 ~ 缩写展示；缺失时渲染端原样显示路径）。 */
  homeDir?: string;
}

/** 技能文件内容（composer /skill 触发；content 为 SKILL.md/平铺 .md 原文，≤1MB）。 */
export interface SkillReadResult {
  name: string;
  content: string;
}
