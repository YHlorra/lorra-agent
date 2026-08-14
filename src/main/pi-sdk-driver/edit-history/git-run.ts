import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type RunGitResult =
  | { ok: true; stdout: string }
  | { ok: false; message: string; code?: string };

/**
 * 运行 git 命令(仅只读/本仓库写操作)。失败返回 { ok: false } 而非抛错:
 * 调用方按场景决定降级(如工厂探测失败 → 快照路径)。GIT_TERMINAL_PROMPT=0
 * 禁止 git 弹交互凭据提示(自管仓库不涉及远程,但防御性设置)。
 */
export async function runGit(cwd: string, args: string[]): Promise<RunGitResult> {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30_000,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      // execFile 非零退出时 error.code 是退出码(数字),二进制缺失时是 'ENOENT'。
      code: typeof cause.code === 'string' ? cause.code : undefined,
      message: cause.stderr?.trim() || cause.message || String(cause),
    };
  }
}
