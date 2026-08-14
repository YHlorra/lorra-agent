import os from 'node:os';
import path from 'node:path';

export interface TrustedPathsOpts {
  /** 测试注入;缺省 os.homedir。 */
  homedir?: string;
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

/** 前缀匹配(目录边界 + 大小写不敏感,Windows realpath 大小写不定)。 */
export function isTrustedReadPath(absPath: string, opts: TrustedPathsOpts = {}): boolean {
  const lower = absPath.toLowerCase();
  return trustedReadDirs(opts).some((dir) => {
    const d = dir.toLowerCase();
    const prefix = d.endsWith(path.sep) ? d : d + path.sep;
    return lower === d || lower.startsWith(prefix);
  });
}
