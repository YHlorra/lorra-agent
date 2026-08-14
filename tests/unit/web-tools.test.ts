import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  createWebTools,
  MAX_RESULT_CHARS,
  type WebToolClient,
} from '../../src/main/pi-sdk-driver/web-tools/web-tools';
import { err, ok, type Result } from '../../src/shared/result';

/** Minimal client double: records calls, answers from the queue. */
function makeClient(handler: (name: string, args: Record<string, unknown>) => Result<string>): {
  client: WebToolClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return handler(name, args);
    },
  };
  return { client, calls };
}

function tools(): ToolDefinition[] {
  const { client } = makeClient(() => ok('plain result'));
  return createWebTools({ client });
}

function findTool(defs: ToolDefinition[], name: string): ToolDefinition {
  const tool = defs.find((d) => d.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe('createWebTools', () => {
  it('registers update_plan, web_search and web_fetch', () => {
    const defs = tools();
    expect(defs.map((d) => d.name).sort()).toEqual(['update_plan', 'web_fetch', 'web_search']);
  });

  describe('web_search', () => {
    it('requires a non-empty query in the parameter schema', () => {
      const schema = findTool(tools(), 'web_search').parameters as { required?: unknown[] };
      expect(schema.required).toContain('query');
    });

    it('passes query and numResults through to the Exa MCP tool', async () => {
      const { client, calls } = makeClient(() => ok('r'));
      const tool = findTool(createWebTools({ client }), 'web_search');
      await tool.execute(
        'call-1',
        { query: '大模型', numResults: 3 },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls).toEqual([{ name: 'web_search_exa', args: { query: '大模型', numResults: 3 } }]);
    });

    it('defaults numResults to 5 when omitted', async () => {
      const { client, calls } = makeClient(() => ok('r'));
      const tool = findTool(createWebTools({ client }), 'web_search');
      await tool.execute('call-1', { query: 'x' }, undefined, undefined, {} as never);

      expect(calls[0]?.args.numResults).toBe(5);
    });

    it('clamps numResults above the upper bound to 10', async () => {
      const { client, calls } = makeClient(() => ok('r'));
      const tool = findTool(createWebTools({ client }), 'web_search');
      await tool.execute(
        'call-1',
        { query: 'x', numResults: 99 },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls[0]?.args.numResults).toBe(10);
    });

    it('defaults numResults to 10 when depth=thorough and numResults omitted', async () => {
      const { client, calls } = makeClient(() => ok('r'));
      const tool = findTool(createWebTools({ client }), 'web_search');
      await tool.execute(
        'call-1',
        { query: 'x', depth: 'thorough' },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls[0]?.args.numResults).toBe(10);
    });

    it('honours an explicit numResults over the depth default', async () => {
      const { client, calls } = makeClient(() => ok('r'));
      const tool = findTool(createWebTools({ client }), 'web_search');
      await tool.execute(
        'call-1',
        { query: 'x', depth: 'thorough', numResults: 3 },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls[0]?.args.numResults).toBe(3);
    });

    it('does not forward depth to the Exa MCP tool', async () => {
      const { client, calls } = makeClient(() => ok('r'));
      const tool = findTool(createWebTools({ client }), 'web_search');
      await tool.execute(
        'call-1',
        { query: 'x', depth: 'thorough' },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls[0]?.args.depth).toBeUndefined();
    });

    it('carries depth orchestration guidelines for the LLM', () => {
      const tool = findTool(tools(), 'web_search');
      const guidelines = tool.promptGuidelines ?? [];
      expect(guidelines.join('\n')).toContain('depth=thorough');
      expect(guidelines.join('\n')).toContain('web_fetch');
    });

    it('returns the search text as tool content', async () => {
      const { client } = makeClient(() => ok('Title: t\nURL: u'));
      const tool = findTool(createWebTools({ client }), 'web_search');
      const result = await tool.execute(
        'call-1',
        { query: 'x' },
        undefined,
        undefined,
        {} as never,
      );

      expect(result.content).toEqual([{ type: 'text', text: 'Title: t\nURL: u' }]);
    });

    it('truncates oversized results and marks the cut', async () => {
      const longText = 'a'.repeat(MAX_RESULT_CHARS + 5000);
      const { client } = makeClient(() => ok(longText));
      const tool = findTool(createWebTools({ client }), 'web_search');
      const result = await tool.execute(
        'call-1',
        { query: 'x' },
        undefined,
        undefined,
        {} as never,
      );

      const first = result.content[0];
      const text = first?.type === 'text' ? first.text : '';
      expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 100);
      expect(text).toContain('截断');
    });

    it('rejects with a readable error when the MCP call fails', async () => {
      const { client } = makeClient(() => err({ code: 'exa-network', message: 'fetch failed' }));
      const tool = findTool(createWebTools({ client }), 'web_search');

      await expect(
        tool.execute('call-1', { query: 'x' }, undefined, undefined, {} as never),
      ).rejects.toThrow('fetch failed');
    });

    it('carries a prompt snippet so the LLM learns when to use it', () => {
      const tool = findTool(tools(), 'web_search');
      expect(tool.promptSnippet).toBeTruthy();
      expect(tool.description).toContain('搜索');
    });
  });

  describe('web_fetch', () => {
    it('requires a urls array', () => {
      const schema = findTool(tools(), 'web_fetch').parameters as { required?: unknown[] };
      expect(schema.required).toContain('urls');
    });

    it('passes urls and default maxCharacters through', async () => {
      const { client, calls } = makeClient(() => ok('page text'));
      const defs = createWebTools({ client });
      const tool = findTool(defs, 'web_fetch');
      await tool.execute(
        'call-1',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls).toEqual([
        { name: 'web_fetch_exa', args: { urls: ['https://example.com'], maxCharacters: 3000 } },
      ]);
    });

    it('honours an explicit maxCharacters value', async () => {
      const { client, calls } = makeClient(() => ok('page text'));
      const defs = createWebTools({ client });
      const tool = findTool(defs, 'web_fetch');
      await tool.execute(
        'call-1',
        { urls: ['https://example.com'], maxCharacters: 8000 },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls[0]?.args.maxCharacters).toBe(8000);
    });

    it('caps the urls batch at 5', async () => {
      const { client, calls } = makeClient(() => ok('page text'));
      const defs = createWebTools({ client });
      const tool = findTool(defs, 'web_fetch');
      const many = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`);
      await tool.execute('call-1', { urls: many }, undefined, undefined, {} as never);

      expect(calls[0]?.args.urls).toHaveLength(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Exa → AnySearch 降级链(2026-08-09,备用后端):Exa 免费额度耗尽/故障时,
  // web_search 落到 AnySearch `search`、web_fetch 落到 `extract`(逐 URL)。
  // 备用结果前附来源标注行(agent 可见);主备都失败 → 报主错误并附备用失败。
  // ---------------------------------------------------------------------------

  describe('备用后端降级链(backupClient)', () => {
    it('web_search: Exa Err → 备用 search 被调,结果带降级标注', async () => {
      const { client: primary } = makeClient(() =>
        err({ code: 'exa-mcp-error', message: 'quota exhausted' }),
      );
      const { client: backup, calls } = makeClient(() => ok('## Search Results\n### 1. X'));
      const tool = findTool(
        createWebTools({ client: primary, backupClient: backup }),
        'web_search',
      );

      const result = await tool.execute(
        'call-1',
        { query: '大模型', numResults: 3 },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls).toEqual([{ name: 'search', args: { query: '大模型', max_results: 3 } }]);
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('备用后端 AnySearch');
      expect(text).toContain('## Search Results');
    });

    it('web_search: Exa 成功 → 备用不被调', async () => {
      const { client: primary, calls: primaryCalls } = makeClient(() => ok('exa result'));
      const { client: backup, calls: backupCalls } = makeClient(() => ok('backup result'));
      const tool = findTool(
        createWebTools({ client: primary, backupClient: backup }),
        'web_search',
      );

      const result = await tool.execute(
        'call-1',
        { query: 'x' },
        undefined,
        undefined,
        {} as never,
      );

      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toBe('exa result');
      expect(text).not.toContain('AnySearch');
      expect(backupCalls).toEqual([]);
      expect(primaryCalls[0]?.name).toBe('web_search_exa');
    });

    it('web_search: 主备都失败 → 报主错误并附备用失败信息', async () => {
      const { client: primary } = makeClient(() =>
        err({ code: 'exa-network', message: 'fetch failed' }),
      );
      const { client: backup } = makeClient(() =>
        err({ code: 'anysearch-error', message: 'HTTP 503' }),
      );
      const tool = findTool(
        createWebTools({ client: primary, backupClient: backup }),
        'web_search',
      );

      await expect(
        tool.execute('call-1', { query: 'x' }, undefined, undefined, {} as never),
      ).rejects.toThrow(/fetch failed.*AnySearch 也不可用：HTTP 503/);
    });

    it('web_fetch: Exa Err → 备用 extract 逐 URL 抓取并拼接', async () => {
      const { client: primary } = makeClient(() =>
        err({ code: 'exa-mcp-error', message: 'quota exhausted' }),
      );
      const { client: backup, calls } = makeClient((_name, args) => ok(`page:${args.url}`));
      const tool = findTool(createWebTools({ client: primary, backupClient: backup }), 'web_fetch');

      const result = await tool.execute(
        'call-1',
        { urls: ['https://a.com', 'https://b.com'] },
        undefined,
        undefined,
        {} as never,
      );

      expect(calls.map((c) => c.name)).toEqual(['extract', 'extract']);
      expect(calls[0]?.args).toEqual({ url: 'https://a.com' });
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('备用后端 AnySearch');
      expect(text).toContain('page:https://a.com');
      expect(text).toContain('page:https://b.com');
    });

    it('web_fetch: 备用逐条失败 → 成功条保留,失败条标注', async () => {
      const { client: primary } = makeClient(() =>
        err({ code: 'exa-mcp-error', message: 'quota exhausted' }),
      );
      const { client: backup } = makeClient((_name, args) =>
        args.url === 'https://bad.com'
          ? err({ code: 'anysearch-error', message: 'down' })
          : ok('good page'),
      );
      const tool = findTool(createWebTools({ client: primary, backupClient: backup }), 'web_fetch');

      const result = await tool.execute(
        'call-1',
        { urls: ['https://ok.com', 'https://bad.com'] },
        undefined,
        undefined,
        {} as never,
      );

      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('good page');
      expect(text).toContain('[读取失败] https://bad.com: down');
    });

    it('web_fetch: 备用全部失败 → 报主错误并附备用失败', async () => {
      const { client: primary } = makeClient(() =>
        err({ code: 'exa-mcp-error', message: 'quota exhausted' }),
      );
      const { client: backup } = makeClient(() =>
        err({ code: 'anysearch-error', message: 'down' }),
      );
      const tool = findTool(createWebTools({ client: primary, backupClient: backup }), 'web_fetch');

      await expect(
        tool.execute('call-1', { urls: ['https://a.com'] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/quota exhausted.*AnySearch 也不可用：down/);
    });

    it('未配置备用 → 行为与以前一致(主失败即报错)', async () => {
      const { client } = makeClient(() => err({ code: 'exa-network', message: 'fetch failed' }));
      const tool = findTool(createWebTools({ client }), 'web_search');

      await expect(
        tool.execute('call-1', { query: 'x' }, undefined, undefined, {} as never),
      ).rejects.toThrow('fetch failed');
    });
  });
});
