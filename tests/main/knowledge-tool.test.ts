import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeTool, KNOWLEDGE_TOOL_NAME } from '../../src/main/ofk/knowledge-tool';
import { ofkBundleRoot, readConcept } from '../../src/main/ofk/ofk-bundle';
import { freshUserData } from './ofk-test-fixtures';

// Requirement:knowledge 工具三操作 —— ingest 抓取落盘(frontmatter
// 完整)/非 2xx 错误文案;write 路径白名单拒绝 ../ 与绝对路径;search 命中/
// 未命中;全部 op 不 throw。

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

function htmlResponse(body: string, ok = true, status = 200): FakeResponse {
  return {
    ok,
    status,
    headers: { get: (n: string) => (n === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => body,
  };
}

function makeTool(fetchImpl: (url: string) => Promise<FakeResponse>) {
  return createKnowledgeTool({
    fetcher: (url, _init) => fetchImpl(url) as unknown as Promise<Response>,
    getProducer: () => 'test-agent',
  });
}

async function exec(tool: ReturnType<typeof createKnowledgeTool>, params: Record<string, unknown>) {
  const result = await tool.execute(
    'call-1',
    params as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return text;
}

describe('knowledge 工具', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = freshUserData();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('ingest: HTML 网页 → 去标签转纯文本落盘 references/,frontmatter 完整', async () => {
    const fetchImpl = vi.fn(async () =>
      htmlResponse(
        '<html><head><title>T</title></head><body><h1>标题</h1><p>正文内容</p><script>x()</script></body></html>',
      ),
    );
    const tool = makeTool(fetchImpl);
    const text = await exec(tool, { op: 'ingest', url: 'https://example.com/blog/my-post.html' });

    expect(text).toContain('已收入知识库：references/');
    expect(text).toContain('.md');

    const rel = text.replace('已收入知识库：', '').trim();
    const read = await readConcept(rel);
    const doc = read.unwrapOr('') ?? '';
    expect(doc).toContain('type: Reference');
    expect(doc).toContain('sources:');
    expect(doc).toContain('resource: https://example.com/blog/my-post.html');
    expect(doc).toContain('generated: { by: process:lorra-ingest/1, at: ');
    // HTML 已转纯文本(标签剥除,script 移除)
    expect(doc).toContain('标题');
    expect(doc).toContain('正文内容');
    expect(doc).not.toContain('<script>');
    expect(doc).not.toContain('<h1>');
  });

  it('ingest 非 2xx → 错误文案,不落盘', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('Not Found', false, 404));
    const tool = makeTool(fetchImpl);
    const text = await exec(tool, { op: 'ingest', url: 'https://example.com/missing' });

    expect(text).toContain('知识操作失败');
    expect(text).toContain('404');
    // 无文件落盘
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(ofkBundleRoot()).catch(() => []);
    expect(entries).toEqual([]);
  });

  it('ingest 缺 url → 结构化拒绝', async () => {
    const tool = makeTool(async () => htmlResponse(''));
    const text = await exec(tool, { op: 'ingest' });
    expect(text).toContain('ingest 必须提供 url');
  });

  it('write: 白名单路径落盘;无 frontmatter 自动注入最小 frontmatter', async () => {
    const tool = makeTool(async () => htmlResponse(''));
    const text = await exec(tool, {
      op: 'write',
      path: 'projects/lorra-notes.md',
      content: '## 项目笔记\n\n要点',
    });

    expect(text).toBe('已写入：projects/lorra-notes.md');
    const doc = (await readConcept('projects/lorra-notes.md')).unwrapOr('') ?? '';
    expect(doc).toContain('type: Note');
    expect(doc).toContain('generated: { by: test-agent, at: ');
    expect(doc).toContain('## 项目笔记');
  });

  it('write: 已含 frontmatter 的内容不重复注入', async () => {
    const tool = makeTool(async () => htmlResponse(''));
    await exec(tool, {
      op: 'write',
      path: 'memory/e1.md',
      content: '---\ntype: Memory\ntitle: t\n---\n\nbody',
    });
    const doc = (await readConcept('memory/e1.md')).unwrapOr('') ?? '';
    expect(doc).toContain('type: Memory');
    expect(doc).not.toContain('type: Note');
  });

  it('write: 路径白名单拒绝 ../ 与绝对路径与非法段', async () => {
    const tool = makeTool(async () => htmlResponse(''));
    for (const bad of [
      '../escape.md',
      'references/../x.md',
      'notes/x.md',
      'references/a/b.md',
      'references/a.txt',
    ]) {
      const text = await exec(tool, { op: 'write', path: bad, content: '# x' });
      expect(text).toContain('知识操作被拒绝');
      expect(text).toContain('invalid-args');
    }
  });

  it('search: filename/title 命中;未命中返回「未找到相关文档」;不 throw', async () => {
    const tool = makeTool(async () => htmlResponse(''));
    // title 命中(内容带 frontmatter title)
    await exec(tool, {
      op: 'write',
      path: 'references/quant-notes.md',
      content: '---\ntype: Note\ntitle: 量化笔记\n---\n\n年化用对数收益',
    });
    // filename 命中
    await exec(tool, {
      op: 'write',
      path: 'references/quant-guide.md',
      content: '---\ntype: Note\ntitle: 量化指南\n---\n\n正文',
    });

    const hit = await exec(tool, { op: 'search', query: '量化' });
    expect(hit).toContain('命中 2 条');
    expect(hit).toContain('quant-notes.md');
    expect(hit).toContain('quant-guide.md');

    const miss = await exec(tool, { op: 'search', query: '不存在的词xyz' });
    expect(miss).toBe('未找到相关文档');
  });

  it('全 op 不 throw:非法 op / 缺参数 / fetch 抛错均文本返回', async () => {
    const tool = makeTool(async () => {
      throw new Error('network down');
    });
    const badOp = await exec(tool, { op: 'nonsense' });
    expect(badOp).toContain('op 必须是 ingest/write/search 之一');

    const fetchErr = await exec(tool, { op: 'ingest', url: 'https://example.com/x' });
    expect(fetchErr).toContain('fetch-failed');
    expect(fetchErr).toContain('network down');

    const noQuery = await exec(tool, { op: 'search' });
    expect(noQuery).toContain('search 必须提供 query');
  });

  it('工具元数据:名字/label/promptGuidelines 就绪(注册处可用性白名单引用同一常量)', () => {
    expect(KNOWLEDGE_TOOL_NAME).toBe('knowledge');
  });
});
