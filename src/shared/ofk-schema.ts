/**
 * OFK 知识文档层 schema(三层记忆架构:raw jsonl → OFK markdown bundle →
 * UI 直读)。纯类型 + 常量 + 纯函数,零 node:* 导入,renderer 可打包
 * (仿 src/shared/memory-schema.ts 纪律)。
 */

/** 会话标签(2026-08-14 标签分类改造):自由字符串,不再六值枚举。
 * 真源 = 内置 DEFAULT_TAGS + 用户自定义(设置页管理);LLM 编译时从 tag
 * 列表选最贴切者,非空串即合法(不在列表内也照显,容错)。 */
export type SessionCategory = string;

/** 内置默认标签(页面侧唯一事实源;用户设置缺省时使用)。 */
export const DEFAULT_TAGS: readonly string[] = ['工作', '编程', '阅读', '闲聊', '项目'];

/** 非空串即合法 tag(trim 后非空);空串/非字符串 → 非法,落「未分类」。 */
export function isSessionCategory(value: unknown): value is SessionCategory {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 渲染段模型(plan D4):今日页时间线的最小渲染单元。来自 LLM 语义分段
 * (日摘要 segments)或确定性断口(概念 breaks)或整概念单段,聚合层合成。
 * start/end 为 epoch ms;activeMs 按时间占比从概念 activeMs 分配(D5)。
 */
export interface TimelineSegment {
  sessionRef: string;
  workspace: string;
  category: SessionCategory;
  /** 数据源采集器 id(概念 frontmatter sources[0].id;旧概念缺省 'unknown')。 */
  collector: string;
  start: number; // epoch ms
  end: number; // epoch ms
  activeMs: number; // 段活跃时长(按时间占比从概念 activeMs 分配,见 D5)
  title: string; // 概念 title
  summary?: string; // LLM 段摘要;无 LLM 段时回退概念 description(编译归纳,≠ title 时)
  unfinished: boolean;
  containsTodo: boolean;
  model: string;
  tools: string[];
}

/**
 * OFK 文档指针校验(共享纯函数):/memory/<entryId>.md 形态。
 * 规则:以 / 开头;总长 ≤200;每段匹配 [A-Za-z0-9._-]+;拒绝空段、`.`/`..` 段
 * (穿越 token)、反斜杠/空白等非法字符。
 * 与 ofk-bundle validateRelPath 构成双闸:bundle 层是硬边界,本函数是工具层
 * (memory 工具 / 会话提取器)的前置校验,保证穿越 token 在入口即被拒绝。
 */
export function isValidOfkRef(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (!value.startsWith('/')) return false;
  const segments = value.slice(1).split('/');
  if (segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..')) return false;
  return segments.every((seg) => /^[A-Za-z0-9._-]+$/.test(seg));
}

/**
 * 插件数据源契约:插件/内置适配器返回纯对象 PluginFact[](无类实例),
 * 注册方补全 schemaVersion/collector/runtime/agentId/factId。字段缺省填充
 * 契约见 plugins/README.md 与 _template/index.mjs(loader 只做类型校验,不补值)。
 */
export type PluginFact = Omit<
  import('./facts-schema').SessionFact,
  'factId' | 'schemaVersion' | 'collector' | 'runtime' | 'agentId'
>;

/**
 * 会话概念文档解析结果(D3 frontmatter 字段一一对应;sessionRef 为概念写回
 * 字段,其余字段按 D3 模板;start/end 为 ISO 串)。
 */
export interface SessionConceptDoc {
  type: 'Session';
  title: string;
  description: string;
  category: SessionCategory;
  /** 数据源采集器 id(frontmatter sources 块首项 id;旧概念缺省 'unknown')。 */
  collector: string;
  workspace: string;
  start: string;
  end: string;
  activeMs: number;
  tokens: number;
  model: string;
  tools: string[];
  unfinished: boolean;
  containsTodo: boolean;
  privacy: string;
  sessionRef: string;
  /** 确定性断口时刻数组(D2,epoch ms);旧文档无此字段 = 单段。 */
  breaks: number[];
}

/**
 * 自写 YAML frontmatter 小解析器(≤60 行,不引 yaml 依赖——仓库现无 yaml 包)。
 * 支持:标量(引号/数字/布尔/null/裸串)、流式数组 `[a, b]`、流式映射
 * `{ k: v, ... }`、块列表(`- item` 与 `- k: v`)与块映射(缩进 key: value)。
 * 未知复杂值跳过不解析(不整体失败),概念仍可用。
 * 解析失败(无 `---` 定界或结构损坏)返回 null。
 */
export function parseConceptFrontmatter(md: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    i++;
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('- ')) continue; // 无父键的孤立列表项:跳过
    const keyMatch = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(trimmed);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const value = (keyMatch[2] ?? '').trim();
    if (value !== '') {
      const parsed = parseInlineValue(value);
      if (parsed !== undefined) fm[key] = parsed;
      continue;
    }
    // 空值:块值(缩进的 `- item` 列表或 `k: v` 映射)
    const list: unknown[] = [];
    const map: Record<string, unknown> = {};
    let sawItem = false;
    let sawMap = false;
    while (i < lines.length) {
      const nextRaw = lines[i];
      const nextTrimmed = nextRaw.trim();
      if (!nextTrimmed || nextTrimmed.startsWith('#')) {
        i++;
        continue;
      }
      if (!/^\s+/.test(nextRaw)) break; // 顶格行 → 块结束
      const indent = nextRaw.length - nextRaw.trimStart().length;
      i++;
      if (nextTrimmed.startsWith('- ')) {
        sawItem = true;
        const item = parseBlockItem(nextTrimmed.slice(2).trim());
        list.push(item);
        // 多行块映射:`- k: v` 项后缩进更深且匹配 `k: v` 的行并入该项映射
        // (segments 块形态:ref/category/start/end 同属一项);深度不再更深或
        // 新 `- ` 项 → 停止并入(该项结束,行留给外层循环继续)。
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const itemMap = item as Record<string, unknown>;
          while (i < lines.length) {
            const contRaw = lines[i];
            const contTrimmed = contRaw.trim();
            if (!contTrimmed || contTrimmed.startsWith('#')) {
              i++;
              continue;
            }
            const contIndent = contRaw.length - contRaw.trimStart().length;
            if (contIndent <= indent || contTrimmed.startsWith('- ')) break;
            i++;
            const sub = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(contTrimmed);
            if (!sub) continue;
            const v = parseInlineValue((sub[2] ?? '').trim());
            if (v !== undefined) itemMap[sub[1]] = v;
          }
        }
      } else {
        const sub = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(nextTrimmed);
        if (sub) {
          sawMap = true;
          const v = parseInlineValue((sub[2] ?? '').trim());
          if (v !== undefined) map[sub[1]] = v;
        }
      }
    }
    if (sawItem) fm[key] = list;
    else if (sawMap) fm[key] = map;
    else fm[key] = null;
  }
  return { frontmatter: fm, body: md.slice(m[0].length) };
}

function parseBlockItem(item: string): unknown {
  const sub = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(item);
  if (sub) {
    const v = parseInlineValue((sub[2] ?? '').trim());
    return v === undefined ? { [sub[1]]: null } : { [sub[1]]: v };
  }
  return parseScalar(item);
}

function parseInlineValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    const out: unknown[] = [];
    for (const it of inner.split(',')) {
      const item = it.trim();
      if (!item || item.startsWith('[') || item.startsWith('{')) return undefined;
      const parsed = parseScalar(item);
      if (parsed === undefined) return undefined;
      out.push(parsed);
    }
    return out;
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return {};
    const out: Record<string, unknown> = {};
    for (const entry of inner.split(',')) {
      const e = entry.trim();
      if (!e) continue;
      const colon = e.indexOf(':');
      if (colon <= 0) return undefined;
      const val = e.slice(colon + 1).trim();
      if (val.startsWith('{') || val.startsWith('[')) return undefined;
      const parsed = parseScalar(val);
      if (parsed === undefined) return undefined;
      out[e.slice(0, colon).trim()] = parsed;
    }
    return out;
  }
  return parseScalar(v);
}

function parseScalar(v: string): unknown {
  if (!v) return null;
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    // 双引号串:反转义 writer(yamlQuote) 的 \" 转义对;writer 从不转义 \,
    // 只处理 \" 以免破坏原始反斜杠
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v; // 裸串(允许冒号等,如 process:lorra-cleanse/1 与 ISO 时间)
}

/**
 * YAML 单行标量安全序列化(writer 侧,与 parseScalar 构成闭环):
 * 含特殊字符/首尾空白/数值形态/布尔/null 形态 → 双引号包裹(内部 " 转义为 \",
 * parseScalar 反转义);裸串中 `C:\work` 型路径保持原样(冒号仅在后随空格时引号)。
 * 数值/布尔/null 形态必须引号包裹,否则 frontmatter 解析成 number/boolean/null,
 * 字符串字段(如 title)经 str 收窄后变空串——round-trip 损坏。
 */
export function yamlQuote(value: string): string {
  const cleaned = value.replace(/\r?\n/g, ' ').trim();
  if (!cleaned) return '""';
  if (
    /[{}[\],#"'&*!|>%@`]/.test(cleaned) ||
    cleaned.includes(': ') ||
    /^\s|\s$/.test(cleaned) ||
    // 数值形态与 parseScalar 的数值语法完全一致(整数 + 浮点含 .5/5. 前导点形态),
    // 否则 .0 这类串被解析成 number,字符串字段收窄为空
    /^-?\d+$/.test(cleaned) ||
    /^-?\d*\.\d+$/.test(cleaned) ||
    /^(?:true|false|null|~)$/.test(cleaned)
  ) {
    return `"${cleaned.replace(/"/g, '\\"')}"`;
  }
  return cleaned;
}

/** 解析会话概念文档:frontmatter 不合法/非 Session 类型/缺时间 → null。 */
export function parseSessionConcept(md: string): SessionConceptDoc | null {
  const parsed = parseConceptFrontmatter(md);
  if (!parsed) return null;
  const fm = parsed.frontmatter;
  if (fm.type !== 'Session') return null;
  const start = typeof fm.start === 'string' ? fm.start : '';
  const end = typeof fm.end === 'string' ? fm.end : '';
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
    return null;
  }
  const str = (k: string): string => (typeof fm[k] === 'string' ? (fm[k] as string) : '');
  const num = (k: string): number =>
    typeof fm[k] === 'number' && Number.isFinite(fm[k] as number) ? (fm[k] as number) : 0;
  const tools = Array.isArray(fm.tools)
    ? fm.tools.filter((t): t is string => typeof t === 'string')
    : [];
  const breaks = Array.isArray(fm.breaks)
    ? fm.breaks.filter((b): b is number => typeof b === 'number' && Number.isFinite(b))
    : [];
  // collector = sources 块首项 id(数据源采集器;旧概念无 sources → 'unknown')
  const sources = Array.isArray(fm.sources) ? fm.sources : [];
  const firstSource =
    sources.length > 0 && typeof sources[0] === 'object' && sources[0] !== null
      ? (sources[0] as Record<string, unknown>)
      : null;
  const collector =
    firstSource !== null && typeof firstSource.id === 'string' ? firstSource.id : 'unknown';
  return {
    type: 'Session',
    title: str('title'),
    description: str('description'),
    category: isSessionCategory(fm.category) ? fm.category : '未分类',
    collector,
    workspace: str('workspace'),
    start,
    end,
    activeMs: num('active_ms'),
    tokens: num('tokens'),
    model: str('model'),
    tools,
    unfinished: fm.unfinished === true,
    containsTodo: fm.contains_todo === true,
    privacy: str('privacy'),
    sessionRef: str('sessionRef'),
    breaks,
  };
}

/**
 * 解析日摘要 frontmatter 的 segments 块 → 段列表;无 segments 键 → []。
 * 逐条校验:ref 非空字符串、category 非空串(自由 tag)、start/end 非空字符串且
 * Date.parse 有限;不满足 → 丢弃该条;summary 仅字符串保留。
 */
export function parseDigestSegments(fm: Record<string, unknown>): Array<{
  ref: string;
  category: SessionCategory;
  start: string;
  end: string;
  summary?: string;
}> {
  const raw = fm.segments;
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    ref: string;
    category: SessionCategory;
    start: string;
    end: string;
    summary?: string;
  }> = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const ref = typeof e.ref === 'string' ? e.ref.trim() : '';
    const start = typeof e.start === 'string' ? e.start.trim() : '';
    const end = typeof e.end === 'string' ? e.end.trim() : '';
    if (!ref || !isSessionCategory(e.category)) continue;
    if (
      !start ||
      !end ||
      !Number.isFinite(Date.parse(start)) ||
      !Number.isFinite(Date.parse(end))
    ) {
      continue;
    }
    const seg: { ref: string; category: SessionCategory; start: string; end: string } = {
      ref,
      category: e.category,
      start,
      end,
    };
    if (typeof e.summary === 'string') {
      out.push({ ...seg, summary: e.summary });
    } else {
      out.push(seg);
    }
  }
  return out;
}
