import { describe, expect, it } from 'vitest';
import { ExaMcpClient } from '../../src/main/pi-sdk-driver/web-tools/exa-mcp-client';

/**
 * Mock fetcher helpers. MCP streamable HTTP responses come back as
 * `text/event-stream` with `event: message` + `data: <json>` lines; the
 * server MAY also answer with plain `application/json`. Both must parse.
 */

function sseResponse(body: string, init: { status?: number; sessionId?: string } = {}): Response {
  const headers: Record<string, string> = { 'Content-Type': 'text/event-stream' };
  if (init.sessionId) headers['mcp-session-id'] = init.sessionId;
  return new Response(body, { status: init.status ?? 200, headers });
}

function dataLine(json: unknown): string {
  return `event: message\ndata: ${JSON.stringify(json)}\n\n`;
}

/** Build a fake `fetch` that records every request and answers from a queue. */
function makeFetcher(
  handler: (
    url: string,
    init: RequestInit,
    calls: Array<{ url: string; init: RequestInit }>,
  ) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(String(url), init ?? {}, calls);
  };
  return { fetcher, calls };
}

/** Default handler: answer initialize with a session id, then tools/call with a text result. */
function defaultHandler(): (_url: string, init: RequestInit) => Response {
  let initialized = false;
  return (_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.method === 'initialize') {
      initialized = true;
      return sseResponse(
        dataLine({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'exa-test' },
          },
        }),
        { sessionId: 'sess-1' },
      );
    }
    if (body.method === 'tools/call') {
      void initialized;
      return sseResponse(
        dataLine({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [
              { type: 'text', text: `result-for:${JSON.stringify(body.params.arguments)}` },
            ],
          },
        }),
      );
    }
    return sseResponse(
      dataLine({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: `unknown method ${body.method}` },
      }),
    );
  };
}

describe('ExaMcpClient', () => {
  it('initializes once, then reuses the session for subsequent tool calls', async () => {
    const { fetcher, calls } = makeFetcher(defaultHandler());
    const client = new ExaMcpClient({ fetcher });

    const first = await client.callTool('web_search_exa', { query: 'a' });
    const second = await client.callTool('web_search_exa', { query: 'b' });

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const methods = calls.map((c) => JSON.parse(String(c.init.body)).method);
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'tools/call',
    ]);
    const initCall = JSON.parse(String(calls[0].init.body));
    expect(initCall.params).toMatchObject({
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'lorra' },
    });
  });

  it('sends the MCP session id header on tool calls after initialize', async () => {
    const { fetcher, calls } = makeFetcher(defaultHandler());
    const client = new ExaMcpClient({ fetcher });

    await client.callTool('web_search_exa', { query: 'a' });

    const toolCall = calls.find((c) => JSON.parse(String(c.init.body)).method === 'tools/call');
    expect(toolCall).toBeDefined();
    const headers = (toolCall?.init.headers ?? {}) as Record<string, string>;
    expect(headers['mcp-session-id']).toBe('sess-1');
  });

  it('passes tool name and arguments through to the MCP server', async () => {
    const { fetcher, calls } = makeFetcher(defaultHandler());
    const client = new ExaMcpClient({ fetcher });

    await client.callTool('web_search_exa', { query: 'hello', numResults: 3 });

    const toolCall = calls.find((c) => JSON.parse(String(c.init.body)).method === 'tools/call');
    const body = JSON.parse(String(toolCall?.init.body));
    expect(body.params).toEqual({
      name: 'web_search_exa',
      arguments: { query: 'hello', numResults: 3 },
    });
  });

  it('returns the text content of the tool result', async () => {
    const { fetcher } = makeFetcher(defaultHandler());
    const client = new ExaMcpClient({ fetcher });

    const res = await client.callTool('web_search_exa', { query: 'hello' });
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toBe('result-for:{"query":"hello"}');
  });

  it('parses plain JSON responses (server may answer non-SSE)', async () => {
    const handler = (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'exa-test' },
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'sess-j' },
          },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'plain-json-ok' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new ExaMcpClient({ fetcher: handler as unknown as typeof fetch });

    const res = await client.callTool('web_search_exa', { query: 'a' });
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toBe('plain-json-ok');
  });

  it('joins multiple data chunks of one SSE response', async () => {
    const handler = (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'initialize') {
        return sseResponse(
          dataLine({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'exa-test' },
            },
          }),
          { sessionId: 'sess-c' },
        );
      }
      const partial = {
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'chunked' }] },
      };
      const full = JSON.stringify(partial);
      // Split the JSON string across two data events.
      const cut = Math.floor(full.length / 2);
      return sseResponse(
        `event: message\ndata: ${full.slice(0, cut)}\n\nevent: message\ndata: ${full.slice(cut)}\n\n`,
      );
    };
    const client = new ExaMcpClient({ fetcher: handler as unknown as typeof fetch });

    const res = await client.callTool('web_search_exa', { query: 'a' });
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toBe('chunked');
  });

  it('maps a JSON-RPC error response to a Result error', async () => {
    const handler = (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'initialize') {
        return sseResponse(
          dataLine({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'exa-test' },
            },
          }),
          { sessionId: 'sess-e' },
        );
      }
      return sseResponse(
        dataLine({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: 'invalid params' },
        }),
      );
    };
    const client = new ExaMcpClient({ fetcher: handler as unknown as typeof fetch });

    const res = await client.callTool('web_search_exa', { query: 'a' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('exa-mcp-error');
      expect(res.error.message).toContain('invalid params');
    }
  });

  it('errors on non-2xx HTTP responses', async () => {
    const { fetcher } = makeFetcher(() => sseResponse('', { status: 500 }));
    const client = new ExaMcpClient({ fetcher });

    const res = await client.callTool('web_search_exa', { query: 'a' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('exa-mcp-error');
  });

  it('errors on network failure with a stable code', async () => {
    const { fetcher } = makeFetcher(() => {
      throw new TypeError('fetch failed');
    });
    const client = new ExaMcpClient({ fetcher });

    const res = await client.callTool('web_search_exa', { query: 'a' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('exa-network');
  });

  it('aborts the request after the configured timeout', async () => {
    let aborted = false;
    const handler = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
        // Never resolve on its own; the abort must cut it short.
      });
    const client = new ExaMcpClient({ fetcher: handler as unknown as typeof fetch, timeoutMs: 50 });

    const res = await client.callTool('web_search_exa', { query: 'a' });
    expect(aborted).toBe(true);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('exa-timeout');
  });

  it('re-initializes and retries once when the session is stale (404 on tool call)', async () => {
    let initializeCount = 0;
    const handler = (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'initialize') {
        initializeCount += 1;
        return sseResponse(
          dataLine({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'exa-test' },
            },
          }),
          { sessionId: `sess-${initializeCount}` },
        );
      }
      if (body.method === 'tools/call') {
        if (initializeCount === 1) return sseResponse('', { status: 404 });
        return sseResponse(
          dataLine({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: 'retry-ok' }] },
          }),
        );
      }
      return sseResponse(
        dataLine({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }),
      );
    };
    const client = new ExaMcpClient({ fetcher: handler as unknown as typeof fetch });

    // The first call hits a stale cached session, re-initializes once, and succeeds.
    const warm = await client.callTool('web_search_exa', { query: 'warm' });
    expect(warm.isOk()).toBe(true);
    expect(initializeCount).toBe(2);
    // The second call reuses the fresh session — no additional initialize.
    const res = await client.callTool('web_search_exa', { query: 'retry' });
    expect(res.isOk()).toBe(true);
    expect(initializeCount).toBe(2);
    if (res.isOk()) expect(res.value).toBe('retry-ok');
  });

  it('does not retry twice — a second stale session surfaces the error', async () => {
    const handler = (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'initialize') {
        return sseResponse(
          dataLine({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'exa-test' },
            },
          }),
          { sessionId: 'sess-x' },
        );
      }
      return sseResponse('', { status: 404 });
    };
    const client = new ExaMcpClient({ fetcher: handler as unknown as typeof fetch });

    const res = await client.callTool('web_search_exa', { query: 'a' });
    expect(res.isErr()).toBe(true);
  });

  it('errors when the result has no text content', async () => {
    const handler = (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'initialize') {
        return sseResponse(
          dataLine({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'exa-test' },
            },
          }),
          { sessionId: 'sess-n' },
        );
      }
      return sseResponse(dataLine({ jsonrpc: '2.0', id: body.id, result: { content: [] } }));
    };
    const client = new ExaMcpClient({ fetcher: handler as unknown as typeof fetch });

    const res = await client.callTool('web_search_exa', { query: 'a' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('exa-mcp-error');
  });
});
