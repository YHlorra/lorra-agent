import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { existsSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Result as ResultRuntime } from 'better-result';
import { shell } from 'electron';

import type { Result } from '../../shared/result';
import { toLorraError } from '../../shared/result';
import type { CollectResult } from '../../shared/skills-api';
import { readSettings } from '../workspace/settings';
import { parseFrontmatter, SEED_FILE_SKILL_NAMES } from './skills-store';

/**
 * 技能收集（2026-08-13 批，D5）——纯文件操作层，无 IPC/页面依赖。
 *
 * 把散落在各项目/用户目录下的技能实体统一到收集根（默认 ~/.agents/skills），
 * 原位置只留 junction（win32）/symlink（posix）。收集根可自定义：settings
 * `skillCollectionRoot`（空串 = 默认值，见 getSkillCollectionRoot）。
 *
 * 语义（与 skill-manager 编排层契约）：
 * - 散乱扫描位置 = recentWorkspaces 每项的 <ws>/.lorra/skills、<ws>/.agents/skills、
 * <ws>/.claude/skills + ~/.claude/skills（realpath 存在性过滤）；
 * 排除 = 收集根本身、与收集根重叠的 ~/.agents/skills、系统管理种子三种子。
 * - 技能实体形状：目录形（直接子目录含 SKILL.md）/ 平铺（根下 .md 文件）。
 * - 无同名：目录形 rename 到 <root>/<basename>（EXDEV → copy + 回收站原实体），
 * 成功后原位建 junction/symlink 指回收集根；平铺 .md rename/copy 进收集根，
 * 不建链接（junction 只支持目录目标），记 note「平铺文件已收集，原位置无链接」。
 * - 有同名：目录树内容等价（逐文件 size+sha256，忽略 .git）→ 回收站原实体 + 原位
 * junction，计「建链」；不等价 → 不处理，记 conflict。
 * - 单条目失败 → 收集该条目错误并继续；全部失败才整体 err（skills-collect-failed）。
 * - 遍历 visited-realpath + MAX_DEPTH 32 防环（对齐 skills-store 纪律）。
 * - 库根不存在 → 自动创建（recursive）。
 *
 * 结果 { moved, linked, conflicts, notes }：moved/linked 计数口径 = 成功条目数；
 * conflicts/notes 为 PM 语域中文文案，直接进 UI 结果提示。
 */

/** 遍历器最大深度（防 symlink 环卡死主进程，skills-store 同款纪律）。 */
const MAX_DEPTH = 32;

/** win32 大小写不敏感比较键。 */
function normKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** realpath，失败回退 null（缺失条目跳过）。 */
function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** frontmatter name → 目录名回退（横跨收集/git 的 name 口径，skills-store 同源）。 */
function skillDisplayName(dir: string): string {
  try {
    const fm = parseFrontmatter(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    if (typeof fm.name === 'string' && fm.name !== '') return fm.name;
  } catch {
    // 不可读 → 回退目录名。
  }
  return path.basename(dir);
}

/** 目录树相对文件清单（忽略 .git 子树；visited-realpath + 深度防环）。 */
async function collectFiles(
  root: string,
  dir: string,
  out: string[],
  visited: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const real = tryRealpath(dir);
  if (!real || visited.has(normKey(real))) return;
  visited.add(normKey(real));
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 不可读目录：跳过（best-effort）。
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    let st: Stats;
    try {
      st = await stat(full);
    } catch {
      continue; // 竞态删除 → 跳过。
    }
    const rel = path.relative(root, full);
    if (st.isDirectory()) {
      await collectFiles(root, full, out, visited, depth + 1);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
}

/** 两目录树内容等价（相对文件集合 + size + sha256，忽略 .git）。 */
async function dirsEquivalent(a: string, b: string): Promise<boolean> {
  const filesA: string[] = [];
  const filesB: string[] = [];
  await collectFiles(a, a, filesA, new Set(), 0);
  await collectFiles(b, b, filesB, new Set(), 0);
  filesA.sort();
  filesB.sort();
  if (filesA.length !== filesB.length) return false;
  for (let i = 0; i < filesA.length; i++) {
    if (filesA[i] !== filesB[i]) return false;
    const pa = path.join(a, filesA[i]);
    const pb = path.join(b, filesB[i]);
    try {
      const [sa, sb] = await Promise.all([stat(pa), stat(pb)]);
      if (sa.size !== sb.size) return false;
      // 2026-08-18:同步 readFileSync → 异步 readFile(大技能树不再阻塞主进程事件循环)。
      const sha = async (p: string): Promise<string> =>
        createHash('sha256')
          .update(await readFile(p))
          .digest('hex');
      if ((await sha(pa)) !== (await sha(pb))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 两文件内容等价（size + sha256）。 */
async function filesEquivalent(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    if (sa.size !== sb.size) return false;
    const sha = async (p: string): Promise<string> =>
      createHash('sha256')
        .update(await readFile(p))
        .digest('hex');
    return (await sha(a)) === (await sha(b));
  } catch {
    return false;
  }
}

/** 原位建链接：win32 junction / posix symlink（目标须为目录；平铺文件不建）。 */
function createLink(linkPath: string, target: string): void {
  if (process.platform === 'win32') symlinkSync(target, linkPath, 'junction');
  else symlinkSync(target, linkPath);
}

/** 移动（rename，EXDEV 跨卷 → copy + 回收站原实体）。失败抛错（调用方收口）。 */
async function moveEntity(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(src, dest, { recursive: true, force: true });
    await shell.trashItem(src);
  }
}

/**
 * 收集一个散乱位置（realpath 已校验存在）：
 * 直接子目录含 SKILL.md → 目录形；根下 .md → 平铺。逐条目收口错误继续。
 * 已收集条目（realpath 落在收集根内：本位置是上次收集留下的 junction/symlink，
 * 或实体本就指向收集根）一律跳过——不重复 trash/重建（2026-08-13 复盘修复）。
 */
async function collectFromLocation(
  location: string,
  collectionRoot: string,
  collectionRootReal: string,
  result: CollectResult,
  errors: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(location, { withFileTypes: true });
  } catch {
    return; // 不可读位置：跳过（best-effort）。
  }
  const seeds = SEED_FILE_SKILL_NAMES as readonly string[];
  for (const entry of entries) {
    const full = path.join(location, entry.name);
    // 已收集判定:realpath(跟随链接) ⊆ 收集根(前缀边界;win32 大小写不敏感)。
    // 跳过前提是「内容已在收集根」——再收集只会重复 trash + 重建链接,零收益。
    const real = tryRealpath(full);
    if (real && isWithinCollection(real, collectionRootReal)) continue;
    const isDir =
      entry.isDirectory() ||
      (entry.isSymbolicLink() && existsSync(full) && statSync(full).isDirectory());
    const isFile =
      entry.isFile() || (entry.isSymbolicLink() && existsSync(full) && statSync(full).isFile());
    if (!isDir && !isFile) continue;
    try {
      if (isDir) {
        // 目录形：须含 SKILL.md。
        if (!existsSync(path.join(full, 'SKILL.md'))) continue;
        const displayName = skillDisplayName(full);
        if (seeds.includes(displayName as (typeof seeds)[number])) continue;
        await collectDirSkill(full, collectionRoot, result);
      } else if (entry.name.endsWith('.md')) {
        const displayName = entry.name.replace(/\.md$/i, '');
        if (seeds.includes(displayName as (typeof seeds)[number])) continue;
        await collectFlatSkill(full, entry.name, collectionRoot, result);
      }
    } catch (error) {
      errors.push(
        `${entry.name}：收集失败（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }
}

/** real ⊆ 收集根(自身或 root + 分隔符前缀;win32 大小写不敏感)。 */
function isWithinCollection(real: string, collectionRootReal: string): boolean {
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  const root = lower(collectionRootReal);
  const p = lower(real);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return p === root || p.startsWith(rootWithSep);
}

/**
 * 收集根内按技能名(frontmatter name)查找已有技能根目录;找不到 → null。
 * 2026-08-18 修复:收集去重此前只按目录名判碰撞,frontmatter name 相同而目录名不同
 * 会收集出两份同名技能(扫描端同名先到者胜,后一份静默丢失)。
 */
async function findCollectedDirByName(
  collectionRoot: string,
  displayName: string,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(collectionRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(collectionRoot, entry.name);
    if (!existsSync(path.join(dir, 'SKILL.md'))) continue;
    if (skillDisplayName(dir) === displayName) return dir;
  }
  return null;
}

/** 目录形技能收编：无同名 → 移动 + 原位建链；有同名 → 等价建链 / 不等价冲突。 */
async function collectDirSkill(
  src: string,
  collectionRoot: string,
  result: CollectResult,
): Promise<void> {
  const basename = path.basename(src);
  const displayName = skillDisplayName(src);
  const dest = path.join(collectionRoot, basename);
  const linkedNote = `${displayName}：已收集但无法建链接`;
  // 同名技能(frontmatter name)已存在且不是同一目录 → 等价建链 / 不等价冲突
  // (2026-08-18 修复:此前只按目录名判碰撞,同名不同目录会收集出两份)。
  const sameNameDir = await findCollectedDirByName(collectionRoot, displayName);
  if (sameNameDir !== null && normKey(sameNameDir) !== normKey(dest)) {
    if (await dirsEquivalent(src, sameNameDir)) {
      await shell.trashItem(src);
      try {
        createLink(src, sameNameDir);
      } catch {
        result.notes.push(linkedNote);
      }
      result.linked += 1;
    } else {
      result.conflicts.push(`${displayName}：与原技能内容不同，保留原样`);
    }
    return;
  }
  if (!existsSync(dest)) {
    await moveEntity(src, dest);
    result.moved += 1;
    try {
      createLink(src, dest);
    } catch {
      result.notes.push(linkedNote);
    }
    return;
  }
  if (await dirsEquivalent(src, dest)) {
    await shell.trashItem(src);
    try {
      createLink(src, dest);
    } catch {
      result.notes.push(linkedNote);
    }
    result.linked += 1;
    return;
  }
  result.conflicts.push(`${displayName}：与原技能内容不同，保留原样`);
}

/** 平铺 .md 收编：移动进收集根，不建链接；同名等价 → 回收站原副本（计建链）。 */
async function collectFlatSkill(
  src: string,
  filename: string,
  collectionRoot: string,
  result: CollectResult,
): Promise<void> {
  const displayName = filename.replace(/\.md$/i, '');
  const dest = path.join(collectionRoot, filename);
  if (!existsSync(dest)) {
    await moveEntity(src, dest);
    result.moved += 1;
    result.notes.push(`${displayName}：平铺文件已收集，原位置无链接`);
    return;
  }
  if (await filesEquivalent(src, dest)) {
    await shell.trashItem(src);
    result.linked += 1;
    result.notes.push(`${displayName}：平铺文件与收集根同名等价，原副本已清理`);
    return;
  }
  result.conflicts.push(`${displayName}：与原技能内容不同，保留原样`);
}

/**
 * 收集散乱技能（D5）。wsPath 为编排层 realpath 校验后的工作区锚点；
 * 实际扫描范围 = recentWorkspaces 全部条目 + ~/.claude/skills（与设置同源）。
 * 全部条目失败 → err skills-collect-failed；部分失败 → ok 且失败原因进 notes。
 */
export async function collectSkills(
  _wsPath: string,
  opts: { collectionRoot: string },
): Promise<Result<CollectResult>> {
  return ResultRuntime.tryPromise({
    try: async () => {
      const home = os.homedir();
      const settings = await readSettings();
      const collectionRoot = path.resolve(opts.collectionRoot);
      await mkdir(collectionRoot, { recursive: true });

      const locations = [
        ...settings.recentWorkspaces.flatMap((ws) => [
          path.join(ws, '.lorra', 'skills'),
          path.join(ws, '.agents', 'skills'),
          path.join(ws, '.claude', 'skills'),
        ]),
        path.join(home, '.claude', 'skills'),
      ];

      // 排除：收集根本身 + 与收集根重叠的 ~/.agents/skills（默认值即重叠）。
      const excluded = new Set<string>();
      for (const p of [collectionRoot, path.join(home, '.agents', 'skills')]) {
        const real = tryRealpath(p);
        if (real) excluded.add(normKey(real));
      }

      const result: CollectResult = { moved: 0, linked: 0, conflicts: [], notes: [] };
      const errors: string[] = [];
      const visited = new Set<string>();
      const collectionRootReal = tryRealpath(collectionRoot) ?? collectionRoot;
      for (const loc of locations) {
        const real = tryRealpath(loc);
        if (!real) continue;
        const key = normKey(real);
        if (excluded.has(key) || visited.has(key)) continue;
        visited.add(key);
        await collectFromLocation(real, collectionRoot, collectionRootReal, result, errors);
      }

      if (
        errors.length > 0 &&
        result.moved === 0 &&
        result.linked === 0 &&
        result.conflicts.length === 0
      ) {
        throw new Error(errors.join('；'));
      }
      result.notes.push(...errors);
      return result;
    },
    catch: (cause) => toLorraError(cause, 'skills-collect-failed'),
  });
}
