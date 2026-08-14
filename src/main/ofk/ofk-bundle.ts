import type { Dirent } from 'node:fs';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionFact } from '../../shared/facts-schema';
import { parseConceptFrontmatter } from '../../shared/ofk-schema';
import type { LorraError, Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { localDateString } from '../memory/day-summary';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';
import { atomicWrite } from '../pi-sdk-driver/tool-safety/atomic-write';

/**
 * OFK bundle(plan D1):~/.lorra/knowledge/ 下的 markdown 文档层。
 * 布局:
 * index.md 根索引(frontmatter 仅 {okf_version})
 * log.md 变更日志(日期分组,幂等追加)
 * sessions/<ws-slug>/<YYYY>/<YYYY-MM-DD>/<sessionRef>.md
 * days/<ws-slug>/<YYYY-MM-DD>.md 每日摘要(P2 起)
 * references/<slug>.md 博客/转录/仓库抓取(P3 起)
 * projects/<slug>.md 项目概念(P3 起)
 * memory/<entryId>.md 记忆长内容拆分(P5 起)
 *
 * 写入纪律(D4):所有 relPath 拒绝 `..` 段与绝对路径(前缀校验),
 * 失败返回 Err(code: 'ofk-path-invalid');写概念经 atomicWrite(tmp+fsync+rename)。
 */
export const OFK_VERSION = '0.2';

export function ofkBundleRoot(): string {
  return path.join(lorraConfigDir(), 'knowledge');
}

/**
 * 工作区 slug 核心规则(plan D1):pi-sdk 源对 workspace 施加 lorraSessionDir
 * 同款编码(去首 /、\ 后把 / \ : 替换为 -),再剥掉首尾 --;非 pi 源 =
 * workspace basename 经 [^A-Za-z0-9._-]+ → '-' 清洗。slug 只用于目录布局,
 * 概念 frontmatter 的 workspace 仍存真实路径。
 */
export function wsSlugOfWorkspace(workspace: string, collector: string): string {
  if (collector === 'pi-sdk') {
    const encoded = `--${workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const slug = encoded.replace(/^--/, '').replace(/--$/, '');
    return slug || 'unknown';
  }
  const base = path.basename(workspace) || workspace;
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, '-');
  return slug || 'unknown';
}

export function wsSlugOf(fact: SessionFact): string {
  return wsSlugOfWorkspace(fact.workspace, fact.collector);
}

/** Windows 文件名非法字符清洗(防路径注入;sessionRef 本身为 SAFE_ID 字符集)。 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-');
}

/** 会话概念路径:sessions/<ws-slug>/<YYYY>/<YYYY-MM-DD>/<sessionRef>.md;日期取 fact.start 本地日。 */
export function sessionConceptPath(fact: SessionFact): string {
  const date = localDateString(new Date(fact.start));
  return path.join(
    'sessions',
    wsSlugOf(fact),
    date.slice(0, 4),
    date,
    `${safeFileName(fact.sessionRef)}.md`,
  );
}

/** 每日摘要路径:days/<ws-slug>/<YYYY-MM-DD>.md(P2 起)。 */
export function dayConceptPath(wsSlug: string, dateISO: string): string {
  return path.join('days', wsSlug, `${dateISO}.md`);
}

/** 参考资料路径:references/<slug>.md(P3 起)。 */
export function referencePath(slug: string): string {
  return path.join('references', `${safeFileName(slug)}.md`);
}

/** 记忆长内容路径:memory/<entryId>.md(P5 起)。 */
export function memoryDocPath(entryId: string): string {
  return path.join('memory', `${safeFileName(entryId)}.md`);
}

/** ofkRef 指针形态规范化:剥离前导正斜杠段(与 validateRelPath 同口径)。 */
function normalizeRelPath(rel: string): string {
  return rel.replace(/^\/+/, '');
}

function validateRelPath(rel: string): LorraError | null {
  if (typeof rel !== 'string' || rel.length === 0) {
    return { code: 'ofk-path-invalid', message: 'empty bundle path' };
  }
  // 规范化:剥离前导正斜杠(ofkRef 指针契约形态 '/memory/<id>.md' → 'memory/<id>.md')。
  // 只剥正斜杠段——反斜杠绝对路径(如 \x)、盘符(C:\x)、UNC(\\server\share)
  // 不以前导 / 开头,仍走 isAbsolute 拒绝;剥除只会让路径更相对,不引入逃逸。
  const normalized = normalizeRelPath(rel);
  if (path.isAbsolute(normalized)) {
    return { code: 'ofk-path-invalid', message: `absolute path rejected: ${rel}` };
  }
  const segments = normalized.split(/[\\/]+/);
  if (segments.includes('..')) {
    return { code: 'ofk-path-invalid', message: `path traversal rejected: ${rel}` };
  }
  const root = path.resolve(ofkBundleRoot());
  const full = path.resolve(root, normalized);
  if (full === root || !full.startsWith(root + path.sep)) {
    return { code: 'ofk-path-invalid', message: `path escapes bundle root: ${rel}` };
  }
  return null;
}

/** 写入概念:路径校验 → mkdir 父目录 → 原子写。 */
export async function writeConcept(relPath: string, content: string): Promise<Result<void>> {
  const invalid = validateRelPath(relPath);
  if (invalid) return err(invalid);
  const full = path.resolve(ofkBundleRoot(), normalizeRelPath(relPath));
  try {
    await mkdir(path.dirname(full), { recursive: true });
    await atomicWrite(full, content);
    return ok();
  } catch (cause) {
    return err(toLorraError(cause, 'ofk-write-failed'));
  }
}

/** 同步写概念(open 期迁移用):与 writeConcept 同款校验 + tmp+rename。 */
export function writeConceptSync(relPath: string, content: string): Result<void> {
  const invalid = validateRelPath(relPath);
  if (invalid) return err(invalid);
  const full = path.resolve(ofkBundleRoot(), normalizeRelPath(relPath));
  try {
    mkdirSync(path.dirname(full), { recursive: true });
    const tmp = path.join(
      path.dirname(full),
      `.${path.basename(full)}.${process.pid}.${Date.now()}.tmp`,
    );
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, full);
    return ok();
  } catch (cause) {
    return err(toLorraError(cause, 'ofk-write-failed'));
  }
}

/** 读概念:不存在 → Ok(null);路径非法 → Err('ofk-path-invalid')。 */
export async function readConcept(relPath: string): Promise<Result<string | null>> {
  const invalid = validateRelPath(relPath);
  if (invalid) return err(invalid);
  const full = path.resolve(ofkBundleRoot(), normalizeRelPath(relPath));
  try {
    return ok(await readFile(full, 'utf8'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(null);
    return err(toLorraError(cause, 'ofk-read-failed'));
  }
}

/**
 * 追加变更日志(幂等:同文本行已存在则跳过)。log.md 按日期分组:
 * # 变更日志
 * ## 2026-08-13
 * - **Creation**: [title](path)
 */
export async function appendLog(dateISO: string, entry: string): Promise<Result<void>> {
  const read = await readConcept('log.md');
  if (read.isErr()) return read;
  const existing = read.value ?? '';
  const line = `- ${entry}`;
  const lines = existing.length > 0 ? existing.split('\n') : [];
  if (lines.includes(line)) return ok();
  const groupIdx = lines.indexOf(`## ${dateISO}`);
  if (groupIdx >= 0) {
    lines.splice(groupIdx + 1, 0, line);
  } else {
    if (lines.length === 0) {
      lines.push('# 变更日志');
    }
    lines.push('', `## ${dateISO}`, line);
  }
  const content = `${lines.join('\n')}\n`;
  return writeConcept('log.md', content);
}

const SECTION_DIRS: Array<{ dir: string; label: string }> = [
  { dir: 'sessions', label: '会话' },
  { dir: 'days', label: '每日摘要' },
  { dir: 'references', label: '参考资料' },
  { dir: 'projects', label: '项目' },
  { dir: 'memory', label: '记忆' },
];

/** 递归收集一节目录下全部 *.md 的 rel 路径 + frontmatter title/description。 */
async function collectDocs(
  relDir: string,
): Promise<Array<{ rel: string; title: string; description: string }>> {
  const root = path.join(ofkBundleRoot(), relDir);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ rel: string; title: string; description: string }> = [];
  for (const entry of entries) {
    const rel = path.join(relDir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      out.push(...(await collectDocs(rel)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (entry.name === 'index.md' || entry.name === 'log.md') continue;
    let title = path.basename(entry.name, '.md');
    let description = '';
    try {
      const fm = parseConceptFrontmatter(await readFile(path.join(root, entry.name), 'utf8'));
      if (fm && typeof fm.frontmatter.title === 'string' && fm.frontmatter.title) {
        title = fm.frontmatter.title;
      }
      if (fm && typeof fm.frontmatter.description === 'string') {
        description = fm.frontmatter.description;
      }
    } catch {
      // 读/解析失败 → 文件名兜底,不中断索引
    }
    out.push({ rel, title, description });
  }
  return out;
}

/** 重生成根 index.md:按节列出全部文档 title/description。 */
export async function refreshIndex(): Promise<Result<void>> {
  try {
    const sections: string[] = [];
    for (const { dir, label } of SECTION_DIRS) {
      const docs = await collectDocs(dir);
      if (docs.length === 0) continue;
      sections.push(`## ${label}`);
      for (const doc of docs) {
        sections.push(
          `- [${doc.title}](${doc.rel})${doc.description ? ` - ${doc.description}` : ''}`,
        );
      }
    }
    const content =
      sections.length === 0 ? '# 知识库索引\n' : `# 知识库索引\n\n${sections.join('\n')}\n`;
    return writeConcept('index.md', content);
  } catch (cause) {
    return err(toLorraError(cause, 'ofk-index-failed'));
  }
}

/** 列出某本地日全部日摘要 rel 路径(days/<ws-slug>/<dateISO>.md)。 */
export async function listDayDigestFiles(dateISO: string): Promise<Result<string[]>> {
  const daysRoot = path.join(ofkBundleRoot(), 'days');
  const out: string[] = [];
  try {
    let wsDirs: Dirent[];
    try {
      wsDirs = await readdir(daysRoot, { withFileTypes: true });
    } catch {
      return ok([]); // 无摘要目录 → 空
    }
    for (const ws of wsDirs) {
      if (!ws.isDirectory()) continue;
      try {
        await stat(path.join(daysRoot, ws.name, `${dateISO}.md`));
      } catch {
        continue; // 该 ws 当日无摘要
      }
      // 相对 bundle 根路径(含 days/ 前缀,与 readConcept 同口径)
      out.push(path.join('days', ws.name, `${dateISO}.md`).replace(/\\/g, '/'));
    }
    return ok(out);
  } catch (cause) {
    return err(toLorraError(cause, 'ofk-list-failed'));
  }
}

/** 列出某本地日全部会话概念 rel 路径(sessions 下 /<YYYY>/<dateISO>/ 的 *.md)。 */
export async function listDayConceptFiles(dateISO: string): Promise<Result<string[]>> {
  const year = dateISO.slice(0, 4);
  const sessionsRoot = path.join(ofkBundleRoot(), 'sessions');
  const out: string[] = [];
  try {
    let wsDirs: Dirent[];
    try {
      wsDirs = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return ok([]); // bundle 未初始化 → 空
    }
    for (const ws of wsDirs) {
      if (!ws.isDirectory()) continue;
      const dayDir = path.join(sessionsRoot, ws.name, year, dateISO);
      let files: Dirent[];
      try {
        files = await readdir(dayDir, { withFileTypes: true });
      } catch {
        continue; // 该 ws 当日无目录
      }
      for (const f of files) {
        if (f.isFile() && f.name.endsWith('.md')) {
          out.push(path.join('sessions', ws.name, year, dateISO, f.name).replace(/\\/g, '/'));
        }
      }
    }
    return ok(out);
  } catch (cause) {
    return err(toLorraError(cause, 'ofk-list-failed'));
  }
}
