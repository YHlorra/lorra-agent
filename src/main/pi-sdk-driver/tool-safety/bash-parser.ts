/**
 * Tokenize a bash command into tokens suitable for command-name + flag
 * matching. Comments are stripped; quoted strings KEEP their content
 * (quote chars removed) — collapsing them to '' was a bypass: quoted
 * paths (`copy "C:\x" "D:\y"`) vanished from every check. Pipeline/list
 * operators and newlines become boundaries. NOT a full AST.
 *
 * ponytail: regex tokenizer, not the AST parser the spec envisions (OQ-1).
 * Known ceiling: nested subshells, `find -exec`, brace groups may
 * false-negative. Upgrade path: swap to `bash-parser` npm or
 * tree-sitter-bash if misses surface.
 */

/** 嵌套执行器:该命令的指定 flag 后跟一条独立命令(payload),需递归解析。 */
export const NESTED_EXECUTOR_FLAGS: Readonly<Record<string, readonly string[]>> = {
  cmd: ['/c', '/k'],
  'cmd.exe': ['/c', '/k'],
  bash: ['-c'],
  sh: ['-c'],
  zsh: ['-c'],
  powershell: ['-Command', '-c'],
  'powershell.exe': ['-Command', '-c'],
  pwsh: ['-Command', '-c'],
  'pwsh.exe': ['-Command', '-c'],
};

/** 嵌套深度上限:超限不再深入(防 payload 无限递归;漏检由 default-deny 层兜底)。 */
export const MAX_BASH_NESTING = 5;

/**
 * Split a command string into tokens with quote awareness: single quotes
 * are fully literal; double quotes keep content with `\"`/`\\`/`\$`/`` \` ``
 * escapes resolved. A quoted group is ONE token (its content retained);
 * unquoted tokens split on whitespace.
 */
function splitOutsideQuotes(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      let j = i + 1;
      let content = '';
      while (j < s.length && s[j] !== "'") {
        content += s[j];
        j += 1;
      }
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(content);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let content = '';
      while (j < s.length) {
        if (s[j] === '"') break;
        if (s[j] === '\\' && j + 1 < s.length && '\\"$`\n'.includes(s[j + 1])) {
          content += s[j + 1];
          j += 2;
          continue;
        }
        content += s[j];
        j += 1;
      }
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(content);
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur) out.push(cur);
  return out;
}

/** Normalize a bash command into tokens. */
export function normalizeBash(command: string): string[] {
  const cleaned = command.replace(/#.*$/gm, '');
  // 先引号感知分词(引号内容整体保留),再按管道/分号/换行切边界。
  const parts = splitOutsideQuotes(cleaned);
  return parts.flatMap((p) => p.split(/[|;&\n]+/)).filter(Boolean);
}
