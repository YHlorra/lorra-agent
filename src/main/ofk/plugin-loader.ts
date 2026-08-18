import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FACTS_SCHEMA_VERSION,
  type FactPrivacy,
  factIdOf,
  type SessionFact,
} from '../../shared/facts-schema';
import type { SessionCategory } from '../../shared/ofk-schema';
import { isSessionCategory } from '../../shared/ofk-schema';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { pluginsRoot } from './plugin-template-seed';

/**
 * 插件加载(step 3):读 ~/.lorra/plugins/collectors 下各 plugin.json →
 * import(main) → 包装 collect(try/catch + 元素类型校验)。
 * 任何失败 → 该插件 status:'error',不影响其他插件;collect 永不 throw。
 */

export const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

const SCOPE_VALUES = ['user', 'workspace', 'project', 'agent'] as const;
const PRIVACY_VALUES = ['public_safe', 'local_private', 'private_pointer'] as const;

export interface LoadedPlugin {
  name: string;
  runtime: string;
  description: string;
  /**
   * loader 包装后的安全版(内部 try/catch + 元素校验,永不 throw):
   * 返回**已补全**的 SessionFact[](registry 完成 schemaVersion/collector/
   * runtime/agentId/factId 与 start/end ISO → epoch 归一化)。
   */
  collect(): Promise<Result<SessionFact[]>>;
  status: 'ok' | 'error';
  error?: string;
}

/** 插件侧原始形状(契约):start/end 为 ISO 串,其余按表。 */
interface RawPluginFact {
  sessionRef: string;
  scope: 'user' | 'workspace' | 'project' | 'agent';
  summaryRef: string | null;
  privacy: FactPrivacy;
  workspace: string;
  start: string;
  end: string;
  activeMs: number;
  tokens: number;
  title: string;
  model: string;
  tools: string[];
  unfinished: boolean;
  containsTodo: boolean;
  category?: SessionCategory;
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 单条原始事实类型校验;非法 → null(剔除)。 */
function validatePluginFact(raw: unknown): RawPluginFact | null {
  if (!isRecord(raw)) return null;
  const str = (k: string): unknown => raw[k];
  const fail = (reason: string): null => {
    console.warn(`[plugin-loader] 插件事实被剔除: ${reason}`);
    return null;
  };
  const sessionRef = str('sessionRef');
  const title = str('title');
  const workspace = str('workspace');
  const scope = str('scope');
  const summaryRef = str('summaryRef');
  const privacy = str('privacy');
  const start = str('start');
  const end = str('end');
  const activeMs = str('activeMs');
  const tokens = str('tokens');
  const tools = str('tools');
  const unfinished = str('unfinished');
  const containsTodo = str('containsTodo');
  const model = str('model');

  if (typeof sessionRef !== 'string' || sessionRef.trim() === '') return fail('sessionRef 非空串');
  if (typeof title !== 'string' || title.trim() === '') return fail('title 非空串');
  if (typeof workspace !== 'string' || workspace.trim() === '') return fail('workspace 非空串');
  if (typeof scope !== 'string' || !(SCOPE_VALUES as readonly string[]).includes(scope)) {
    return fail(`scope 非法: ${String(scope)}`);
  }
  if (summaryRef !== null && typeof summaryRef !== 'string') return fail('summaryRef 须 null/串');
  if (typeof privacy !== 'string' || !(PRIVACY_VALUES as readonly string[]).includes(privacy)) {
    return fail(`privacy 非法: ${String(privacy)}`);
  }
  if (!isIsoString(start)) return fail('start 须 ISO 串');
  if (!isIsoString(end)) return fail('end 须 ISO 串');
  if (!isFiniteNumber(activeMs)) return fail('activeMs 须有限数');
  if (!isFiniteNumber(tokens)) return fail('tokens 须有限数');
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) {
    return fail('tools 须字符串数组');
  }
  if (typeof unfinished !== 'boolean') return fail('unfinished 须布尔');
  if (typeof containsTodo !== 'boolean') return fail('containsTodo 须布尔');

  return {
    sessionRef: sessionRef.trim(),
    scope: scope as RawPluginFact['scope'],
    summaryRef,
    privacy: privacy as FactPrivacy,
    workspace: workspace.trim(),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    activeMs,
    tokens,
    title: title.trim(),
    model: typeof model === 'string' ? model : '',
    tools: tools as string[],
    unfinished,
    containsTodo,
    ...(isSessionCategory(raw.category) ? { category: raw.category } : {}),
  };
}

/** 加载全部插件(collectors 下各目录):单个插件任何失败 → status:'error',不影响其他。 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  const root = path.join(pluginsRoot(), 'collectors');
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name !== '_template'); // 模板不加载
  } catch {
    return [];
  }
  const out: LoadedPlugin[] = [];
  for (const dir of dirs) {
    const loaded = await loadPlugin(dir);
    out.push(loaded);
  }
  return out;
}

async function loadPlugin(dir: string): Promise<LoadedPlugin> {
  const base = path.join(pluginsRoot(), 'collectors', dir);
  const bad = (error: string): LoadedPlugin => ({
    name: dir,
    runtime: '',
    description: '',
    collect: async () => err({ code: 'plugin-collect-failed', message: error }),
    status: 'error',
    error,
  });
  let meta: { name: string; runtime: string; description: string; main: string };
  try {
    const parsed = JSON.parse(readFileSync(path.join(base, 'plugin.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.name !== 'string' ||
      !PLUGIN_NAME_PATTERN.test(parsed.name) ||
      typeof parsed.runtime !== 'string' ||
      typeof parsed.description !== 'string' ||
      typeof parsed.main !== 'string'
    ) {
      return bad('plugin.json 字段非法(name 须匹配 /^[A-Za-z0-9._-]{1,40}$/)');
    }
    meta = {
      name: parsed.name,
      runtime: parsed.runtime,
      description: parsed.description,
      main: parsed.main,
    };
  } catch (cause) {
    return bad(`plugin.json 读取失败: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  let mod: unknown;
  try {
    mod = await import(pathToFileURL(path.join(base, meta.main)).href);
  } catch (cause) {
    return bad(`import 失败: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const collect = (mod as { collect?: unknown }).collect;
  if (typeof collect !== 'function') {
    return bad('index.mjs 未导出 collect() 函数');
  }

  const wrapped = async (): Promise<Result<SessionFact[]>> => {
    let raw: unknown;
    try {
      raw = await (collect as () => unknown)();
    } catch (cause) {
      return err(toLorraError(cause, 'plugin-collect-failed'));
    }
    if (!Array.isArray(raw)) {
      return err({ code: 'plugin-collect-failed', message: 'collect 未返回数组' });
    }
    const facts: SessionFact[] = [];
    let dropped = 0;
    for (const item of raw) {
      const fact = validatePluginFact(item);
      if (fact) {
        facts.push(completeFact(meta.name, fact));
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      console.warn(`[plugin-loader] ${meta.name}: 剔除 ${dropped} 条非法事实`);
    }
    return ok(facts);
  };

  return {
    name: meta.name,
    runtime: meta.runtime,
    description: meta.description,
    collect: wrapped,
    status: 'ok',
  };
}

/**
 * registry 补全(契约):schemaVersion/collector/runtime/agentId/factId,
 * 并把 start/end ISO 串归一化为 epoch 毫秒(SessionFact 口径)。
 */
function completeFact(pluginName: string, fact: RawPluginFact): SessionFact {
  const base: Omit<SessionFact, 'factId'> = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: pluginName,
    runtime: pluginName,
    agentId: pluginName,
    sessionRef: fact.sessionRef,
    scope: fact.scope,
    summaryRef: fact.summaryRef,
    privacy: fact.privacy,
    workspace: fact.workspace,
    start: Date.parse(fact.start),
    end: Date.parse(fact.end),
    activeMs: fact.activeMs,
    tokens: fact.tokens,
    title: fact.title,
    model: fact.model,
    tools: fact.tools,
    unfinished: fact.unfinished,
    containsTodo: fact.containsTodo,
    ...(fact.category !== undefined ? { category: fact.category } : {}),
  };
  return { factId: factIdOf(base), ...base };
}
