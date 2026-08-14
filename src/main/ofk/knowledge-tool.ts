import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { parseConceptFrontmatter, yamlQuote } from '../../shared/ofk-schema';
import type { McpFetchLike } from '../pi-sdk-driver/web-tools';
import { ofkBundleRoot, referencePath, writeConcept } from './ofk-bundle';

/**
 * knowledge 工具:OFK 知识摄入的 agent 侧入口。
 * 单工具三操作:
 * - ingest {url}:抓取网页 → 转纯文本 → 写 references/<slug>.md(frontmatter
 * {type: Reference, title, description, sources, generated})
 * - write {path, content}:写入白名单路径(references|projects|memory),无
 * frontmatter 则注入最小 frontmatter;防目录穿越(正则白名单)
 * - search {query}:确定性扫描全 bundle(跳过 index/log),filename 或
 * frontmatter title/description 大小写不敏感包含 query → 前 20 条
 *
 * 工具侧一律文本返回、不抛异常(仿 propose-memory-tool 全部纪律)。
 */

export const KNOWLEDGE_TOOL_NAME = 'knowledge';

/** 工具定义类型:消费者(测试/注册处)引用命名类型而非 ReturnType。 */
export type KnowledgeTool = ToolDefinition<typeof knowledgeToolSchema>;

/** write 路径白名单:references|projects|memory 下普通文件名(防目录穿越)。 */
const WRITE_PATH_PATTERN = /^(references|projects|memory)\/[A-Za-z0-9._-]+\.md$/;

/** ingest 正文截断上限(≤100KB)。 */
const INGEST_BODY_MAX_CHARS = 100 * 1024;

/** search 命中条数上限。 */
const SEARCH_LIMIT = 20;

/** slug:URL pathname basename 清洗 + 日期前缀 YYYY-MM-DD-。 */
function slugFromUrl(url: string): string {
  let base = '';
  try {
    const u = new URL(url);
    base = (u.pathname.split('/').filter(Boolean).pop() ?? '')
      .replace(/\.(html?|md|txt|json)$/i, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .slice(0, 60);
  } catch {
    base = '';
  }
  if (!base) base = 'page';
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${base}`;
}

/** content-type 含 html → 去标签转纯文本(剥 script/style/tag,空白折叠);否则原文。 */
function htmlToText(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 最小注入 frontmatter(无 frontmatter 的 write 内容)。 */
function withMinimalFrontmatter(content: string, producer: string): string {
  const now = new Date().toISOString();
  const header = [
    '---',
    'type: Note',
    `generated: { by: ${yamlQuote(producer)}, at: ${now} }`,
    '---',
    '',
  ].join('\n');
  return `${header}${content}`;
}

/** 文件系统扫描(全 bundle *.md,跳过 index/log):filename/title/description 命中。 */
async function searchBundle(query: string): Promise<string[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: string[] = [];

  async function walk(relDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(ofkBundleRoot(), relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(relDir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await walk(rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name === 'index.md' || entry.name === 'log.md') continue;
      const full = path.join(ofkBundleRoot(), relDir, entry.name);
      let content: string;
      try {
        content = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const fm = parseConceptFrontmatter(content);
      const title = fm && typeof fm.frontmatter.title === 'string' ? fm.frontmatter.title : '';
      const description =
        fm && typeof fm.frontmatter.description === 'string' ? fm.frontmatter.description : '';
      const haystack = `${entry.name} ${title} ${description}`.toLowerCase();
      if (haystack.includes(q)) {
        hits.push(`[${title || path.basename(entry.name, '.md')}](${rel})`);
        if (hits.length >= SEARCH_LIMIT) return;
      }
    }
  }

  await walk('');
  return hits;
}

export function createKnowledgeTool(deps: {
  /** Chromium 网络栈 fetch(net.fetch);测试注入 fake。 */
  fetcher: McpFetchLike;
  /** 调用方 agent 名(最小 frontmatter generated.by 缺省)。 */
  getProducer?: () => string;
}): KnowledgeTool {
  return {
    name: KNOWLEDGE_TOOL_NAME,
    label: '知识摄入',
    description:
      '知识库工具（knowledge）：ingest 抓取网页收入知识库 / write 写入结构化文档 / search 检索知识库文档。',
    promptSnippet:
      '知识摄入（knowledge）：用户分享的博客/文章/仓库 → ingest 收入知识库; 需要沉淀的结构化内容 → write; 引用前可 search',
    promptGuidelines: [
      'ingest: 用户明示要摄入的链接(博客/文章/代码仓库)才抓取; 不要自动抓取未要求的内容',
      'write: 结构化 markdown 优先(标题/小节/列表), 路径限 references|projects|memory 下',
      'search: 引用知识库内容前先 search 确认是否存在; 命中后按 [title](path) 引用',
      '长内容(>1024 字节)优先写 knowledge 工具存 OFK 文档, memory 只记摘要 + ofkRef 指针',
    ],
    parameters: knowledgeToolSchema,
    executionMode: 'parallel',
    async execute(_toolCallId, params) {
      const raw = params as unknown as Record<string, unknown>;
      const op = raw.op;
      if (op === 'ingest') return runIngest(deps, raw);
      if (op === 'write') return runWrite(deps, raw);
      if (op === 'search') return runSearch(raw);
      return toolText(`知识操作被拒绝（invalid-args）：op 必须是 ingest/write/search 之一`);
    },
  };
}

const knowledgeToolSchema = Type.Object({
  op: Type.Union([Type.Literal('ingest'), Type.Literal('write'), Type.Literal('search')]),
  // ---- ingest ----
  url: Type.Optional(Type.String({ minLength: 1 })),
  // ---- write ----
  path: Type.Optional(Type.String({ minLength: 1 })),
  content: Type.Optional(Type.String({ minLength: 1 })),
  // ---- search ----
  query: Type.Optional(Type.String()),
});

async function runIngest(
  deps: { fetcher: McpFetchLike },
  raw: Record<string, unknown>,
): Promise<ReturnType<typeof toolText>> {
  if (typeof raw.url !== 'string' || raw.url.trim() === '') {
    return toolText(`知识操作被拒绝（invalid-args）：ingest 必须提供 url`);
  }
  const url = raw.url.trim();
  let response: Response;
  try {
    response = await deps.fetcher(url);
  } catch (cause) {
    return toolText(
      `知识操作失败（fetch-failed）：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    return toolText(
      `知识操作失败（fetch-http-${response.status}）：抓取 ${url} 返回 ${response.status}`,
    );
  }
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    return toolText(
      `知识操作失败（fetch-body）：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  const text = contentType.includes('html') ? htmlToText(body) : body.trim();
  const truncated =
    text.length > INGEST_BODY_MAX_CHARS ? `${text.slice(0, INGEST_BODY_MAX_CHARS)}…` : text;

  const slug = slugFromUrl(url);
  const rel = referencePath(slug);
  const firstLine =
    truncated
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim()
      .slice(0, 120) ?? '';
  const now = new Date().toISOString();
  const doc = [
    '---',
    'type: Reference',
    `title: ${yamlQuote(slug)}`,
    `description: ${yamlQuote(firstLine)}`,
    'sources:',
    `  - id: url`,
    `    resource: ${yamlQuote(url)}`,
    `generated: { by: process:lorra-ingest/1, at: ${now} }`,
    '---',
    '',
    truncated,
  ].join('\n');
  const written = await writeConcept(rel, doc);
  if (written.isErr()) {
    return toolText(`知识操作失败（${written.error.code}）：${written.error.message}`);
  }
  return toolText(`已收入知识库：${rel.replace(/\\/g, '/')}`);
}

async function runWrite(
  deps: { getProducer?: () => string },
  raw: Record<string, unknown>,
): Promise<ReturnType<typeof toolText>> {
  if (typeof raw.path !== 'string' || !WRITE_PATH_PATTERN.test(raw.path)) {
    return toolText(
      `知识操作被拒绝（invalid-args）：path 必须是 references|projects|memory 下的 *.md（如 references/my-note.md）`,
    );
  }
  if (typeof raw.content !== 'string' || raw.content.trim() === '') {
    return toolText(`知识操作被拒绝（invalid-args）：write 必须提供 content`);
  }
  const content = raw.content.includes('---\n')
    ? raw.content
    : withMinimalFrontmatter(raw.content, deps.getProducer?.() ?? 'agent');
  const written = await writeConcept(raw.path, content);
  if (written.isErr()) {
    return toolText(`知识操作失败（${written.error.code}）：${written.error.message}`);
  }
  return toolText(`已写入：${raw.path}`);
}

async function runSearch(raw: Record<string, unknown>): Promise<ReturnType<typeof toolText>> {
  if (typeof raw.query !== 'string') {
    return toolText(`知识操作被拒绝（invalid-args）：search 必须提供 query`);
  }
  const hits = await searchBundle(raw.query);
  if (hits.length === 0) return toolText('未找到相关文档');
  return toolText(`命中 ${hits.length} 条：\n${hits.join('\n')}`);
}

function toolText(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: {},
  };
}
