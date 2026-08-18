import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createMcpExtension } from '../../src/main/mcp/mcp-extension';

// plan S3: McpExtension 把 MCP 工具注册进会话工具面（pi.registerTool），execute 走 call 闭包。

type Registered = { name: string; execute: (id: string, params: unknown) => Promise<unknown> };

function fakePi(): { api: ExtensionAPI; registered: Registered[] } {
  const registered: Registered[] = [];
  const api = {
    registerTool: (tool: { name: string; execute: Registered['execute'] }) => {
      registered.push({ name: tool.name, execute: tool.execute });
    },
  } as unknown as ExtensionAPI;
  return { api, registered };
}

describe('mcp-extension', () => {
  it('把 tools 逐个注册为 mcp_<server>_<tool>', () => {
    const { api, registered } = fakePi();
    const factory = createMcpExtension({
      tools: [
        {
          serverId: 'svc',
          tool: { name: 'search', description: 'd', inputSchema: { type: 'string' } },
        },
        { serverId: 'svc', tool: { name: 'fetch' } },
      ],
      call: async () => ({ ok: true, text: 'x' }),
    });
    factory(api);
    expect(registered).toHaveLength(2);
    expect(registered[0].name).toBe('mcp_svc_search');
    expect(registered[1].name).toBe('mcp_svc_fetch');
  });

  it('execute 走 call 闭包：ok → text content；失败 → throw', async () => {
    const { api, registered } = fakePi();
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const factory = createMcpExtension({
      tools: [{ serverId: 'svc', tool: { name: 'search' } }],
      call: async (serverId, toolName, args) => {
        calls.push([serverId, toolName, args]);
        return { ok: true, text: 'hi ' + String(args.q ?? '') };
      },
    });
    factory(api);
    expect(registered).toHaveLength(1);
    const result = await registered[0].execute('c1', { q: 'x' });
    expect(calls).toEqual([['svc', 'search', { q: 'x' }]]);
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi x' }], details: {} });
  });

  it('execute 失败（call 返回 ok:false）→ throw', async () => {
    const { api, registered } = fakePi();
    const factory = createMcpExtension({
      tools: [{ serverId: 'svc', tool: { name: 'fail' } }],
      call: async () => ({ ok: false, error: 'boom' }),
    });
    factory(api);
    await expect(registered[0].execute('c2', {})).rejects.toThrow('boom');
  });
});
