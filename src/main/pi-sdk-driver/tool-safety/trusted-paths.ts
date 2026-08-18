import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TrustedPathsOpts {
  /** 测试注入;缺省 os.homedir。 */
  homedir?: string;
}

/** 可信目录的 form 归一:与 target 的 realpath 同形式(CI/Windows 上 realpath
 * 可能返回 \\?\ 前缀或 8.3 短名,词法目录与之不匹配会让可信前缀判定误拒)。
 * 必须用 native 实现——拦截器的 target 来自 async fs.realpath(native,
 * GetFinalPathNameByHandle → 长名/带 \\?\ 前缀),而 realpathSync(JS 实现)
 * 保留输入形式(短名 RUNNER~1 不展开),两者同路径会给出不同字符串。
 * 仅归一目录侧——target 由调用方传 realpath,保持原样;junction 逃逸语义
 * (realpath 落库外 → 不可信)不受影响。目录不存在时回退词法(可信读取目标
 * 存在 ⟹ 其所在可信目录必存在,回退仅覆盖直接单元测试的词法用例)。 */
function canonicalDir(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** agent 自有环境目录(只读可信):用户技能目录、lorra 托管全局库、pi agent 目录。 */
export function trustedReadDirs(opts: TrustedPathsOpts = {}): string[] {
  const home = opts.homedir ?? os.homedir();
  return [
    path.join(home, '.agents', 'skills'),
    // (授权变更):lorra 托管全局库技能文件模型免审批读取,
    // 与 ~/.agents/skills 同信任级(用户本人/用户显式放置)。
    path.join(home, '.lorra', 'skills'),
    path.join(home, '.pi', 'agent'),
  ];
}

/** 前缀匹配(目录边界 + 大小写不敏感,Windows realpath 大小写不定)。
 * 调用方传入的 absPath 应为 realpath 形式;目录侧经 canonicalDir 归一
 * 到同形式,两侧才可一致比较。 */
export function isTrustedReadPath(absPath: string, opts: TrustedPathsOpts = {}): boolean {
  const lower = absPath.toLowerCase();
  return trustedReadDirs(opts).some((dir) => {
    const d = canonicalDir(dir).toLowerCase();
    const prefix = d.endsWith(path.sep) ? d : d + path.sep;
    return lower === d || lower.startsWith(prefix);
  });
}
