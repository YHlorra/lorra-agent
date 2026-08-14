import { MAX_BASH_NESTING, NESTED_EXECUTOR_FLAGS } from './bash-parser';

/**
 * bash 写/读语义分类:write/edit 审批链必须覆盖 bash 等价操作,
 * 否则 agent 用 `echo > file` / `copy` / `Set-Content` 绕过审批
 * (PROB: 审批只挂在工具名上,没挂在能力上)。
 *
 * 规则:
 * - 重定向目标(`>`/`>>`/`2>` 等)→ write
 * - 写类命令(copy/move/Set-Content/New-Item/Out-File/Add-Content/tee 等)
 * → 最后一个非 flag 参数是 write,其余参数是 read(源文件)
 * - 读类命令(cat/type/Get-Content/more 等)→ read
 * - 嵌套执行器(`cmd /c "..."` / `powershell -Command "..."`)→ 递归分类
 * - 未知命令的参数一律归 read(保守:读工作区外硬拦,宁拦勿放)
 */

const WRITE_COMMANDS = new Set([
  'copy',
  'xcopy',
  'robocopy',
  'move',
  'ren',
  'rename',
  'mkdir',
  'md',
  'tee',
  'touch',
  'truncate',
  'cp',
  'mv',
  'install',
  'ln',
  'dd',
  // PowerShell
  'copy-item',
  'move-item',
  'rename-item',
  'new-item',
  'set-content',
  'add-content',
  'out-file',
  'set-item',
  'export-csv',
  'export-clixml',
  'remove-item',
]);

const READ_COMMANDS = new Set([
  'cat',
  'type',
  'more',
  'less',
  'head',
  'tail',
  'grep',
  'findstr',
  'get-content',
  'select-string',
]);

export interface BashIoClassification {
  writes: string[];
  reads: string[];
}

/** 重定向操作符(含 fd 前缀如 2>):其后一个 token 是文件目标。 */
const REDIRECT_RE = /^(?:[0-9]*[<>]{1,2})$/;

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

function looksLikePath(token: string): boolean {
  if (token.startsWith('-')) return false;
  if (token.includes('=')) return false;
  if (/^[a-z]+:\/\//i.test(token)) return false;
  return /[/\\]/.test(token) || token.includes('.') || /^[A-Za-z]:/.test(token);
}

function commandBase(tokens: string[]): string {
  const cmd = tokens[0]?.toLowerCase() ?? '';
  return cmd.split(/[\\/]/).pop() ?? cmd;
}

/**
 * Classify a single command segment into write/read targets.
 * Returns accumulated classification (mutates `acc`).
 */
function classifySegment(segment: string, acc: BashIoClassification, depth: number): void {
  if (depth > MAX_BASH_NESTING) return;
  const parts = splitOutsideQuotes(segment);
  if (parts.length === 0) return;

  const base = commandBase(parts);

  // 嵌套执行器:flag 后的 payload 是独立命令 → 递归分类。
  const flags = NESTED_EXECUTOR_FLAGS[base];
  if (flags) {
    for (let i = 1; i < parts.length; i++) {
      if (flags.some((f) => f.toLowerCase() === parts[i].toLowerCase())) {
        const payload = parts[i + 1];
        if (payload) {
          const nested: BashIoClassification = { writes: [], reads: [] };
          classifySegment(payload, nested, depth + 1);
          acc.writes.push(...nested.writes);
          acc.reads.push(...nested.reads);
          i += 2;
        }
      }
    }
    return;
  }

  // 重定向目标 → write。
  const positional: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i];
    if (REDIRECT_RE.test(token)) {
      const target = parts[i + 1];
      if (target && looksLikePath(target)) acc.writes.push(target);
      i += 1;
    } else if (looksLikePath(token)) {
      positional.push(token);
    }
  }
  if (positional.length === 0) return;

  const isWrite = WRITE_COMMANDS.has(base);
  const isRead = READ_COMMANDS.has(base);
  if (isWrite) {
    // 写类命令:最后一个位置参数是目标,其余是源。
    const dest = positional[positional.length - 1];
    if (dest) acc.writes.push(dest);
    acc.reads.push(...positional.slice(0, -1));
  } else if (isRead) {
    acc.reads.push(...positional);
  } else {
    // 未知命令:参数按 read 处理(工作区外硬拦,宁拦勿放)。
    acc.reads.push(...positional);
  }
}

export function classifyBashIo(command: string): BashIoClassification {
  const acc: BashIoClassification = { writes: [], reads: [] };
  const cleaned = command.replace(/#.*$/gm, '');
  const segments = cleaned.split(/[|;&]/).flatMap((seg) => seg.split(/\n+/));
  for (const seg of segments) {
    classifySegment(seg, acc, 0);
  }
  return acc;
}

export function extractBashWriteTargets(command: string): string[] {
  return classifyBashIo(command).writes;
}

export function extractBashReadTargets(command: string): string[] {
  return classifyBashIo(command).reads;
}
