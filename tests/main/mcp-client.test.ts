import { describe, expect, it } from 'vitest';
import {
  createMcpClient,
  expandPlaceholders,
  HttpMcpClient,
  parseMcpJson,
} from '../../src/main/mcp/mcp-client';

// plan S3: 占位符展开 / 工厂 type 判别 / http(fetch mock) / stdio(真实 node 子进程)。

const MCP_SERVER_SCRIPT = [
  "const readline = require('node:readline');",
  'const rl = readline.createInterface({ input: process.stdin });',
  "rl.on('line', (line) => {",
  '  const msg = JSON.parse(line);',
  "  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + String.fromCharCode(10));",
  "  if (msg.method === 'initialize') reply({ protocolVersion: '2025-03-26', capabilities: {} });",
  "  else if (msg.method === 'tools/list') reply({ tools: [{ name: 'greet', description: 'greets', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }] });",
  "  else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: 'hi ' + msg.params.arguments.who }] });",
  '});',
].join('\n');

describe('mcp-client', () => {
  it('expandPlaceholders 展开 PLUGIN_ROOT/PLUGIN_DATA', () => {
    expect(expandPlaceholders('${PLUGIN_ROOT}/a', '/r', '/d')).toBe('/r/a');
    expect(expandPlaceholders('${PLUGIN_DATA}/b', '/r', '/d')).toBe('/d/b');
  });

  it('createMcpClient factory：sse → err，stdio/streamable-http → ok', () => {
    expect(createMcpClient({ type: 'sse', url: 'https://x/sse' }, '/r').isErr()).toBe(true);
    expect(createMcpClient({ type: 'stdio', command: 'node' }, '/r').isOk()).toBe(true);
    expect(createMcpClient({ type: 'streamable-http', url: 'https://x/mcp' }, '/r').isOk()).toBe(
      true,
    );
  });

  it('stdio 真实子进程：start 拉 tools/list + callTool 走 tools/call', async () => {
    const created = createMcpClient(
      { type: 'stdio', command: process.execPath, args: ['-e', MCP_SERVER_SCRIPT] },
      process.cwd(),
    );
    expect(created.isOk()).toBe(true);
    if (!created.isOk()) return;
    const client = created.value;
    const tools = await client.start();
    expect(tools.isOk()).toBe(true);
    if (tools.isOk()) {
      expect(tools.value).toHaveLength(1);
      expect(tools.value[0].name).toBe('greet');
    }
    const call = await client.callTool('greet', { who: 'lorra' });
    expect(call.isOk()).toBe(true);
    if (call.isOk()) expect(call.value).toBe('hi lorra');
    client.stop();
  }, 15000);

  it('stdio 缺 command → mcp-stdio-no-command', async () => {
    const created = createMcpClient({ type: 'stdio', command: '' }, '/r');
    expect(created.isOk()).toBe(true);
    if (!created.isOk()) return;
    const res = await created.value.start();
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('mcp-stdio-no-command');
  });

  it('HttpMcpClient start 走 initialize → tools/list（fetch mock）', async () => {
    const calls: string[] = [];
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse((init?.body as string) ?? '{}') as { method: string };
      calls.push(body.method);
      let result: unknown = {};
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26' };
      if (body.method === 'tools/list')
        result = { tools: [{ name: 't', inputSchema: { type: 'string' } }] };
      if (body.method === 'tools/call') result = { content: [{ type: 'text', text: 'ok' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'mcp-session-id': 's1' },
      });
    };
    const client = new HttpMcpClient({ type: 'streamable-http', url: 'https://x/mcp' }, '/r', {
      fetcher,
    });
    const tools = await client.start();
    expect(tools.isOk()).toBe(true);
    if (tools.isOk()) expect(tools.value).toHaveLength(1);
    expect(calls).toContain('initialize');
    expect(calls).toContain('tools/list');
    const call = await client.callTool('t', {});
    expect(call.isOk()).toBe(true);
    client.stop();
  });

  it('parseMcpJson：纯 JSON 与 SSE 两种均可解析', () => {
    expect(parseMcpJson('{"jsonrpc":"2.0","id":1,"result":{}}')?.result).toEqual({});
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n';
    expect(parseMcpJson(sse)?.result).toEqual({ x: 1 });
    expect(parseMcpJson('')).toBeNull();
    expect(parseMcpJson('not-json')).toBeNull();
  });
});
