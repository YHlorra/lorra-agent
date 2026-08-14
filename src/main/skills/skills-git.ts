import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Result as ResultRuntime } from 'better-result';
import { app, shell } from 'electron';

import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import {
  type InstallResult,
  SKILL_GIT_TIMEOUT_MS,
  type SkillGitStatus,
} from '../../shared/skills-api';
import { parseFrontmatter } from './skills-store';

/**
 * 技能 Git 操作层（2026-08-13 批，D6）——clone 安装 / 更新检查 / 统一拉取。
 *
 * 全部 git 操作经 execFile('git', args, { cwd, timeout: SKILL_GIT_TIMEOUT_MS })
 * 收敛为 Result（不手写 try/catch）；git CLI 缺失（ENOENT）→ git-unavailable
 * 「未检测到 git，请先安装」。
 *
 * - installSkill：https URL 校验 → clone --depth 1 到收集根 → 产物校验（树内含
 * SKILL.md 任意深度或根下平铺 .md；不含 → 回收站回滚 + not-a-skill）→
 * skill-installs.json 元数据注册（原子写）。
 * - getGitStatuses：每个含 .git 的收集根子目录 fetch --depth 1 后判定
 * behind（rev-list --count HEAD..@{u} > 0）/ dirty（status --porcelain 非空）；
 * 单目录失败 → 该条 behind:false dirty:false（不炸整体）。网络 fetch 版
 * （checkUpdates 通道）；xray 用 getLocalGitStatuses（只读本地，不 fetch）。
 * - updateAll：dirty → skipped「本地已修改，跳过」；非 dirty → pull --ff-only
 * （成功 updated / 失败 skipped 带原因）；全部失败才整体 err。
 *
 * name 口径与 skills-store 同源：SKILL.md frontmatter name → 目录名回退。
 */

/** 安装元数据注册表：<userData>/skill-installs.json（与 settings.json 同目录）。 */
export interface SkillInstallMeta {
  gitUrl: string;
  installedAt: number;
}
export type SkillInstallsMap = Record<string, SkillInstallMeta>;

const execFileAsync = promisify(execFile);

/** 遍历器最大深度（防 symlink 环，skills-store 同款纪律）。 */
const MAX_DEPTH = 32;

/** git 调用（超时 + ENOENT → git-unavailable）。 */
function runGit(args: string[], cwd: string): Promise<Result<string>> {
  return ResultRuntime.tryPromise({
    try: async () => {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        timeout: SKILL_GIT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trim();
    },
    catch: (cause) => {
      if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return { code: 'git-unavailable', message: '未检测到 git，请先安装' } as const;
      }
      return toLorraError(cause, 'git-error');
    },
  });
}

/** 目录树内找 SKILL.md（根优先，visited-realpath + 深度防环）；找不到 → null。 */
function findSkillMd(dir: string): string | null {
  const visited = new Set<string>();
  const queue = [dir];
  for (let depth = 0; queue.length > 0 && depth <= MAX_DEPTH; depth++) {
    const next: string[] = [];
    for (const d of queue) {
      let real: string;
      try {
        real = realpathSync(d);
      } catch {
        continue;
      }
      if (visited.has(real)) continue;
      visited.add(real);
      let entries: Dirent[];
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.name === 'SKILL.md' && entry.isFile()) return full;
        if (entry.isDirectory()) next.push(full);
      }
    }
    queue.splice(0, queue.length, ...next);
  }
  return null;
}

/** 根下平铺 .md 存在性。 */
function hasRootFlatMd(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'SKILL.md',
    );
  } catch {
    return false;
  }
}

/** 技能名（frontmatter name → 目录名回退；无可读 SKILL.md → 目录名）。 */
function skillNameOf(dir: string): string {
  const skillMd = findSkillMd(dir);
  if (skillMd) {
    try {
      const fm = parseFrontmatter(readFileSync(skillMd, 'utf8'));
      if (typeof fm.name === 'string' && fm.name !== '') return fm.name;
    } catch {
      // 不可读 → 回退目录名。
    }
  }
  return path.basename(dir);
}

/** 原子写（temp + rename，照 settings.ts writeSettings）。 */
async function atomicWrite(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.skill-installs.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, content, 'utf8');
  await rename(temp, target);
}

/** 读安装注册表（不存在/损坏 → 空表）。 */
async function readInstalls(): Promise<SkillInstallsMap> {
  const regPath = path.join(app.getPath('userData'), 'skill-installs.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(regPath, 'utf8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: SkillInstallsMap = {};
  for (const [name, meta] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      meta !== null &&
      typeof meta === 'object' &&
      typeof (meta as SkillInstallMeta).gitUrl === 'string'
    ) {
      out[name] = {
        gitUrl: (meta as SkillInstallMeta).gitUrl,
        installedAt:
          typeof (meta as SkillInstallMeta).installedAt === 'number'
            ? (meta as SkillInstallMeta).installedAt
            : 0,
      };
    }
  }
  return out;
}

/**
 * 安装技能（D6）：URL 校验 → clone --depth 1 → 产物校验（回滚）→ 元数据注册。
 * 非法 URL → invalid-git-url；目标已存在 → skill-exists；clone 失败 → clone-failed；
 * 非技能仓库 → 回收站回滚 + not-a-skill。
 */
export async function installSkill(
  gitUrl: string,
  collectionRoot: string,
): Promise<Result<InstallResult>> {
  let parsed: URL;
  try {
    parsed = new URL(gitUrl);
  } catch {
    return err({ code: 'invalid-git-url', message: '请输入有效的 https 仓库地址' });
  }
  if (!/^https:\/\//.test(gitUrl) || parsed.host === '' || gitUrl.includes('file:')) {
    return err({ code: 'invalid-git-url', message: '请输入有效的 https 仓库地址' });
  }
  const dirName = path.basename(parsed.pathname).replace(/\.git$/, '');
  if (dirName === '' || dirName === '.' || dirName === '..') {
    return err({ code: 'invalid-git-url', message: '请输入有效的 https 仓库地址' });
  }
  const target = path.join(collectionRoot, dirName);
  if (existsSync(target)) {
    return err({ code: 'skill-exists', message: '同名技能已存在' });
  }
  // 收集根可能尚不存在(自定义根首次安装):先建目录,否则 git spawn cwd 缺失 → ENOENT。
  await mkdir(collectionRoot, { recursive: true });
  const cloneRes = await runGit(['clone', '--depth', '1', gitUrl, target], collectionRoot);
  if (cloneRes.isErr()) {
    // git 不可用透传（页面 git 功能整体隐藏）；其余失败归 clone-failed（PM 语域）。
    if (cloneRes.error.code === 'git-unavailable') return cloneRes;
    return err({ code: 'clone-failed', message: '安装失败：无法访问该仓库（检查地址与网络）' });
  }
  if (!findSkillMd(target) && !hasRootFlatMd(target)) {
    await shell.trashItem(target);
    return err({ code: 'not-a-skill', message: '该仓库不是技能（缺少 SKILL.md）' });
  }
  const name = skillNameOf(target);
  const installs = await readInstalls();
  installs[name] = { gitUrl, installedAt: Date.now() };
  await atomicWrite(
    path.join(app.getPath('userData'), 'skill-installs.json'),
    JSON.stringify(installs, null, 2),
  );
  return ok({ name, path: target });
}

/** 收集根内含 .git 的直接子目录（名称 + 路径）。 */
function gitDirs(collectionRoot: string): Array<{ dir: string; name: string }> {
  const out: Array<{ dir: string; name: string }> = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(collectionRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(collectionRoot, entry.name);
    if (!existsSync(path.join(dir, '.git'))) continue;
    out.push({ dir, name: entry.name });
  }
  return out;
}

/** 单目录状态判定（behind/dirty/gitUrl；fetch 失败 → 空状态不炸）。 */
async function dirStatus(dir: string, doFetch: boolean): Promise<SkillGitStatus> {
  if (doFetch) {
    await runGit(['fetch', '--depth', '1'], dir);
  }
  const urlRes = await runGit(['config', '--get', 'remote.origin.url'], dir);
  const behindRes = await runGit(['rev-list', '--count', 'HEAD..@{u}'], dir);
  const dirtyRes = await runGit(['status', '--porcelain'], dir);
  return {
    gitUrl: urlRes.isOk() ? urlRes.value : '',
    behind: behindRes.isOk() && Number.parseInt(behindRes.value, 10) > 0,
    dirty: dirtyRes.isOk() && dirtyRes.value !== '',
  };
}

/**
 * 收集根全部 git 技能状态（key = 技能名）。doFetch=true（checkUpdates 通道）触发
 * 网络 fetch；false（xray 组装）只读本地 .git（status + 本地缓存引用 HEAD..@{u}）。
 * git CLI 不可用 → ok({})（页面 git 列整体隐藏，其余功能不受影响）。
 */
async function scanGitStatuses(
  collectionRoot: string,
  doFetch: boolean,
): Promise<Result<Record<string, SkillGitStatus>>> {
  // 收集根不存在 → 无 git 技能 → 空表(避免 spawn cwd 缺失误判 git-unavailable)。
  if (!existsSync(collectionRoot)) return ok({});
  const probe = await runGit(['--version'], collectionRoot);
  if (probe.isErr()) {
    if (probe.error.code === 'git-unavailable') return ok({});
    return probe;
  }
  const out: Record<string, SkillGitStatus> = {};
  for (const { dir } of gitDirs(collectionRoot)) {
    out[skillNameOf(dir)] = await dirStatus(dir, doFetch);
  }
  return ok(out);
}

/** 检查更新（网络 fetch；checkUpdates 通道）。 */
export function getGitStatuses(
  collectionRoot: string,
): Promise<Result<Record<string, SkillGitStatus>>> {
  return scanGitStatuses(collectionRoot, true);
}

/** 只读本地状态（不触发网络 fetch；xray 组装用）。 */
export function getLocalGitStatuses(
  collectionRoot: string,
): Promise<Result<Record<string, SkillGitStatus>>> {
  return scanGitStatuses(collectionRoot, false);
}

/**
 * 统一拉取（D6）：dirty → skipped「本地已修改，跳过」；非 dirty → pull --ff-only。
 * 全部 git 目录都失败才整体 err（git-update-failed）；部分失败进 skipped 带原因。
 */
export async function updateAll(
  collectionRoot: string,
): Promise<Result<{ updated: string[]; skipped: string[] }>> {
  // 收集根不存在 → 无 git 技能 → 空结果。
  if (!existsSync(collectionRoot)) return ok({ updated: [], skipped: [] });
  const probe = await runGit(['--version'], collectionRoot);
  if (probe.isErr()) {
    if (probe.error.code === 'git-unavailable') return probe;
    return probe;
  }
  const updated: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  const dirs = gitDirs(collectionRoot);
  for (const { dir } of dirs) {
    const name = skillNameOf(dir);
    const dirtyRes = await runGit(['status', '--porcelain'], dir);
    if (dirtyRes.isErr()) {
      skipped.push(`${name}：状态检查失败，跳过`);
      failures.push(name);
      continue;
    }
    if (dirtyRes.value !== '') {
      skipped.push(`${name}：本地已修改，跳过`);
      continue;
    }
    const pullRes = await runGit(['pull', '--ff-only'], dir);
    if (pullRes.isErr()) {
      if (pullRes.error.code === 'git-unavailable') return pullRes;
      skipped.push(`${name}：更新失败（${pullRes.error.message}）`);
      failures.push(name);
      continue;
    }
    updated.push(name);
  }
  if (failures.length > 0 && failures.length === dirs.length) {
    return err({ code: 'git-update-failed', message: '更新失败：所有技能仓库都无法拉取' });
  }
  return ok({ updated, skipped });
}
