import {
  MCP_RESERVED_ENV_KEYS,
  type McpServerConfig,
  type McpServerType,
} from '../../shared/plugins-api';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';

/**
 * agent-plugins mcp.json 校验（plan S2）——mcp.schema.json 三型封闭 schema。
 *
 * 语义对齐规范（spec/1.0.0.md + mcp.schema.json）：
 * - stdio：command 必填（单个可执行 token：裸名或 ./ 相对路径）；args/env/cwd 可选；
 * env 禁 PLUGIN_ROOT/PLUGIN_DATA 键；cwd 须 ./ 相对 / ${PLUGIN_ROOT} / ${PLUGIN_DATA} 根。
 * - streamable-http / sse：url 必填（绝对 http/https，禁 userinfo/fragment）；headers 可选。
 * - 单条校验失败 -> 跳过该 server（非致命，由 loader 汇总 issues）。
 *
 * 占位符 ${PLUGIN_ROOT}/${PLUGIN_DATA} 展开不在此处做（运行时 mcp-client 才展开）；
 * 此处只做 schema + 路径包含 + 保留 env 键校验。
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidCwd(cwd: string): boolean {
  return /^(\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(cwd);
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username !== '' || u.password !== '') return false;
    if (u.hash !== '') return false;
    return true;
  } catch {
    return false;
  }
}

/** 校验单条 MCP server 配置。非法 -> err(code + PM 语域 message)。 */
export function validateMcpServer(id: string, raw: unknown): Result<McpServerConfig> {
  if (!isRecord(raw)) {
    return err({ code: 'mcp-server-invalid', message: 'MCP 服务器 ' + id + ' 须为对象' });
  }
  const type = raw.type;
  if (type !== 'stdio' && type !== 'streamable-http' && type !== 'sse') {
    return err({
      code: 'mcp-server-invalid',
      message: 'MCP 服务器 ' + id + ' 的 type 非法（须 stdio/streamable-http/sse）',
    });
  }

  const out: McpServerConfig = { type: type as McpServerType };

  if (type === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      return err({
        code: 'mcp-server-invalid',
        message: 'MCP 服务器 ' + id + ' 的 stdio command 缺失',
      });
    }
    out.command = raw.command;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((x) => typeof x !== 'string')) {
        return err({
          code: 'mcp-server-invalid',
          message: 'MCP 服务器 ' + id + ' 的 args 须为字符串数组',
        });
      }
      out.args = raw.args as string[];
    }
    if (raw.env !== undefined) {
      if (!isRecord(raw.env)) {
        return err({
          code: 'mcp-server-invalid',
          message: 'MCP 服务器 ' + id + ' 的 env 须为对象',
        });
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.env)) {
        if ((MCP_RESERVED_ENV_KEYS as readonly string[]).includes(k)) {
          return err({
            code: 'mcp-server-invalid',
            message: 'MCP 服务器 ' + id + ' 的 env 不得含保留键 ' + k,
          });
        }
        if (typeof v !== 'string') {
          return err({
            code: 'mcp-server-invalid',
            message: 'MCP 服务器 ' + id + ' 的 env.' + k + ' 须为字符串',
          });
        }
        env[k] = v;
      }
      out.env = env;
    }
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string' || !isValidCwd(raw.cwd)) {
        return err({
          code: 'mcp-server-invalid',
          message: 'MCP 服务器 ' + id + ' 的 cwd 须为 ./-相对或 PLUGIN_ROOT/PLUGIN_DATA 根',
        });
      }
      out.cwd = raw.cwd;
    }
  } else {
    // streamable-http / sse：url 必填 + headers 可选。
    if (typeof raw.url !== 'string' || !isValidUrl(raw.url)) {
      return err({
        code: 'mcp-server-invalid',
        message: 'MCP 服务器 ' + id + ' 的 url 非法（须绝对 http/https）',
      });
    }
    out.url = raw.url;
    if (raw.headers !== undefined) {
      if (!isRecord(raw.headers)) {
        return err({
          code: 'mcp-server-invalid',
          message: 'MCP 服务器 ' + id + ' 的 headers 须为对象',
        });
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v !== 'string') {
          return err({
            code: 'mcp-server-invalid',
            message: 'MCP 服务器 ' + id + ' 的 headers.' + k + ' 须为字符串',
          });
        }
        headers[k] = v;
      }
      out.headers = headers;
    }
  }

  return ok(out);
}
