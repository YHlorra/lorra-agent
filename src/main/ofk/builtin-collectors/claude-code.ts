import os from 'node:os';
import path from 'node:path';
import { type BuiltinCollector, createJsonlCollector } from './collector-core';

/**
 * Claude Code 数据源:扫描 ~/.claude/projects 下全部 *.jsonl。
 * 会话目录按项目编码命名;workspace 取目录名(best-effort,无法可靠解码)。
 * 目录/格式不存在 → Ok([]) fail-open。
 */

const CLAUDE_CODE_RUNTIME = 'claude-code';

export function createClaudeCodeCollector(): BuiltinCollector {
  return createJsonlCollector({
    name: CLAUDE_CODE_RUNTIME,
    runtimePrefix: 'claude-code',
    root: () => path.join(os.homedir(), '.claude', 'projects'),
    workspaceOf: (file) => path.basename(path.dirname(file)),
  });
}
