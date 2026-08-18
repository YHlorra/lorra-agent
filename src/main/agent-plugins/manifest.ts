import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPluginIssue } from '../../shared/plugins-api';
import { AGENT_PLUGINS_SCHEMA_V1_0_0, PLUGIN_NAME_PATTERN } from '../../shared/plugins-api';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';

/**
 * agent-plugins 1.0.0 清单解析（plan S2）—— plugin.json 封闭 schema 校验。
 *
 * 语义对齐规范（spec/1.0.0.md + plugin.schema.json）：
 * - 根清单恒为 <pluginDir>/plugin.json；顶层必须 JSON 对象。
 * - $schema 必填且 === AGENT_PLUGINS_SCHEMA_V1_0_0（const）；缺失/不符 -> 致命。
 * - name 必填：1-64 字符、匹配 PLUGIN_NAME_PATTERN；非法 -> 致命。
 * - author 仅 name/email/url 三字符串字段（封闭）；其余键 -> 致命。
 * - 未知顶层字段、非对象 extensions -> 非致命（warning 忽略）。
 * - 其它 schema 违规 -> 致命（拒绝插件，不加载任何组件）。
 *
 * 轻量手写解析（对齐 skills-store parseFrontmatter 不引 JSON-Schema 库纪律）。
 * 客户端不得联网 fetch $schema（只作规范标识符比对）。
 */

export interface AgentPluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface AgentPluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: AgentPluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  unknownKeys: string[];
  warnings: AgentPluginIssue[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= 64 &&
    PLUGIN_NAME_PATTERN.test(name)
  );
}

const AUTHOR_KEYS = ['name', 'email', 'url'] as const;

export async function readAgentPluginManifest(
  pluginDir: string,
): Promise<Result<AgentPluginManifest>> {
  let rawText: string;
  try {
    rawText = await readFile(path.join(pluginDir, 'plugin.json'), 'utf8');
  } catch (cause) {
    return err(toLorraError(cause, 'manifest-read-failed'));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    const e = cause instanceof Error ? cause.message : String(cause);
    return err({
      code: 'manifest-parse-failed',
      message: 'plugin.json 不是合法 JSON（' + e + '）',
    });
  }
  if (!isRecord(parsed)) {
    return err({ code: 'manifest-fatal', message: 'plugin.json 顶层须为 JSON 对象' });
  }

  const warnings: AgentPluginIssue[] = [];
  const unknownKeys: string[] = [];

  if (parsed.$schema !== AGENT_PLUGINS_SCHEMA_V1_0_0) {
    return err({ code: 'manifest-fatal', message: 'plugin.json 的 $schema 缺失或版本不符' });
  }
  if (!isValidName(parsed.name)) {
    return err({
      code: 'manifest-fatal',
      message: 'plugin.json 的 name 非法（须 1-64 位小写字母/数字/点/连字符）',
    });
  }

  for (const k of ['version', 'description', 'homepage', 'repository', 'license'] as const) {
    const v = parsed[k];
    if (v !== undefined && typeof v !== 'string') {
      return err({ code: 'manifest-fatal', message: 'plugin.json 的 ' + k + ' 须为字符串' });
    }
  }

  let keywords: string[] | undefined;
  if (parsed.keywords !== undefined) {
    if (!Array.isArray(parsed.keywords) || parsed.keywords.some((x) => typeof x !== 'string')) {
      return err({ code: 'manifest-fatal', message: 'plugin.json 的 keywords 须为字符串数组' });
    }
    keywords = parsed.keywords as string[];
  }

  // author：封闭对象，仅 name/email/url 三字符串字段。
  let author: AgentPluginAuthor | undefined;
  if (parsed.author !== undefined) {
    if (!isRecord(parsed.author)) {
      return err({ code: 'manifest-fatal', message: 'plugin.json 的 author 须为对象' });
    }
    const a: AgentPluginAuthor = {};
    for (const [k, v] of Object.entries(parsed.author)) {
      if ((AUTHOR_KEYS as readonly string[]).includes(k)) {
        if (typeof v !== 'string') {
          return err({
            code: 'manifest-fatal',
            message: 'plugin.json 的 author.' + k + ' 须为字符串',
          });
        }
        (a as Record<string, string>)[k] = v;
      } else {
        return err({ code: 'manifest-fatal', message: 'plugin.json 的 author 含未知键 ' + k });
      }
    }
    author = a;
  }

  if (parsed.extensions !== undefined && !isRecord(parsed.extensions)) {
    warnings.push({
      code: 'manifest-warning',
      message: 'plugin.json 的 extensions 非对象，已忽略',
    });
  }

  const KNOWN = new Set([
    '$schema',
    'name',
    'version',
    'description',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
    'extensions',
  ]);
  for (const k of Object.keys(parsed)) {
    if (!KNOWN.has(k)) {
      unknownKeys.push(k);
      warnings.push({
        code: 'manifest-warning',
        message: 'plugin.json 含未知字段 ' + k + '，已忽略',
      });
    }
  }

  const manifest: AgentPluginManifest = {
    name: parsed.name as string,
    ...(typeof parsed.version === 'string' && parsed.version !== ''
      ? { version: parsed.version }
      : {}),
    ...(typeof parsed.description === 'string' && parsed.description !== ''
      ? { description: parsed.description }
      : {}),
    ...(author !== undefined ? { author } : {}),
    ...(typeof parsed.homepage === 'string' && parsed.homepage !== ''
      ? { homepage: parsed.homepage }
      : {}),
    ...(typeof parsed.repository === 'string' && parsed.repository !== ''
      ? { repository: parsed.repository }
      : {}),
    ...(typeof parsed.license === 'string' && parsed.license !== ''
      ? { license: parsed.license }
      : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    unknownKeys,
    warnings,
  };
  return ok(manifest);
}
