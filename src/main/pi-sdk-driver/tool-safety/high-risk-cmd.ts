import { MAX_BASH_NESTING, NESTED_EXECUTOR_FLAGS, normalizeBash } from './bash-parser';

export type HighRiskResult =
  | { blocked: false }
  | { blocked: true; reason: string; category: 'high-risk' | 'unanalyzable' };

const HIGH_RISK_RM_FLAGS = new Set([
  '-r',
  '-R',
  '-rf',
  '-Rf',
  '-fr',
  '-fR',
  '--recursive',
  '--force',
  '-Recurse',
  '-Force',
  '-RecurseForce',
  '-ForceRecurse',
]);

const POWERSHELL_DESTRUCTIVE = new Set([
  'Remove-Item',
  'ri',
  'rm',
  'del',
  'erase',
  'rd',
  'rmdir',
  'Clear-Content',
]);

const POWERSHELL_EXECUTORS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

function hasForceOrRecursive(flags: string[]): boolean {
  return flags.some((f) => HIGH_RISK_RM_FLAGS.has(f));
}

/**
 * 嵌套执行器递归:payload 是一条独立命令(可能含引号),递归分类;
 * 深度超限 → unanalyzable(无法静态审查,交由审批卡裁决,而非直接拦)。
 */
function classifyNested(
  tokens: string[],
  depth: number,
  maxNesting: number,
): HighRiskResult | undefined {
  if (tokens.length === 0) return undefined;
  const cmd = tokens[0]?.toLowerCase();
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  const flags = NESTED_EXECUTOR_FLAGS[base];
  if (!flags) return undefined;
  if (depth > maxNesting) {
    return {
      blocked: true,
      reason: 'high-risk: 嵌套深度超限,无法安全审查',
      category: 'unanalyzable',
    };
  }
  for (let i = 1; i < tokens.length; i++) {
    if (flags.some((f) => f.toLowerCase() === tokens[i].toLowerCase())) {
      const payload = tokens[i + 1];
      if (payload) {
        const inner = classifyHighRisk(normalizeBash(payload), depth + 1, maxNesting);
        if (inner.blocked) return inner;
      }
    }
  }
  return undefined;
}

export function classifyHighRisk(
  tokens: string[],
  depth = 0,
  maxNesting = MAX_BASH_NESTING,
): HighRiskResult {
  if (tokens.length === 0) return { blocked: false };

  const cmd = tokens[0]?.toLowerCase();
  // strip path prefix for basename
  const base = cmd.split(/[\\/]/).pop() ?? cmd;

  // 嵌套执行器(payload 是独立命令)→ 先递归,拦到再返回。
  const nested = classifyNested(tokens, depth, maxNesting);
  if (nested) return nested;

  // PowerShell -EncodedCommand:base64 编码命令,静态审查不可达 → 直接拦。
  if (POWERSHELL_EXECUTORS.has(base)) {
    const hasEncoded = tokens.some((t) => t.toLowerCase().startsWith('-encodedcommand'));
    if (hasEncoded)
      return {
        blocked: true,
        category: 'high-risk',
        reason: 'high-risk: powershell -EncodedCommand',
      };
  }

  switch (base) {
    case 'rm': {
      const flags = tokens.slice(1).filter((t) => t.startsWith('-'));
      if (hasForceOrRecursive(flags)) {
        return { blocked: true, category: 'high-risk', reason: `high-risk: rm ${flags.join(' ')}` };
      }
      return { blocked: false }; // non-destructive — handled by trash-rewrite step
    }

    case 'del': {
      // Windows cmd: /F (force read-only), /S (subdirs), /Q (quiet)
      const flags = tokens.slice(1).filter((t) => t.startsWith('/'));
      const destructive = flags.some((f) => /^[/][FSQ]+/i.test(f));
      if (destructive)
        return {
          blocked: true,
          category: 'high-risk',
          reason: `high-risk: del ${flags.join(' ')}`,
        };
      return { blocked: false };
    }

    case 'rmdir': {
      const flags = tokens.slice(1).filter((t) => t.startsWith('/'));
      if (flags.some((f) => /^[/]S/i.test(f))) {
        return {
          blocked: true,
          category: 'high-risk',
          reason: `high-risk: rmdir ${flags.join(' ')}`,
        };
      }
      return { blocked: false };
    }

    case 'mkfs':
    case 'mkfs.ext4':
    case 'mkfs.ntfs':
      return { blocked: true, category: 'high-risk', reason: `high-risk: ${base}` };

    case 'format':
      return { blocked: true, category: 'high-risk', reason: 'high-risk: format' };

    case 'reg':
      if (tokens[1]?.toLowerCase() === 'delete')
        return { blocked: true, category: 'high-risk', reason: 'high-risk: reg delete' };
      return { blocked: false };

    case 'shutdown':
      return { blocked: true, category: 'high-risk', reason: 'high-risk: shutdown' };

    default: {
      // PowerShell cmdlets: Remove-Item -Recurse -Force
      const head = tokens[0];
      if (head && POWERSHELL_DESTRUCTIVE.has(head)) {
        const flags = tokens.slice(1).filter((t) => t.startsWith('-'));
        if (hasForceOrRecursive(flags)) {
          return {
            blocked: true,
            category: 'high-risk',
            reason: `high-risk: ${head} ${flags.join(' ')}`,
          };
        }
      }
      return { blocked: false };
    }
  }
}
