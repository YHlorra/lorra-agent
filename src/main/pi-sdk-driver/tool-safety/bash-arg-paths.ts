import { MAX_BASH_NESTING, NESTED_EXECUTOR_FLAGS } from './bash-parser';

/** 引号感知分词(引号组整体一个词元、内容保留)——复用 bash-parser 的扫描器。 */
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

/** 重定向操作符(含 fd 前缀如 2>):其后一个 token 是文件目标。 */
const REDIRECT_RE = /^(?:[0-9]*[<>]{1,2})$/;

/**
 * 候选路径判定:含路径分隔符(/ 或 \)、以 `.`/`..` 开头、或 Windows 盘符
 * (C:\...)。排除 flag(-x、/x)、VAR=value 赋值与 URL。
 */
function looksLikePath(token: string): boolean {
  if (token.startsWith('-')) return false;
  if (token.includes('=')) return false;
  if (/^[a-z]+:\/\//i.test(token)) return false;
  // 含路径分隔符(/ \)、任意位置的点(file.txt、../x)、或 Windows 盘符。
  return /[/\\]/.test(token) || token.includes('.') || /^[A-Za-z]:/.test(token);
}

/**
 * Extract candidate filesystem paths from a bash command. The result feeds
 * per-path workspace containment checks in the interceptor.
 *
 * Coverage beyond the original regex tokenizer (which stripped quoted
 * content and missed Windows paths — both bypasses):
 * - quoted paths kept (`copy "C:\a" "D:\b"`)
 * - Windows backslash paths (`C:\Users\...`, `D:\outfile` without a dot)
 * - redirect targets (`>`, `>>`, `2>`, ...)
 * - nested executor payloads (`cmd /c "..."`, `powershell -Command "..."`)
 *
 * Known ceiling: arbitrary code executors (`python -c`, `node -e`) can
 * touch paths without naming them as arguments; those are out of scope
 * for static extraction (documented in interceptor default-deny notes).
 */
export function extractBashArgPaths(command: string, depth = 0): string[] {
  if (depth > MAX_BASH_NESTING) return [];
  const cleaned = command.replace(/#.*$/gm, '');
  // 先按列表/管道操作符切段(与旧实现一致),段内再做引号感知分词。
  const segments = cleaned.split(/[|;&]/).flatMap((seg) => seg.split(/\n+/));
  const paths: string[] = [];

  for (const seg of segments) {
    const parts = splitOutsideQuotes(seg);
    for (let i = 0; i < parts.length; i++) {
      const token = parts[i];

      // 重定向:目标即下一 token(消费掉,避免被当普通参数重复提取)。
      if (REDIRECT_RE.test(token)) {
        const target = parts[i + 1];
        if (target && looksLikePath(target)) paths.push(target);
        i += 1;
        continue;
      }

      // 嵌套执行器:flag 后的 payload 是一条独立命令 → 递归提取。
      const base = token.toLowerCase().split(/[\\/]/).pop() ?? token.toLowerCase();
      const flags = NESTED_EXECUTOR_FLAGS[base];
      if (
        flags &&
        i + 1 < parts.length &&
        flags.some((f) => f.toLowerCase() === parts[i + 1].toLowerCase())
      ) {
        const payload = parts[i + 2];
        if (payload) paths.push(...extractBashArgPaths(payload, depth + 1));
        i += 2;
        continue;
      }

      if (looksLikePath(token)) paths.push(token);
    }
  }
  return paths;
}
