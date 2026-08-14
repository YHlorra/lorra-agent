import { describe, expect, it } from 'vitest';
import { AnySearchClient } from '../../src/main/pi-sdk-driver/web-tools/anysearch-client';
import type { Result } from '../../src/shared/result';

/**
 * AnySearch 备用客户端契约(Exa 额度耗尽/故障时的搜索兜底):
 * 直接 HTTP JSON-RPC 调 api.anysearch.com/mcp(免 key 匿名,实测可用):
 * POST {"jsonrpc":"2.0","id":1,"method":"tools/call",
 * "params":{"name":"search|extract","arguments":{...}}}
 * 成功响应为纯 JSON:result.content[].text(可多块,拼接返回);
 * error 字段 → err anysearch-error;HTTP 非 200 → err;超时 → anysearch-timeout;
 * 网络异常 → err anysearch-network。与 ExaMcpClient 同形状(Result<string>),
 * 便于 web-tools 做降级链。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetcher(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(String(url), init ?? {});
  };
  return { fetcher, calls };
}

function expectErr(res: Result<string>): { code: string; message: string } {
  expect(res.isErr()).toBe(true);
  return res.match({
    ok: () => {
      throw new Error('expected Err, got Ok');
    },
    err: (e) => e,
  });
}

describe('AnySearchClient', () => {
  it('POST JSON-RPC tools/call 到端点并返回 content 文本(多块拼接)', async () => {
    const { fetcher, calls } = makeFetcher(() =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            { type: 'text', text: '## Search Results' },
            { type: 'text', text: '### 1. Result A' },
          ],
        },
      }),
    );
    const client = new AnySearchClient({ fetcher });
    const res = await client.callTool('search', { query: 'rust', max_results: 3 });

    expect(res.isOk()).toBe(true);
    expect(res.match({ ok: (v) => v, err: () => '' })).toBe('## Search Results### 1. Result A');
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'rust', max_results: 3 } },
    });
    expect(calls[0]!.url).toContain('api.anysearch.com/mcp');
  });

  it('JSON-RPC error → err anysearch-error(带服务端 message)', async () => {
    const { fetcher } = makeFetcher(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } }),
    );
    const client = new AnySearchClient({ fetcher });
    const errRes = expectErr(await client.callTool('search', { query: 'x' }));
    expect(errRes.code).toBe('anysearch-error');
    expect(errRes.message).toContain('rate limited');
  });

  it('HTTP 非 200 → err anysearch-error(带状态码)', async () => {
    const { fetcher } = makeFetcher(() => jsonResponse({}, 503));
    const client = new AnySearchClient({ fetcher });
    const errRes = expectErr(await client.callTool('search', { query: 'x' }));
    expect(errRes.code).toBe('anysearch-error');
    expect(errRes.message).toContain('503');
  });

  it('响应无 content 文本 → err anysearch-error', async () => {
    const { fetcher } = makeFetcher(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const client = new AnySearchClient({ fetcher });
    const errRes = expectErr(await client.callTool('search', { query: 'x' }));
    expect(errRes.code).toBe('anysearch-error');
  });

  it('fetch 抛网络异常 → err anysearch-network', async () => {
    const { fetcher } = makeFetcher(() => {
      throw new Error('ECONNRESET');
    });
    const client = new AnySearchClient({ fetcher });
    const errRes = expectErr(await client.callTool('search', { query: 'x' }));
    expect(errRes.code).toBe('anysearch-network');
    expect(errRes.message).toContain('ECONNRESET');
  });

  it('超时(端点不响应)→ err anysearch-timeout', async () => {
    const { fetcher } = makeFetcher(() => new Promise<Response>(() => {}));
    const client = new AnySearchClient({ fetcher, timeoutMs: 50 });
    const errRes = expectErr(await client.callTool('search', { query: 'x' }));
    expect(errRes.code).toBe('anysearch-timeout');
  });

  it('外部 AbortSignal 中断 → err anysearch-network(含 abort 信息)', async () => {
    const { fetcher } = makeFetcher(() => new Promise<Response>(() => {}));
    const client = new AnySearchClient({ fetcher, timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = client.callTool('search', { query: 'x' }, controller.signal);
    controller.abort();
    const errRes = expectErr(await pending);
    expect(['anysearch-network', 'anysearch-timeout']).toContain(errRes.code);
  });

  it('容错 SSE 风格响应(data: 前缀)', async () => {
    const { fetcher } = makeFetcher(
      () =>
        new Response(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: 'sse-wrapped' }] },
          })}\n\n`,
          { status: 200 },
        ),
    );
    const client = new AnySearchClient({ fetcher });
    const res = await client.callTool('search', { query: 'x' });
    expect(res.isOk()).toBe(true);
    expect(res.match({ ok: (v) => v, err: () => '' })).toBe('sse-wrapped');
  });

  it('自定义端点生效(测试注入)', async () => {
    const { fetcher, calls } = makeFetcher(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }),
    );
    const client = new AnySearchClient({ fetcher, endpoint: 'https://example.test/mcp' });
    await client.callTool('search', { query: 'x' });
    expect(calls[0]!.url).toBe('https://example.test/mcp');
  });
});
