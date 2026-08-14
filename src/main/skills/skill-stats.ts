import { createHash } from 'node:crypto';
import {
  type Dirent,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Result as ResultRuntime } from 'better-result';

import type { Result } from '../../shared/result';
import { toLorraError } from '../../shared/result';
import type { SkillStats } from '../../shared/skills-api';
import { SKILL_STATS_JSONL_BYTES_MAX, SKILL_STATS_WINDOW_DAYS } from '../../shared/skills-api';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';

/**
 * 触发统计（V1-3）：从会话 jsonl 解析技能 read 触发（design D1）。
 *
 * - 递归扫描 `<userData>/sessions/**\/*.jsonl`（含嵌套子会话目录，勘误 2）
 * - 逐行 JSON.parse：session 条目记 cwd（扁平字段，无 header 包装）；
 * assistant message content 工具块三形状兼容（toolCall 当前 / toolUse / tool_use 旧），
 * name==='read'，路径取 arguments.path 或 input.path
 * - 路径归一化：相对路径按该文件 session 条目 cwd 解析为绝对；分隔符统一 \→/；
 * win32 大小写不敏感
 * - 命中判定 = 归一化绝对路径 ∈ 技能根 realpath 子树（realPath 精确集合 + rootDir 前缀 +
 * 分隔符边界；目录形技能的子文件 references/*.md 等计入；平铺技能只计自身文件，
 * 共享源根不做前缀判定，防兄弟平铺技能误伤）
 * - 会话级去重：同一 jsonl 内同一技能只计 1 次；触发时刻 = 包含该工具块的 message 条目 timestamp
 * - 45 天窗口：recentCount = timestamp ≥ now − 45d；byWorkspace = cwd realpath 归桶
 * （realpath 失败原样归桶；cwd 缺失/损坏 → 「未知工作区」桶）
 * - replace 语义 + mtime 缓存：per-file 统计整体替换、永不累加；缓存持久化到
 * `<userData>/skill-stats-cache.json`（原子写：临时文件 + rename）；mtime 未变 → 复用，
 * 变了 → 全文件幂等重解析。缓存附带技能集合指纹：技能集变化 → 全部缓存失效。
 * - 坏行（JSON.parse 失败，含流式半行）跳过、好行照计；整文件不可读/ >64MB → 跳过该文件
 * - 只读解析，不写 sessions
 */

// ---- 常量 ----

/** 遍历器最大深度（防 symlink 环卡死主进程，design Sec #4 同款纪律）。 */
const MAX_SCAN_DEPTH = 32;

/** cwd 缺失/损坏的归桶键（best-effort，不丢统计）。 */
export const UNKNOWN_WORKSPACE = '未知工作区';

/** mtime 缓存文件名（userData 根下；原子写，失败静默降级为全量重解析）。 */
const CACHE_FILE = 'skill-stats-cache.json';

// ---- 公开类型 ----

export interface SkillStatsInput {
  name: string;
  /** 技能文件 realpath（SKILL.md 或平铺 .md）。 */
  realPath: string;
  /** 技能根 realpath（命中判定边界；目录形技能 = SKILL.md 所在目录，平铺 = 源根）。 */
  rootDir: string;
}

export interface SkillStatsOpts {
  /** 测试注入的基准时刻（ms）；缺省 Date.now。 */
  now?: number;
  /** userData 目录（缺省 lorraConfigDir；sessions 与缓存均在其下）。 */
  userDataDir?: string;
}

// ---- 内部类型 ----

interface PerFileStats {
  totalCount: number;
  recentCount: number;
  lastUsedAt: number | null;
  byWorkspace: Record<string, number>;
}

interface CacheFileShape {
  version: 1;
  /** 技能集合指纹：技能集变化 → 全部缓存失效（缓存结果依赖命中索引）。 */
  skillsFingerprint: string;
  files: Record<string, { mtimeMs: number; stats: Record<string, PerFileStats> }>;
}

interface HitIndex {
  /** 归一化 realPath → 技能名（技能文件自身精确命中）。 */
  exact: Map<string, string>;
  /** 目录形技能：归一化 rootDir + '/'（子文件子树，分隔符边界）。 */
  prefixes: Array<{ name: string; prefix: string }>;
}

// ---- 入口 ----

/**
 * 解析全部会话 jsonl 得到每个技能的触发统计。
 * 空技能集合 → 空 Record；sessions 目录不存在/不可读 → 全零 Record。
 */
export function getSkillStats(
  skills: SkillStatsInput[],
  opts: SkillStatsOpts = {},
): Promise<Result<Record<string, SkillStats>>> {
  return ResultRuntime.tryPromise({
    try: async () => computeStats(skills, opts),
    catch: (cause) => toLorraError(cause, 'skill-stats-failed'),
  });
}

// ---- 主流程 ----

function computeStats(skills: SkillStatsInput[], opts: SkillStatsOpts): Record<string, SkillStats> {
  const userDataDir = opts.userDataDir ?? lorraConfigDir();
  const now = opts.now ?? Date.now();
  const windowStart = now - SKILL_STATS_WINDOW_DAYS * 86_400_000;

  const out: Record<string, SkillStats> = {};
  for (const s of skills) {
    out[s.name] = { totalCount: 0, recentCount: 0, lastUsedAt: null, byWorkspace: {} };
  }
  if (skills.length === 0) return out;

  const index = buildHitIndex(skills);
  const fingerprint = skillsFingerprint(skills);
  const cachePath = path.join(userDataDir, CACHE_FILE);
  const cache = loadCache(cachePath);
  const cacheStale = cache.skillsFingerprint !== fingerprint;

  const files = collectJsonlFiles(path.join(userDataDir, 'sessions'));

  const nextFiles: CacheFileShape['files'] = {};
  for (const file of files) {
    const st = safeStat(file);
    if (!st) continue; // 整文件不可读 → 跳过，整体不报错
    if (st.size > SKILL_STATS_JSONL_BYTES_MAX) continue; // >64MB 防 DoS → 跳过

    const cached = cacheStale ? undefined : cache.files[file];
    let perFile: Record<string, PerFileStats>;
    if (cached && cached.mtimeMs === st.mtimeMs) {
      perFile = cached.stats; // mtime 未变 → 复用缓存，跳过重解析
      nextFiles[file] = cached;
    } else {
      perFile = parseFile(file, index, windowStart); // mtime 变/无缓存 → 全文件幂等重解析
      nextFiles[file] = { mtimeMs: st.mtimeMs, stats: perFile };
    }
    mergeInto(out, perFile);
  }
  saveCache(cachePath, { version: 1, skillsFingerprint: fingerprint, files: nextFiles });
  return out;
}

function mergeInto(out: Record<string, SkillStats>, perFile: Record<string, PerFileStats>): void {
  for (const [name, f] of Object.entries(perFile)) {
    const agg = out[name];
    if (!agg) continue;
    agg.totalCount += f.totalCount;
    agg.recentCount += f.recentCount;
    if (f.lastUsedAt !== null && (agg.lastUsedAt === null || f.lastUsedAt > agg.lastUsedAt)) {
      agg.lastUsedAt = f.lastUsedAt;
    }
    for (const [ws, n] of Object.entries(f.byWorkspace)) {
      agg.byWorkspace[ws] = (agg.byWorkspace[ws] ?? 0) + n;
    }
  }
}

// ---- 单文件解析 ----

function parseFile(
  filePath: string,
  index: HitIndex,
  windowStart: number,
): Record<string, PerFileStats> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return {}; // 调用侧已 stat 成功；read 抛错仍兜底跳过该文件
  }

  const perFile: Record<string, PerFileStats> = {};
  let cwd: string | undefined;
  // bucketCwd 用 Symbol 哨兵区分「尚未计算」与「cwd 为 undefined」两个状态，
  // 否则首调在 cwd===undefined 时误判命中缓存返回未设置的 bucket。
  let bucketCwd: string | undefined | symbol = Symbol('unset');
  let bucket: string | undefined;
  // cwd 同值记忆：realpath 归桶只算一次（realpathSync 失败 → 原样归桶）。
  const bucketOf = (): string => {
    if (cwd !== bucketCwd) {
      bucketCwd = cwd;
      bucket =
        typeof cwd === 'string' && cwd !== '' ? (safeRealpath(cwd) ?? cwd) : UNKNOWN_WORKSPACE;
    }
    return bucket ?? UNKNOWN_WORKSPACE;
  };

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // 坏行（含流式追加的半行）跳过，好行照计
    }
    if (typeof record !== 'object' || record === null) continue;
    const rec = record as Record<string, unknown>;

    if (rec.type === 'session') {
      // 扁平 cwd 字段（无 header 包装）；非字符串视为损坏 → 未知工作区桶。
      if (typeof rec.cwd === 'string') cwd = rec.cwd;
      continue;
    }
    if (rec.type !== 'message') continue;

    const msg = rec.message as { role?: unknown; content?: unknown } | undefined;
    if (
      !msg ||
      typeof msg !== 'object' ||
      msg.role !== 'assistant' ||
      !Array.isArray(msg.content)
    ) {
      continue;
    }
    const tsMs = parseTimestamp(rec.timestamp);

    for (const block of msg.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: unknown; name?: unknown; arguments?: unknown; input?: unknown };
      if (b.type !== 'toolCall' && b.type !== 'toolUse' && b.type !== 'tool_use') continue;
      if (b.name !== 'read') continue;

      const rawPath = readToolPath(b);
      if (rawPath === null) continue;
      const norm = normalizeReadPath(rawPath, cwd);
      if (norm === null) continue; // 相对路径但该文件无 cwd → 无法解析，跳过

      const hitName = lookupHit(index, norm);
      if (hitName === null) continue; // read 非技能文件 → 不计

      let pf = perFile[hitName];
      if (!pf) {
        pf = { totalCount: 0, recentCount: 0, lastUsedAt: null, byWorkspace: {} };
        perFile[hitName] = pf;
      }
      if (pf.totalCount > 0) continue; // 会话级去重：同一 jsonl 内同一技能只计 1 次

      pf.totalCount = 1;
      pf.recentCount = tsMs !== null && tsMs >= windowStart ? 1 : 0;
      pf.lastUsedAt = tsMs; // 触发时刻 = 包含该工具块的 message 条目 timestamp
      pf.byWorkspace[bucketOf()] = 1;
    }
  }
  return perFile;
}

// ---- 工具块 / 路径处理 ----

/** 三形状兼容：arguments.path（toolCall 当前）/ input.path（toolUse / tool_use 旧）。 */
function readToolPath(b: { arguments?: unknown; input?: unknown }): string | null {
  const args = b.arguments;
  if (args && typeof args === 'object') {
    const p = (args as { path?: unknown }).path;
    if (typeof p === 'string') return p;
  }
  const input = b.input;
  if (input && typeof input === 'object') {
    const p = (input as { path?: unknown }).path;
    if (typeof p === 'string') return p;
  }
  return null;
}

/**
 * 归一化 read 路径：相对路径按该文件 session 条目 cwd 解析为绝对；
 * 分隔符统一 \→/；win32 大小写不敏感。相对且无 cwd → null（无法解析）。
 */
function normalizeReadPath(raw: string, cwd: string | undefined): string | null {
  const absoluteLike = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/');
  let abs: string;
  if (absoluteLike) {
    abs = process.platform === 'win32' ? path.resolve(raw) : path.win32.resolve(raw);
  } else if (typeof cwd === 'string') {
    abs = path.resolve(cwd, raw);
  } else {
    return null;
  }
  let s = abs.replace(/\\/g, '/');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// ---- 命中索引 ----

function buildHitIndex(skills: SkillStatsInput[]): HitIndex {
  const exact = new Map<string, string>();
  const prefixes: Array<{ name: string; prefix: string }> = [];
  for (const s of skills) {
    const realNorm = normalizeReadPath(s.realPath, undefined);
    if (realNorm !== null) exact.set(realNorm, s.name);
    // 目录形技能（realPath 末段 SKILL.md）：rootDir 前缀子树（references/*.md 等子文件）算命中。
    // 平铺技能不加 rootDir 前缀 —— 平铺技能共享源根，前缀判定会误伤兄弟平铺技能
    // （read 非技能文件不计）。技能文件自身由 exact 集合覆盖。
    if (path.basename(s.realPath).toLowerCase() === 'skill.md') {
      const rootNorm = normalizeReadPath(s.rootDir, undefined);
      if (rootNorm !== null) prefixes.push({ name: s.name, prefix: `${rootNorm}/` });
    }
  }
  return { exact, prefixes };
}

function lookupHit(index: HitIndex, norm: string): string | null {
  const exactName = index.exact.get(norm);
  if (exactName !== undefined) return exactName;
  for (const { name, prefix } of index.prefixes) {
    if (norm.startsWith(prefix)) return name; // 分隔符边界：prefix 以 / 结尾
  }
  return null;
}

// ---- 递归扫描（含嵌套子会话目录）----

function collectJsonlFiles(sessionsRoot: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const rootReal = safeRealpath(sessionsRoot);
  if (rootReal !== null) visited.add(rootReal);

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/不可读 → 空集合
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const real = safeRealpath(full);
        if (real !== null && !visited.has(real)) {
          visited.add(real);
          walk(full, depth + 1);
        }
        continue;
      }
      if (entry.isFile()) {
        if (entry.name.endsWith('.jsonl')) out.push(full);
        continue;
      }
      // symlink：跟随判型递归；断链且名 .jsonl → 交解析层 stat 兜底（不可读跳过语义）。
      if (entry.isSymbolicLink()) {
        const st = safeStat(full);
        if (!st) {
          if (entry.name.endsWith('.jsonl')) out.push(full);
        } else if (st.isDirectory()) {
          const real = safeRealpath(full);
          if (real !== null && !visited.has(real)) {
            visited.add(real);
            walk(full, depth + 1);
          }
        } else if (st.isFile() && entry.name.endsWith('.jsonl')) {
          out.push(full);
        }
      }
    }
  };
  walk(sessionsRoot, 0);
  return out;
}

// ---- mtime 缓存（replace 语义 + 原子写）----

function skillsFingerprint(skills: SkillStatsInput[]): string {
  const parts = skills.map((s) => `${s.name}\u0000${s.realPath}\u0000${s.rootDir}`).sort();
  return createHash('sha1').update(parts.join('\u0001'), 'utf8').digest('hex').slice(0, 16);
}

function loadCache(cachePath: string): CacheFileShape {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<CacheFileShape>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.files &&
      typeof parsed.files === 'object' &&
      parsed.files !== null
    ) {
      return {
        version: 1,
        skillsFingerprint:
          typeof parsed.skillsFingerprint === 'string' ? parsed.skillsFingerprint : '',
        files: parsed.files as CacheFileShape['files'],
      };
    }
  } catch {
    // 缓存缺失/损坏 → 全量重解析（缓存只是优化）
  }
  return { version: 1, skillsFingerprint: '', files: {} };
}

function saveCache(cachePath: string, cache: CacheFileShape): void {
  try {
    // 原子写：临时文件 + rename（覆盖既有文件）；失败静默降级，不阻断统计。
    const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    renameSync(tmp, cachePath);
  } catch {
    // 缓存写失败不影响本次统计结果
  }
}

// ---- fs 兜底 ----

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
