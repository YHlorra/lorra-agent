import os from 'node:os';
import path from 'node:path';
import { type BuiltinCollector, createJsonlCollector } from './collector-core';

/**
 * Workbuddy 数据源:扫描 <home>/.workbuddy/projects/ 下会话 jsonl。
 * 2026-08-13 真实样本校准:
 * - 行格式是「顶层布局」:type:'message' + 顶层 role/content(块 type='input_text'),
 * 非 pi/claude-code 的 message 包装 → 走 collector-core 的 top-level 布局;
 * ai-title 行提供真实标题;function_call 行顶层 name 是工具名。
 * - root 限定 projects/:~/.workbuddy 顶层还有 audit-log(命令安全审计事件,有
 * timestamp 无 type/role,全扫会产出「日期当标题」的垃圾事实)、logs/startup、
 * skills/ 下 evals jsonl,一律不收集。
 * - maxDepth=2:projects/<ws>/*.jsonl 收集,<ws>/<sess>/*.jsonl 嵌套子转录排除。
 * 目录/格式不存在 → Ok([]) fail-open。
 */

export const WORKBUDDY_RUNTIME = 'workbuddy';

export function createWorkbuddyCollector(): BuiltinCollector {
  return createJsonlCollector({
    name: WORKBUDDY_RUNTIME,
    runtimePrefix: 'workbuddy',
    root: () => path.join(os.homedir(), '.workbuddy', 'projects'),
    workspaceOf: (file) => path.basename(path.dirname(file)),
    maxDepth: 2,
    layout: 'top-level',
  });
}
