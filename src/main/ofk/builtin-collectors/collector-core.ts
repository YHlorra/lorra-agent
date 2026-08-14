import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { factIdOf, type SessionFact } from '../../../shared/facts-schema';
import type { Result } from '../../../shared/result';
import { ok } from '../../../shared/result';
import { readConcept, sessionConceptPath } from '../ofk-bundle';
import { isFileUnchanged, readSyncState, statFile, updateSyncState } from '../sync-state';

/**
 * 内置数据源适配器(step 4):把本机其他 AI 工具的会话 jsonl 合成
 * PluginFact。真实会话格式以样本校准;拿不到样本的源保持 fail-open
 * (目录/格式不存在 → Ok([]))。每个适配器独立单文件,契约(PluginFact)不变。
 *
 * 通用格式假设(2026-08-13 以 Oh My Pi 真实样本校准):jsonl 逐行 JSON 对象,
 * 可含 type:'session' 头(携带真实 cwd;claude-code 无头);行内
 * type:'message' 且 message.role 为 user|assistant,message.content 为文本串或
 * 块数组({type:'text'|'tool_use', ...});timestamp 为 ISO 串或数字。
 * 无 timestamp 的行(title/model_change 等元数据行)被 toTimestamp 正常跳过
 * (非坏行);带 timestamp 的非 message 行只参与 start/end 区间,不产文本/工具。
 */

export interface BuiltinCollector {
  name: string;
  runtime: string;
  enabled: boolean;
  /** 返回已补全的 SessionFact[](collector 名即 runtime 名;start/end 为 epoch)。 */
  collect(): Promise<Result<SessionFact[]>>;
}

/** SAFE_ID 清洗(sessionRef 文件名用)。 */
function safeStem(name: string): string {
  return name.replace(/\.jsonl$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** 从 content 提取文本与工具名(text 串/块数组)。 */
function extractContent(content: unknown): { text: string; tools: string[] } {
  if (typeof content === 'string') return { text: content, tools: [] };
  if (Array.isArray(content)) {
    let text = '';
    const tools: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown; name?: unknown };
        if ((b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string') {
          text += b.text;
        }
        if (
          (b.type === 'tool_use' || b.type === 'toolUse' || b.type === 'toolCall') &&
          typeof b.name === 'string' &&
          b.name.length > 0 &&
          !tools.includes(b.name)
        ) {
          tools.push(b.name);
        }
      }
    }
    return { text, tools };
  }
  if (content && typeof content === 'object') {
    const c = content as { type?: unknown; text?: unknown };
    return { text: typeof c.text === 'string' ? c.text : '', tools: [] };
  }
  return { text: '', tools: [] };
}

function toTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** 行结构布局:'message' = type=user|assistant + message.content(pi/claude-code);
 * 'top-level' = type='message' + 顶层 role/content(workbuddy,2026-08-13 真实样本校准)。 */
export type SessionLineLayout = 'message' | 'top-level';

/**
 * 合成单文件 → PluginFact(一条文件一条会话):
 * title = 首条 user 文本 ≤60(top-level 布局优先 ai-title 行);activeMs = 首末
 * timestamp 差;tokens 缺失填 0;tools = tool_use 名去重(含 function_call 顶层 name)。
 */
export function synthesizeSessionFact(opts: {
  runtimePrefix: string;
  fileName: string;
  workspace: string;
  entries: Array<Record<string, unknown>>;
  /** 行结构布局,缺省 'message'(pi/claude-code)。 */
  layout?: SessionLineLayout;
}): SessionFact | null {
  const { runtimePrefix, fileName, workspace, entries } = opts;
  const layout: SessionLineLayout = opts.layout ?? 'message';
  const timed: Array<{ ts: number; role?: string; content?: unknown }> = [];
  let firstUserText = '';
  let aiTitle = '';
  const toolSet: string[] = [];
  for (const entry of entries) {
    const ts = toTimestamp(entry.timestamp);
    if (ts === null) continue;
    const type = entry.type;
    const msg = entry.message;
    const content =
      layout === 'top-level'
        ? entry.content
        : msg && typeof msg === 'object'
          ? (msg as Record<string, unknown>).content
          : undefined;
    const role =
      layout === 'top-level'
        ? String((entry as Record<string, unknown>).role ?? '')
        : type === 'user' || type === 'assistant'
          ? type
          : msg && typeof msg === 'object'
            ? String((msg as Record<string, unknown>).role ?? '')
            : '';
    timed.push({ ts, role: role || undefined, content });
    const { text, tools } = extractContent(content);
    if (role === 'user' && !firstUserText) {
      firstUserText = text.trim().slice(0, 60);
    }
    // workbuddy:ai-title 行带真实标题(现收集器原忽略,导致 title 劣化为文件名)
    if (layout === 'top-level' && type === 'ai-title' && !aiTitle) {
      const t = (entry as Record<string, unknown>).aiTitle;
      if (typeof t === 'string' && t.trim().length > 0) aiTitle = t.trim().slice(0, 60);
    }
    for (const tool of tools) {
      if (!toolSet.includes(tool)) toolSet.push(tool);
    }
    // workbuddy:function_call 行顶层 name 即工具名(原布局下丢失 → tools 恒空)
    if (
      layout === 'top-level' &&
      type === 'function_call' &&
      typeof entry.name === 'string' &&
      entry.name.length > 0 &&
      !toolSet.includes(entry.name)
    ) {
      toolSet.push(entry.name);
    }
  }
  if (timed.length === 0) return null;
  timed.sort((a, b) => a.ts - b.ts);
  const start = timed[0].ts;
  const end = timed[timed.length - 1].ts;
  const base: Omit<SessionFact, 'factId'> = {
    schemaVersion: 1,
    collector: runtimePrefix,
    runtime: runtimePrefix,
    agentId: runtimePrefix,
    sessionRef: `${runtimePrefix}-${safeStem(fileName)}`,
    scope: 'workspace',
    summaryRef: null,
    privacy: 'public_safe',
    workspace,
    start,
    end,
    activeMs: Math.max(0, end - start),
    tokens: 0,
    title: (layout === 'top-level' && aiTitle ? aiTitle : firstUserText) || safeStem(fileName),
    model: '',
    tools: toolSet,
    unfinished: timed[timed.length - 1].role === 'user',
    containsTodo: false,
  };
  return { ...base, factId: factIdOf(base) };
}

/** 递归扫描目录下全部 *.jsonl(目录缺失 → [])。
 * maxDepth:相对 root 的文件最大深度(root=0;缺省 Infinity 全深)。
 * 例:maxDepth=2 → <root>/<ws>/*.jsonl 收集,<root>/<ws>/<sess>/*.jsonl 排除。 */
export function listJsonlRecursive(root: string, maxDepth = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 目录深度 = depth+1;递归边界:目录深度 < maxDepth(深度 maxDepth 的目录不再下钻)
        if (depth + 1 < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && depth + 1 <= maxDepth) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 解析 jsonl → 条目数组(坏行跳过,缺行跳过);首行非 session 头契约。 */
export function parseSessionLines(content: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push(parsed as Record<string, unknown>);
      }
    } catch {
      // 坏行跳过
    }
  }
  return entries;
}

/** 通用适配器工厂:扫描 <root> 下 jsonl,每文件合成一条 PluginFact。 */
export function createJsonlCollector(opts: {
  name: string;
  runtimePrefix: string;
  root: () => string;
  workspaceOf: (file: string) => string;
  /** 扫描最大深度(相对 root);缺省全深。 */
  maxDepth?: number;
  /** 行结构布局,透传给 synthesizeSessionFact;缺省 'message'。 */
  layout?: SessionLineLayout;
}): BuiltinCollector {
  const { name, runtimePrefix, root, workspaceOf, maxDepth, layout } = opts;
  return {
    name,
    runtime: name,
    enabled: true,
    async collect(): Promise<Result<SessionFact[]>> {
      const files = listJsonlRecursive(root(), maxDepth);
      const state = await readSyncState();
      const changed: Record<string, { mtimeMs: number; size: number; conceptRel: string }> = {};
      const facts: SessionFact[] = [];
      for (const file of files) {
        // 增量(plan S4/D3):水位命中 + 概念在位 → 不读不写
        const stat = statFile(file);
        if (!stat) continue;
        const prev = state.files[file];
        if (isFileUnchanged(prev, stat)) {
          const existing = await readConcept(prev.conceptRel);
          if (existing.isOk() && existing.value !== null) {
            changed[file] = prev;
            continue;
          }
          // 概念缺失/读取失败 → 落到下方强制重提
        }
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const entries = parseSessionLines(content);
        // workspace 兜底链:type:'session' 头 cwd(pi 格式)→ 任意行顶层 cwd
        // (claude-code/workbuddy 真实格式:user/assistant/file-history-snapshot 行
        // 都带顶层 cwd,但无 session 头)→ 父目录名 slug。统一取真实路径,
        // 与 pi 恒开链路口径一致,今日页同工作区不分裂。
        const headerCwd = entries.find(
          (e) => typeof e.cwd === 'string' && String(e.cwd).length > 0,
        )?.cwd;
        const fact = synthesizeSessionFact({
          runtimePrefix,
          fileName: path.basename(file),
          workspace: typeof headerCwd === 'string' ? headerCwd : workspaceOf(file),
          entries,
          layout,
        });
        if (fact) {
          facts.push(fact);
          changed[file] = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            conceptRel: sessionConceptPath(fact),
          };
        }
        // fact null(无时间戳行)→ 不记账,下轮重试(此类文件极小,可接受)
      }
      if (Object.keys(changed).length > 0) {
        const result = await updateSyncState((s) => {
          Object.assign(s.files, changed);
        });
        if (result.isErr()) {
          console.error(`[collector-core] ${name} sync state persist failed:`, result.error);
        }
      }
      return ok(facts);
    },
  };
}
