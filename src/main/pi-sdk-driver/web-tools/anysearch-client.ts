import type { Result } from '../../../shared/result';
import { err, ok, toLorraError } from '../../../shared/result';
import type { McpFetchLike } from './exa-mcp-client';

/**
 * AnySearch 备用搜索客户端(Exa 免费额度耗尽/故障时的兜底,方向见 web-tools.ts):
 * 直接 HTTP JSON-RPC 调 api.anysearch.com/mcp——免 API key 匿名可用(低限流),
 * 无需本地安装 CLI。只实现 web-tools 两个工具需要的工具面:
 * search → tools/call { name:'search', arguments:{ query, max_results } }
 * extract → tools/call { name:'extract', arguments:{ url } } (整页 Markdown)
 * 响应为纯 JSON:result.content[].text(多块拼接);error 字段 → anysearch-error。
 * 错误分类与 ExaMcpClient 同构:anysearch-error / anysearch-timeout / anysearch-network,
 * 便于上层降级链按形状处理。
 */

export const DEFAULT_ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/mcp';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface AnySearchClientOptions {
  /** JSON-RPC 端点。缺省 AnySearch 公共实例。 */
  endpoint?: string;
  /** 单次请求超时(毫秒)。缺省 30s。 */
  timeoutMs?: number;
  /** fetch 注入面(测试用);缺省全局 fetch。 */
  fetcher?: McpFetchLike;
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { code?: number | string; message?: string };
}

export class AnySearchClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetcher: McpFetchLike;

  constructor(opts: AnySearchClientOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ANYSEARCH_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  }

  /**
 * 调用 AnySearch 工具并返回全部 text 块拼接(单块时即该块全文)。
 * 超时用 Promise.race(同 ExaMcpClient 纪律);外部 AbortSignal 优先。
 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<Result<string>> {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('anysearch request timed out')), this.timeoutMs);
        timer.unref?.();
      });
      const body = await Promise.race([
        this.fetcher(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: externalSignal,
        }),
        timeout,
      ]);
      clearTimeout(timer);
      if (!body.ok) {
        return err({
          code: 'anysearch-error',
          message: `AnySearch ${name} failed with HTTP ${body.status}`,
        });
      }
      const text = await body.text();
      const json = this.parseJson(text);
      if (json.error) {
        return err({
          code: 'anysearch-error',
          message: `AnySearch ${name} failed: ${json.error.message ?? String(json.error.code)}`,
        });
      }
      const blocks = json.result?.content?.filter(
        (b) => typeof b.text === 'string' && b.text.length > 0,
      );
      if (!blocks || blocks.length === 0) {
        return err({
          code: 'anysearch-error',
          message: `AnySearch ${name} returned no text content`,
        });
      }
      return ok(blocks.map((b) => b.text).join(''));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/timed out/i.test(message)) {
        return err({
          code: 'anysearch-timeout',
          message: `AnySearch request timed out after ${this.timeoutMs}ms`,
        });
      }
      return err(toLorraError(cause, 'anysearch-network'));
    }
  }

  /** 纯 JSON 响应;容错 SSE 风格(data: 前缀)响应。 */
  private parseJson(text: string): JsonRpcResponse {
    const trimmed = text.trim();
    const dataLine = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    return JSON.parse(dataLine) as JsonRpcResponse;
  }
}
