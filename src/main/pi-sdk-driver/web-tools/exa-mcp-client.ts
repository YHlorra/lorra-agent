import { err, ok, type Result } from '../../../shared/result';

/**
 * Minimal MCP streamable-HTTP client for the Exa public endpoint
 * (https://mcp.exa.ai/mcp — the same free, key-less instance Agent-Reach
 * wires up via mcporter). Implements only what the two Exa tools need:
 * initialize → notifications/initialized → tools/call, with session
 * reuse and one re-initialize retry when the cached session goes stale.
 */

export type McpFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ExaMcpClientOptions {
  /** MCP endpoint. Defaults to the public Exa instance. */
  endpoint?: string;
  /** Per-request timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /** Injectable fetch (Electron main uses net.fetch; tests inject mocks). */
  fetcher?: McpFetchLike;
  /** MCP protocol version to negotiate. Default 2025-03-26. */
  protocolVersion?: string;
}

export const DEFAULT_EXA_ENDPOINT = 'https://mcp.exa.ai/mcp';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

/** HTTP statuses that mean the cached session is no longer valid. */
const STALE_SESSION_STATUSES: Record<number, true> = { 401: true, 404: true };

interface JsonRpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { code?: number; message?: string };
}

export class ExaMcpClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetcher: McpFetchLike;
  private readonly protocolVersion: string;
  private sessionId: string | null = null;

  constructor(opts: ExaMcpClientOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_EXA_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
    this.protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  }

  /**
   * Call an MCP tool and return the first text block of its result.
   * Re-initializes once when the cached session is stale (401/404).
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<Result<string>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.ensureSession(externalSignal);
      if (session.isErr()) return session;
      const res = await this.postJsonRpc(
        { method: 'tools/call', params: { name, arguments: args } },
        externalSignal,
      );
      if (res.isErr()) return res;
      const { status, body } = res.value;
      if (status === 200) {
        if (!body) {
          return err({ code: 'exa-mcp-error', message: `MCP ${name} returned an empty response` });
        }
        return this.extractText(body, name);
      }
      if (STALE_SESSION_STATUSES[status]) {
        this.sessionId = null;
        continue;
      }
      return err({ code: 'exa-mcp-error', message: `MCP ${name} failed with HTTP ${status}` });
    }
    return err({ code: 'exa-mcp-error', message: `MCP ${name}: session retry exhausted` });
  }

  /** Open (or reuse) the MCP session. */
  private async ensureSession(externalSignal?: AbortSignal): Promise<Result<null>> {
    if (this.sessionId) return ok(null);
    const res = await this.postJsonRpc(
      {
        method: 'initialize',
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: { name: 'lorra', version: '0.1' },
        },
      },
      externalSignal,
    );
    if (res.isErr()) return res;
    const { status, body, sessionId } = res.value;
    if (status !== 200) {
      return err({ code: 'exa-mcp-error', message: `MCP initialize failed with HTTP ${status}` });
    }
    const rpcError = body?.error;
    if (rpcError) {
      return err({
        code: 'exa-mcp-error',
        message: `MCP initialize failed: ${rpcError.message ?? rpcError.code}`,
      });
    }
    if (!sessionId) {
      return err({ code: 'exa-mcp-error', message: 'MCP server did not return a session id' });
    }
    this.sessionId = sessionId;
    await this.postJsonRpc({ method: 'notifications/initialized', params: {} }, externalSignal);
    return ok(null);
  }

  private async postJsonRpc(
    message: { method: string; params: unknown },
    externalSignal?: AbortSignal,
  ): Promise<Result<{ status: number; body: JsonRpcResponse | null; sessionId: string | null }>> {
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), ...message }),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return err({
          code: 'exa-timeout',
          message: `MCP request timed out after ${this.timeoutMs}ms`,
        });
      }
      return err({
        code: 'exa-network',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const sessionId = response.headers.get('mcp-session-id');
    const raw = await response.text();
    return ok({ status: response.status, body: parseMcpBody(raw), sessionId });
  }

  private extractText(body: JsonRpcResponse, toolName: string): Result<string> {
    if (body.error) {
      return err({
        code: 'exa-mcp-error',
        message: `MCP ${toolName} failed: ${body.error.message ?? body.error.code}`,
      });
    }
    const text = body.result?.content?.find((c) => c.type === 'text')?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return err({ code: 'exa-mcp-error', message: `MCP ${toolName} returned no text content` });
    }
    return ok(text);
  }
}

/**
 * Parse an MCP streamable-HTTP response: either SSE (`event: message` +
 * `data: <json>` lines, possibly split across events) or plain JSON.
 * Returns null when the body carries no parseable JSON-RPC payload.
 */
export function parseMcpBody(raw: string): JsonRpcResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('event:')) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return null;
    }
  }
  const dataParts: string[] = [];
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data: ')) dataParts.push(line.slice(6));
  }
  if (dataParts.length === 0) return null;
  try {
    return JSON.parse(dataParts.join('')) as JsonRpcResponse;
  } catch {
    return null;
  }
}
