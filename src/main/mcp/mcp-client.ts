import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { McpServerConfig } from '../../shared/plugins-api';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';

/**
 * 自研 MCP 运行时客户端（plan S3）——扩展 pi 的边界。
 *
 * 协议：JSON-RPC 2.0 over stdio（行分隔）/ streamable-http。
 * 方法：initialize -> notifications/initialized -> tools/list -> tools/call。
 * 协议版本协商 2025-03-26（向下兼容 2024-11-05 语义）。
 * PLUGIN_ROOT / PLUGIN_DATA 占位符展开见 expandPlaceholders（单次非递归）。
 */

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpClient {
  start(): Promise<Result<McpToolDef[]>>;
  callTool(name: string, args: Record<string, unknown>): Promise<Result<string>>;
  stop(): void;
}

export interface McpClientDeps {
  spawn?: typeof spawn;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  pluginDataDir?: string;
}

export const MCP_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_TIMEOUT_MS = 30_000;

/** 占位符展开（规范语义：单次、非递归替换，仅 PLUGIN_ROOT/PLUGIN_DATA）。 */
export function expandPlaceholders(
  value: string,
  pluginRoot: string,
  pluginDataDir: string,
): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: PLUGIN_ROOT/PLUGIN_DATA 是规范占位符，非模板插值。
  return value.split('${PLUGIN_ROOT}').join(pluginRoot).split('${PLUGIN_DATA}').join(pluginDataDir);
}

interface JsonRpcRecord {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** 客户端工厂：按 config.type 构造（sse 不支持返回 err）。 */
function resolveDeps(deps: McpClientDeps): Required<McpClientDeps> {
  return {
    spawn: deps.spawn ?? spawn,
    fetcher: deps.fetcher ?? ((url, init) => fetch(url, init)),
    pluginDataDir: deps.pluginDataDir ?? '',
  };
}

/** stdio MCP 客户端：spawn 子进程 + 行分隔 JSON-RPC。 */
export class StdioMcpClient implements McpClient {
  private readonly deps: Required<McpClientDeps>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private stopped = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly pluginRoot: string,
    deps: McpClientDeps = {},
  ) {
    this.deps = resolveDeps(deps);
  }

  async start(): Promise<Result<McpToolDef[]>> {
    const command = this.config.command;
    if (!command) return err({ code: 'mcp-stdio-no-command', message: 'stdio MCP 缺 command' });
    const dataDir = this.deps.pluginDataDir || this.pluginRoot;
    const args = (this.config.args ?? []).map((a) =>
      expandPlaceholders(a, this.pluginRoot, dataDir),
    );
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [k, v] of Object.entries(this.config.env ?? {}))
      env[k] = expandPlaceholders(v, this.pluginRoot, dataDir);
    env.PLUGIN_ROOT = this.pluginRoot;
    env.PLUGIN_DATA = dataDir;
    const cwd = this.config.cwd
      ? expandPlaceholders(this.config.cwd, this.pluginRoot, dataDir)
      : this.pluginRoot;

    const child = this.deps.spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child = child;

    return await new Promise<Result<McpToolDef[]>>((resolve) => {
      let settled = false;
      const done = (r: Result<McpToolDef[]>): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const timer = setTimeout(() => {
        done(err({ code: 'mcp-start-timeout', message: 'MCP 服务器启动超时' }));
        this.stop();
      }, DEFAULT_TIMEOUT_MS);

      child.once('error', (cause) => {
        clearTimeout(timer);
        done(err({ code: 'mcp-start-failed', message: cause.message }));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (!settled)
          done(
            err({
              code: 'mcp-start-failed',
              message: 'MCP 子进程退出（code ' + String(code) + '）',
            }),
          );
      });

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        let msg: JsonRpcRecord;
        try {
          msg = JSON.parse(line) as JsonRpcRecord;
        } catch {
          return;
        }
        this.handleMessage(msg);
      });
      child.stderr.on('data', () => {});

      void this.send('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'lorra', version: '0.1' },
      })
        .then(() => {
          // notifications/initialized 是通知（无 id、不回应）——fire-and-forget。
          this.notify('notifications/initialized', {});
          return this.send('tools/list', {});
        })
        .then((raw) => {
          clearTimeout(timer);
          const tools = (raw as { result?: { tools?: McpToolDef[] } }).result?.tools ?? [];
          done(ok(tools));
        })
        .catch((cause: Error) => {
          clearTimeout(timer);
          done(err({ code: 'mcp-start-failed', message: cause.message }));
          this.stop();
        });
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Result<string>> {
    const raw = await this.send('tools/call', { name, arguments: args });
    return extractToolText(raw);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [, p] of this.pending) p.reject(new Error('MCP 客户端已停止'));
    this.pending.clear();
    this.child?.kill();
    this.child = null;
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.stopped || !this.child) return Promise.reject(new Error('MCP 客户端未启动'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP 请求超时'));
      }, DEFAULT_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const child = this.child;
      if (child) child.stdin.write(payload + '\n');
    });
  }

  /** 通知（无 id、不回应）：fire-and-forget 写 stdin。 */
  private notify(method: string, params: Record<string, unknown>): void {
    if (this.stopped || !this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private handleMessage(msg: JsonRpcRecord): void {
    if (msg.id === undefined || msg.id === null || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP RPC 错误'));
    else p.resolve(msg);
  }
}

/** streamable-http MCP 客户端（JSON-RPC over HTTP + SSE 解析）。 */
export class HttpMcpClient implements McpClient {
  private readonly deps: Required<McpClientDeps>;
  private sessionId: string | null = null;

  constructor(
    private readonly config: McpServerConfig,
    _pluginRoot: string,
    deps: McpClientDeps = {},
  ) {
    void _pluginRoot;
    this.deps = resolveDeps(deps);
  }

  async start(): Promise<Result<McpToolDef[]>> {
    const url = this.config.url;
    if (!url) return err({ code: 'mcp-http-no-url', message: 'http MCP 缺 url' });
    const initRes = await this.postJsonRpc(
      url,
      {
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'lorra', version: '0.1' },
        },
      },
      true,
    );
    if (initRes.isErr()) return initRes;
    // notifications/initialized 是通知（202 Accepted 无 body）——fire-and-forget。
    void this.postJsonRpc(url, { method: 'notifications/initialized', params: {} }, false);
    const listRes = await this.postJsonRpc(url, { method: 'tools/list', params: {} }, false);
    if (listRes.isErr()) return listRes;
    const tools = (listRes.value?.result as { tools?: McpToolDef[] } | undefined)?.tools ?? [];
    return ok(tools);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Result<string>> {
    const url = this.config.url;
    if (!url) return err({ code: 'mcp-http-no-url', message: 'http MCP 缺 url' });
    const res = await this.postJsonRpc(
      url,
      { method: 'tools/call', params: { name, arguments: args } },
      false,
    );
    if (res.isErr()) return res;
    if (res.value?.error)
      return err({ code: 'mcp-tool-error', message: res.value.error.message ?? 'MCP 工具失败' });
    return extractToolText(res.value);
  }

  stop(): void {
    this.sessionId = null;
  }

  private async postJsonRpc(
    url: string,
    message: { method: string; params: unknown },
    isInit: boolean,
  ): Promise<Result<JsonRpcRecord | null>> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.config.headers ?? {}),
      };
      if (this.sessionId && !isInit) headers['mcp-session-id'] = this.sessionId;
      const resp = await this.deps.fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), ...message }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      const sid = resp.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const raw = await resp.text();
      const body = parseMcpJson(raw);
      if (resp.status !== 200)
        return err({ code: 'mcp-http-status', message: 'MCP HTTP ' + String(resp.status) });
      return ok(body);
    } catch (cause) {
      return err({
        code: 'mcp-http-network',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

/** 解析 streamable-http 响应（SSE 或纯 JSON）。 */
export function parseMcpJson(raw: string): JsonRpcRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('event:')) {
    try {
      return JSON.parse(trimmed) as JsonRpcRecord;
    } catch {
      return null;
    }
  }
  const parts: string[] = [];
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data: ')) parts.push(line.slice(6));
  }
  if (parts.length === 0) return null;
  try {
    return JSON.parse(parts.join('')) as JsonRpcRecord;
  } catch {
    return null;
  }
}

/** 从 tools/call 结果提取文本 content（归一化）。 */
export function extractToolText(raw: unknown): Result<string> {
  const body = raw as {
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  } | null;
  const result = body?.result;
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  if (result?.isError) {
    return err({
      code: 'mcp-tool-error',
      message: typeof text === 'string' && text ? text : 'MCP 工具返回错误',
    });
  }
  if (typeof text !== 'string')
    return err({ code: 'mcp-tool-empty', message: 'MCP 工具未返回文本内容' });
  return ok(text);
}

/** 工厂：按 config.type 构造客户端（sse 不支持返回 err）。 */
export function createMcpClient(
  config: McpServerConfig,
  pluginRoot: string,
  deps: McpClientDeps = {},
): Result<McpClient> {
  if (config.type === 'sse')
    return err({ code: 'mcp-unsupported', message: 'sse 为旧版 MCP，lorra 首期不支持执行' });
  if (config.type === 'streamable-http') return ok(new HttpMcpClient(config, pluginRoot, deps));
  return ok(new StdioMcpClient(config, pluginRoot, deps));
}
