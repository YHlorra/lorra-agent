import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { tMain } from '../../i18n';
import { createPlanTool } from './plan-tool';

/**
 * LLM-facing web tools backed by the free public Exa MCP endpoint
 * (see exa-mcp-client.ts). Tool names deliberately use the generic
 * `web_search` / `web_fetch` vocabulary (codex-style) while the client
 * maps them onto Exa's `web_search_exa` / `web_fetch_exa` MCP tools.
 *
 * 备用后端(Exa 免费额度耗尽/故障时的兜底,2026-08-09):传入 backupClient
 * (AnySearch 匿名公共端点,见 anysearch-client.ts)后,Exa 调用 Err 自动降级——
 * search → AnySearch `search`,fetch → AnySearch `extract`(逐 URL)。备用结果
 * 前附来源标注行(agent 可见,不静默切换);主备都失败时报主错误并附备用失败。
 */

export interface WebToolClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result<string>>;
}

export const MAX_RESULT_CHARS = 12_000;
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const DEFAULT_MAX_CHARS = 3_000;
const MAX_FETCH_URLS = 5;

/** 降级标注:备用后端结果附加的来源说明。 */
const FALLBACK_NOTE = '> 注：Exa 不可用，以下结果来自备用后端 AnySearch。';

const webSearchSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  numResults: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_NUM_RESULTS })),
  depth: Type.Optional(Type.Union([Type.Literal('quick'), Type.Literal('thorough')])),
});

const webFetchSchema = Type.Object({
  urls: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_FETCH_URLS }),
  maxCharacters: Type.Optional(Type.Number({ minimum: 1 })),
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateResult(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…[结果过长已截断，共 ${text.length} 字符]`;
}

export interface CreateWebToolsOptions {
  /** MCP-backed client used to reach Exa (primary). */
  client: WebToolClient;
  /**
   * 备用搜索后端(Exa Err 时兜底;缺省不启用降级)。
   * 生产接线 = AnySearchClient(免 key 匿名公共端点,anysearch-client.ts)。
   */
  backupClient?: WebToolClient;
  /** Hard cap for text returned to the model. Default 12k chars. */
  maxResultChars?: number;
}

/** 主/备调用:主成功直接返回;主失败且配置了备用 → 走备用;备用也失败 → 合并报主错误。 */
async function callPrimaryWithBackup(
  primary: WebToolClient,
  backup: WebToolClient | undefined,
  primaryName: string,
  primaryArgs: Record<string, unknown>,
  backupName: string,
  backupArgs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Result<string>> {
  const res = await primary.callTool(primaryName, primaryArgs, signal);
  if (res.isOk() || !backup) return res;
  const backupRes = await backup.callTool(backupName, backupArgs, signal);
  if (backupRes.isOk()) return ok(`${FALLBACK_NOTE}\n\n${backupRes.value}`);
  return err({
    code: res.error.code,
    message: `${res.error.message}${tMain('errors.webTools.backupDown', {
      message: backupRes.error.message,
    })}`,
  });
}

export function createWebTools(deps: CreateWebToolsOptions): ToolDefinition[] {
  const limit = deps.maxResultChars ?? MAX_RESULT_CHARS;

  const webSearch: ToolDefinition<typeof webSearchSchema> = {
    name: 'web_search',
    label: '联网搜索',
    description:
      '搜索互联网获取最新信息，返回标题、URL、发布时间与摘要。适合查找当前新闻、最新文档、事实核查、不熟悉的技术方案调研。语义搜索：query 应写自然语言描述而非纯关键词。',
    promptSnippet:
      '联网搜索（web_search）：需要最新信息或外部资料时使用，例如查新闻、查文档、核实事实。',
    promptGuidelines: [
      '搜索先判断意图：快速核实/随手查询用 depth=quick（一次搜索即可）；行业调研、对比分析、写报告、需要权威依据时用 depth=thorough',
      'thorough 深度执行循环：搜索 → 用 web_fetch 阅读 2-3 个关键结果全文 → 判断信息缺口 → 换角度再搜索 → 输出综合结论',
      '回答搜索类问题时，结论附来源 URL',
    ],
    parameters: webSearchSchema,
    executionMode: 'parallel',
    async execute(_toolCallId, params, signal) {
      const depth = params.depth ?? 'quick';
      const numResults = clamp(
        params.numResults ?? (depth === 'thorough' ? MAX_NUM_RESULTS : DEFAULT_NUM_RESULTS),
        1,
        MAX_NUM_RESULTS,
      );
      const res = await callPrimaryWithBackup(
        deps.client,
        deps.backupClient,
        'web_search_exa',
        { query: params.query, numResults },
        'search',
        { query: params.query, max_results: numResults },
        signal,
      );
      if (res.isErr()) {
        throw new Error(tMain('errors.webTools.searchFailed', { message: res.error.message }));
      }
      return {
        content: [{ type: 'text', text: truncateResult(res.value, limit) }],
        details: {},
      };
    },
  };

  const webFetch: ToolDefinition<typeof webFetchSchema> = {
    name: 'web_fetch',
    label: '读取网页',
    description:
      '读取网页全文并转为干净 Markdown。在 web_search 找到关键链接后调用本工具获取正文，支持一次批量读取多个 URL。',
    promptSnippet: '读取网页（web_fetch）：搜索到链接后需要正文内容时使用。',
    parameters: webFetchSchema,
    executionMode: 'parallel',
    async execute(_toolCallId, params, signal) {
      const urls = params.urls.slice(0, MAX_FETCH_URLS);
      const maxCharacters = clamp(params.maxCharacters ?? DEFAULT_MAX_CHARS, 1, 20_000);
      const res = await deps.client.callTool('web_fetch_exa', { urls, maxCharacters }, signal);
      if (res.isErr()) {
        if (!deps.backupClient) {
          throw new Error(tMain('errors.webTools.fetchFailed', { message: res.error.message }));
        }
        // 备用:AnySearch extract 只收单 URL → 逐条抓取拼接;全部失败才报主错误。
        const parts: string[] = [];
        let okCount = 0;
        let lastBackupError = '';
        for (const url of urls) {
          const r = await deps.backupClient.callTool('extract', { url }, signal);
          if (r.isOk()) {
            okCount += 1;
            parts.push(r.value);
          } else {
            lastBackupError = r.error.message;
            parts.push(`\n\n[读取失败] ${url}: ${r.error.message}`);
          }
        }
        if (okCount === 0) {
          throw new Error(
            tMain('errors.webTools.fetchFailed', {
              message: `${res.error.message}${tMain('errors.webTools.backupDown', {
                message: lastBackupError,
              })}`,
            }),
          );
        }
        return {
          content: [
            {
              type: 'text',
              text: truncateResult(`${FALLBACK_NOTE}\n\n${parts.join('\n\n---\n\n')}`, limit),
            },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: 'text', text: truncateResult(res.value, limit) }],
        details: {},
      };
    },
  };

  return [createPlanTool(), webSearch, webFetch];
}
