import type {
  ExtensionAPI,
  ExtensionFactory as SdkExtensionFactory,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { McpToolDef } from './mcp-client';
import { mcpToolName, mcpToolToSchema } from './tool-adapter';

/**
 * MCP 桥接扩展（plan S3）——参照 pi-gui 把编排扩展作为 ExtensionFactory 注入的同一模式。
 * 调用方（session-persistence）先异步拉起全部启用 MCP（startServer → tools/list），
 * 把 ready 的工具清单 + call 闭包传入；本工厂只同步 pi.registerTool。
 */

export interface ReadyMcpTool {
  serverId: string;
  tool: McpToolDef;
}

export interface McpExtensionDeps {
  tools: ReadyMcpTool[];
  /** 调用单个 MCP 工具；失败返回 err（不再 throw）。 */
  call: (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; text?: string; error?: string }>;
}

export function createMcpExtension(deps: McpExtensionDeps): SdkExtensionFactory {
  return (pi: ExtensionAPI): void => {
    for (const { serverId, tool } of deps.tools) {
      const fullName = mcpToolName(serverId, tool.name);
      const def: ToolDefinition = {
        name: fullName,
        label: 'MCP ' + tool.name,
        description:
          tool.description && tool.description !== ''
            ? tool.description
            : 'MCP 服务器 ' + serverId + ' 的工具 ' + tool.name,
        promptSnippet: 'MCP 工具 ' + fullName + '（来自服务器 ' + serverId + '）',
        parameters: mcpToolToSchema(tool.inputSchema),
        executionMode: 'sequential',
        async execute(_callId, params) {
          const res = await deps.call(
            serverId,
            tool.name,
            (params ?? {}) as Record<string, unknown>,
          );
          if (!res.ok) throw new Error(res.error ?? 'MCP 工具调用失败');
          return { content: [{ type: 'text', text: res.text ?? '' }], details: {} };
        },
      };
      pi.registerTool(def);
    }
  };
}
