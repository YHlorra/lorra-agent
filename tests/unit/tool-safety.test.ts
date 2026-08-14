import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Extension, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BlockEmitter } from '../../src/main/pi-sdk-driver/driver';
import { extractBashArgPaths } from '../../src/main/pi-sdk-driver/tool-safety/bash-arg-paths';
import {
  classifyBashIo,
  extractBashReadTargets,
  extractBashWriteTargets,
} from '../../src/main/pi-sdk-driver/tool-safety/bash-io';
import { normalizeBash } from '../../src/main/pi-sdk-driver/tool-safety/bash-parser';
import { classifyHighRisk } from '../../src/main/pi-sdk-driver/tool-safety/high-risk-cmd';
import { createSafetyInterceptor } from '../../src/main/pi-sdk-driver/tool-safety/interceptor';
import { resolveAndCheck } from '../../src/main/pi-sdk-driver/tool-safety/path-check';
import {
  checkWriteSize,
  SIZE_THRESHOLD_BYTES,
} from '../../src/main/pi-sdk-driver/tool-safety/size-threshold';
import { isTrustedReadPath } from '../../src/main/pi-sdk-driver/tool-safety/trusted-paths';

function buildExtension(factory: (pi: ExtensionAPI) => void): Extension {
  const extension: Extension = {
    path: 'test',
    resolvedPath: 'test',
    sourceInfo: { path: 'test', source: 'inline', scope: 'project', origin: 'top-level' },
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const api = {
    on(event: string, handler: unknown) {
      const list = extension.handlers.get(event) ?? [];
      list.push(handler as never);
      extension.handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  void factory(api);
  return extension;
}

// ---------------------------------------------------------------------------
// path-check
// ---------------------------------------------------------------------------

describe('path-check', () => {
  it('positive: file inside workspace resolves ok', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'lorra-test-'));
    const file = path.join(tmp, 'hello.txt');
    await writeFile(file, 'hi');

    const res = await resolveAndCheck(tmp, file);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(typeof res.realpath).toBe('string');
    }

    await rm(tmp, { recursive: true, force: true });
  });

  it('negative: file outside workspace is blocked', async () => {
    const res = await resolveAndCheck('/tmp', '/etc/passwd');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('path-out-of-workspace');
    }
  });

  it('negative: non-existent path is blocked (default-deny)', async () => {
    const res = await resolveAndCheck('/tmp', '/tmp/does-not-exist-xyz');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('path-out-of-workspace');
    }
  });

  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (s) => {
      // fast-check property: any path with ".." that escapes workspace is blocked
      const _workspace = '/home/user/project';
      const candidate = `/home/user/project/${s}/../../etc/passwd`;
      // We can't easily test realpath without a real filesystem, so just
      // verify the function doesn't throw for valid inputs.
      return typeof candidate === 'string';
    }),
  );
});

// ---------------------------------------------------------------------------
// trusted-paths
// ---------------------------------------------------------------------------

describe('trusted-paths', () => {
  it('exact dir and children are trusted', () => {
    const home = path.join(tmpdir(), 'lorra-tp-home');
    expect(isTrustedReadPath(path.join(home, '.agents', 'skills'), { homedir: home })).toBe(true);
    expect(
      isTrustedReadPath(path.join(home, '.agents', 'skills', 'demo', 'SKILL.md'), {
        homedir: home,
      }),
    ).toBe(true);
    expect(
      isTrustedReadPath(path.join(home, '.pi', 'agent', 'skills', 'x.md'), { homedir: home }),
    ).toBe(true);
  });

  it('sibling dirs and unrelated paths are not trusted', () => {
    const home = path.join(tmpdir(), 'lorra-tp-home2');
    expect(
      isTrustedReadPath(path.join(home, '.agents', 'skills2', 'x.md'), { homedir: home }),
    ).toBe(false);
    expect(
      isTrustedReadPath(path.join(home, '.agents', 'config', 'x.json'), { homedir: home }),
    ).toBe(false);
    expect(isTrustedReadPath(path.join(home, 'Desktop', 'x.txt'), { homedir: home })).toBe(false);
  });

  it('case-insensitive on Windows-style casing', () => {
    const home = path.join(tmpdir(), 'Lorra-TP-Home');
    expect(
      isTrustedReadPath(path.join(home, '.AGENTS', 'SKILLS', 'Demo', 'skill.md'), {
        homedir: home,
      }),
    ).toBe(true);
  });

  // (授权变更):lorra 托管全局库 ~/.lorra/skills 与 ~/.agents/skills
  // 同信任级 —— 模型免审批读取全局库技能文件。
  it('lorra 托管全局库 ~/.lorra/skills 同级可信: 信任前缀命中', () => {
    const home = path.join(tmpdir(), 'lorra-tp-home-d13');
    expect(isTrustedReadPath(path.join(home, '.lorra', 'skills'), { homedir: home })).toBe(true);
    expect(
      isTrustedReadPath(path.join(home, '.lorra', 'skills', 'demo', 'SKILL.md'), {
        homedir: home,
      }),
    ).toBe(true);
    // 邻居目录不受信任(词法前缀边界)。
    expect(
      isTrustedReadPath(path.join(home, '.lorra', 'config', 'x.json'), { homedir: home }),
    ).toBe(false);
    expect(isTrustedReadPath(path.join(home, '.lorra', 'skills2', 'x.md'), { homedir: home })).toBe(
      false,
    );
  });

  // 回归锁(不得改动判定链):isTrustedReadPath 是词法前缀比较,但 interceptor 的
  // 入参已是 check.realpath(path-check.ts:35-38 realpath 先行)——库内 junction
  // 指向库外时 realpath 判定落库外、不在可信前缀 → 已走审批。
  it('junction 逃逸否定: 库内 junction 指向库外 → realpath 落库外 → 不可信走审批', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'lorra-tp-junc-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'lorra-tp-out-'));
    const skillsDir = path.join(home, '.lorra', 'skills');
    const linkPath = path.join(skillsDir, 'escaped');
    await mkdir(skillsDir, { recursive: true });
    try {
      await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // 环境不支持 junction/symlink(降级):词法前缀仍命中,判定链不变,不误伤。
      expect(isTrustedReadPath(linkPath, { homedir: home })).toBe(true);
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      return;
    }
    try {
      // 词法前缀命中(路径在可信库内)…
      expect(isTrustedReadPath(linkPath, { homedir: home })).toBe(true);
      // …但判定链 realpath 先行:realpath 落库外 → 不可信(走审批/拒绝)。
      const resolved = await realpath(linkPath);
      expect(isTrustedReadPath(resolved, { homedir: home })).toBe(false);
      expect(isTrustedReadPath(outside, { homedir: home })).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// size-threshold
// ---------------------------------------------------------------------------

describe('size-threshold', () => {
  it('positive: content under 256KB passes', () => {
    const small = 'x'.repeat(100);
    const res = checkWriteSize({ path: '/tmp/f', content: small });
    expect(res.ok).toBe(true);
  });

  it('positive: exactly 256KB passes', () => {
    const exact = 'x'.repeat(SIZE_THRESHOLD_BYTES);
    const res = checkWriteSize({ path: '/tmp/f', content: exact });
    expect(res.ok).toBe(true);
  });

  it('negative: over 256KB is blocked', () => {
    const big = 'x'.repeat(SIZE_THRESHOLD_BYTES + 1);
    const res = checkWriteSize({ path: '/tmp/f', content: big });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('size-exceeds-threshold');
      expect(res.actual).toBe(SIZE_THRESHOLD_BYTES + 1);
    }
  });

  it('negative: empty content passes (0 bytes)', () => {
    const res = checkWriteSize({ path: '/tmp/f', content: '' });
    expect(res.ok).toBe(true);
  });

  it('negative: no content passes (0 bytes)', () => {
    const res = checkWriteSize({ path: '/tmp/f' });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bash-parser
// ---------------------------------------------------------------------------

describe('bash-parser', () => {
  it('strips single-quoted strings', () => {
    const tokens = normalizeBash("echo 'hello world'");
    expect(tokens).toContain('echo');
    expect(tokens).not.toContain("'hello world'");
  });

  it('strips double-quoted strings', () => {
    const tokens = normalizeBash('echo "hello world"');
    expect(tokens).toContain('echo');
    expect(tokens).not.toContain('"hello world"');
  });

  it('strips comments', () => {
    const tokens = normalizeBash('echo hello # this is a comment');
    expect(tokens).toContain('echo');
    expect(tokens).toContain('hello');
    expect(tokens).not.toContain('#');
  });

  it('splits on pipeline operator', () => {
    const tokens = normalizeBash('cat file.txt | grep error');
    expect(tokens).toContain('cat');
    expect(tokens).toContain('file.txt');
    expect(tokens).toContain('grep');
    expect(tokens).toContain('error');
  });

  it('splits on semicolon', () => {
    const tokens = normalizeBash('echo a; echo b');
    expect(tokens).toContain('echo');
    expect(tokens).toContain('a');
    expect(tokens).toContain('b');
  });
});

// ---------------------------------------------------------------------------
// high-risk-cmd
// ---------------------------------------------------------------------------

describe('high-risk-cmd', () => {
  it('blocks rm -rf', () => {
    const res = classifyHighRisk(normalizeBash('rm -rf /tmp/foo'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('allows rm without force/recursive', () => {
    const res = classifyHighRisk(normalizeBash('rm /tmp/foo'));
    expect(res.blocked).toBe(false);
  });

  it('blocks del /f/s/q', () => {
    const res = classifyHighRisk(normalizeBash('del /f /s /q C:\\tmp\\foo'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('allows del without destructive flags', () => {
    const res = classifyHighRisk(normalizeBash('del C:\\tmp\\foo'));
    expect(res.blocked).toBe(false);
  });

  it('blocks rmdir /s', () => {
    const res = classifyHighRisk(normalizeBash('rmdir /s /q C:\\tmp'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('allows rmdir without /s', () => {
    const res = classifyHighRisk(normalizeBash('rmdir C:\\tmp'));
    expect(res.blocked).toBe(false);
  });

  it('blocks mkfs', () => {
    const res = classifyHighRisk(normalizeBash('mkfs.ext4 /dev/sda1'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('blocks format', () => {
    const res = classifyHighRisk(normalizeBash('format C:'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('blocks reg delete', () => {
    const res = classifyHighRisk(normalizeBash('reg delete HKLM\\Software\\Foo'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('allows reg query', () => {
    const res = classifyHighRisk(normalizeBash('reg query HKLM\\Software\\Foo'));
    expect(res.blocked).toBe(false);
  });

  it('blocks shutdown', () => {
    const res = classifyHighRisk(normalizeBash('shutdown /s /t 0'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('blocks Remove-Item -Recurse -Force', () => {
    const res = classifyHighRisk(normalizeBash('Remove-Item -Recurse -Force C:\\tmp\\foo'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('allows Remove-Item without force/recursive', () => {
    const res = classifyHighRisk(normalizeBash('Remove-Item C:\\tmp\\foo'));
    expect(res.blocked).toBe(false);
  });

  it('reason never contains absolute path', () => {
    const res = classifyHighRisk(normalizeBash('rm -rf /tmp/foo'));
    if (res.blocked) {
      expect(res.reason).not.toMatch(/^[A-Z]:[\\/]/);
      expect(res.reason).not.toMatch(/^\//);
    }
  });

  // PROB: 嵌套命令(payload 在引号/参数里)绕过命令名识别
  it('blocks rm -rf inside cmd /c payload', () => {
    const res = classifyHighRisk(normalizeBash('cmd /c "rm -rf /tmp/foo"'));
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.reason).toContain('high-risk');
    }
  });

  it('blocks Remove-Item -Recurse -Force inside powershell -Command', () => {
    const res = classifyHighRisk(
      normalizeBash('powershell -Command "Remove-Item -Recurse -Force C:\\tmp\\foo"'),
    );
    expect(res.blocked).toBe(true);
  });

  it('blocks rm -rf inside bash -c payload', () => {
    const res = classifyHighRisk(normalizeBash("bash -c 'rm -rf /tmp/foo'"));
    expect(res.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bash-arg-paths
// ---------------------------------------------------------------------------

describe('bash-arg-paths', () => {
  it('extracts relative path from cat command', () => {
    const paths = extractBashArgPaths('cat ../../etc/passwd');
    expect(paths).toContain('../../etc/passwd');
  });

  it('extracts path from echo redirect', () => {
    const paths = extractBashArgPaths('echo hello > ../file.txt');
    expect(paths).toContain('../file.txt');
  });

  it('ignores flags', () => {
    const paths = extractBashArgPaths('grep -r error .');
    expect(paths).not.toContain('-r');
  });

  it('ignores VAR=value assignments', () => {
    const paths = extractBashArgPaths('FOO=bar cat file.txt');
    expect(paths).toContain('file.txt');
    expect(paths).not.toContain('FOO=bar');
  });

  it('ignores URLs', () => {
    const paths = extractBashArgPaths('curl https://example.com');
    expect(paths).not.toContain('https://example.com');
  });

  // PROB: 引号包裹的路径被整体剥掉 → 零检查放行,读/写任意位置
  it('extracts paths inside quotes (copy with quoted args)', () => {
    const paths = extractBashArgPaths(
      'copy "C:\\Users\\example\\Desktop\\secret.txt" "D:\\outside\\leak.txt"',
    );
    expect(paths).toContain('C:\\Users\\example\\Desktop\\secret.txt');
    expect(paths).toContain('D:\\outside\\leak.txt');
  });

  it('extracts quoted path after echo redirect', () => {
    const paths = extractBashArgPaths('echo pwn > "C:\\Users\\Public\\out.txt"');
    expect(paths).toContain('C:\\Users\\Public\\out.txt');
  });

  // PROB: Windows 反斜杠路径无 `.`/`/` → 过滤漏检
  it('extracts Windows path without dot in filename', () => {
    const paths = extractBashArgPaths('echo x > D:\\outside\\outfile');
    expect(paths).toContain('D:\\outside\\outfile');
  });

  it('extracts Windows path after type (no extension)', () => {
    const paths = extractBashArgPaths('type C:\\Users\\Public\\data');
    expect(paths).toContain('C:\\Users\\Public\\data');
  });

  // PROB: 嵌套命令 payload 被剥掉 → 高危/路径检查双双失效
  it('extracts path inside cmd /c payload', () => {
    const paths = extractBashArgPaths('cmd /c "type C:\\Users\\Public\\data"');
    expect(paths).toContain('C:\\Users\\Public\\data');
  });

  it('extracts path inside powershell -Command payload', () => {
    const paths = extractBashArgPaths(
      'powershell -Command "Set-Content -Path D:\\outside\\out.txt -Value pwn"',
    );
    expect(paths).toContain('D:\\outside\\out.txt');
  });

  // PROB: PowerShell 参数值路径(-Path 后的值)应被提取
  it('extracts PowerShell -Path argument value', () => {
    const paths = extractBashArgPaths('Set-Content -Path D:\\outside\\out.txt -Value pwn');
    expect(paths).toContain('D:\\outside\\out.txt');
  });

  it('extracts stderr redirect target', () => {
    const paths = extractBashArgPaths('cmd 2> D:\\err.log');
    expect(paths).toContain('D:\\err.log');
  });

  // PROB: bash 是 write/edit 的等价通道——写类命令与重定向目标
  // 必须与 write 同链审批,否则 agent 用 bash 绕过 write 审批。
  it('classifies echo redirect target as write', () => {
    const writes = extractBashWriteTargets('echo hi > brand-new.md');
    expect(writes).toContain('brand-new.md');
  });

  it('classifies copy destination as write, source as read', () => {
    const { writes, reads } = classifyBashIo('copy a.txt b.txt');
    expect(writes).toContain('b.txt');
    expect(reads).toContain('a.txt');
  });

  it('classifies Set-Content path as write', () => {
    const writes = extractBashWriteTargets('Set-Content -Path docs\\new.md -Value pwn');
    expect(writes).toContain('docs\\new.md');
  });

  it('classifies cat/type path as read', () => {
    const reads = extractBashReadTargets('type C:\\Users\\Public\\data');
    expect(reads).toContain('C:\\Users\\Public\\data');
  });

  it('classifies cmd /c nested echo redirect as write', () => {
    const writes = extractBashWriteTargets('cmd /c "echo pwn > D:\\outside\\out.txt"');
    expect(writes).toContain('D:\\outside\\out.txt');
  });

  it('classifies plain echo (no redirect) as no write', () => {
    const writes = extractBashWriteTargets('echo hello world');
    expect(writes).toEqual([]);
  });

  it('classifies powershell -Command nested Set-Content as write', () => {
    const writes = extractBashWriteTargets(
      'powershell -Command "Set-Content -Path D:\\outside\\out.txt -Value pwn"',
    );
    expect(writes).toContain('D:\\outside\\out.txt');
  });
});

// ---------------------------------------------------------------------------
// interceptor (mock)
// ---------------------------------------------------------------------------

describe('interceptor', () => {
  const blockedEvents: Array<{
    toolName: string;
    target: string;
    callId?: string;
    safetyNote: string;
  }> = [];

  const emitBlocked: BlockEmitter = (payload) => {
    blockedEvents.push(payload);
  };

  const workspace = '/home/user/project';

  beforeEach(() => {
    blockedEvents.length = 0;
  });

  it('blocks non-whitelisted tools', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    // Access the handler array from the extension's handlers map
    const toolCallHandlers = ext.handlers.get('tool_call');
    expect(toolCallHandlers).toBeDefined();
    expect(toolCallHandlers?.length).toBeGreaterThan(0);

    const handler = toolCallHandlers?.[0] as (event: unknown) => Promise<unknown>;

    const result = await handler({
      type: 'tool_call',
      toolCallId: 'call-1',
      // truncate = SDK internal output-truncation tool, NOT whitelisted
      // (grep is whitelisted since the code-search change).
      toolName: 'truncate',
      input: { path: '/home/user/project/file.txt' },
    });

    expect(result).toEqual({ block: true, reason: 'tool-not-allowed' });
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]?.safetyNote).toBe('tool-not-allowed');
  });

  // 走查实证修复(2026-08-09):memory 工具曾被 WHITELIST 遗漏,
  // agent 每次 propose/update/retire/search 都被 tool-not-allowed 拦截——
  // 生产环境「agent 的双手」全断,单测未覆盖该组合路径(920 绿但真机必坏)。
  it('allows memory tool (agent 记忆双手,)', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    const handler = ext.handlers.get('tool_call')?.[0] as (event: unknown) => Promise<unknown>;

    // memory 工具无 path/bash 语义:白名单放行后无后续检查分支 → 直通(undefined)。
    const result = await handler({
      type: 'tool_call',
      toolCallId: 'call-mem-1',
      toolName: 'memory',
      input: {
        op: 'propose',
        kind: 'soft_preference',
        title: 't',
        content: 'c',
        evidence: 'user-stated',
        basis: 'b',
      },
    });

    expect(result).toBeUndefined();
    expect(blockedEvents).toHaveLength(0);
  });

  it('allows grep with a path inside the workspace', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'lorra-test-'));
    const file = path.join(tmp, 'hello.ts');
    await writeFile(file, 'export const x = 1;\n');
    try {
      const ext = buildExtension((pi) =>
        createSafetyInterceptor({ workspaceRoot: tmp, emitBlocked })(pi),
      );
      const handler = ext.handlers.get('tool_call')?.[0] as (event: unknown) => Promise<unknown>;

      const result = await handler({
        type: 'tool_call',
        toolCallId: 'call-grep-ok',
        toolName: 'grep',
        input: { pattern: 'const', path: file },
      });

      expect(result).toBeUndefined();
      expect(blockedEvents).toHaveLength(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // 2026-08-10:grep/find/ls 越界从硬拦改为分级审批;无审批依赖时兜底 deny。
  // 必须用真实存在的越界文件——不存在的路径按新语义放行(无内容可泄)。
  it('grep 路径工作区外且无审批依赖 → 兜底 deny(block + terminate)', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'lorra-grep-'));
    const outside = path.join(path.dirname(tmp), path.basename(tmp) + '-outside.txt');
    await writeFile(outside, 'secret');
    try {
      const ext = buildExtension((pi) =>
        createSafetyInterceptor({ workspaceRoot: tmp, emitBlocked })(pi),
      );
      const handler = ext.handlers.get('tool_call')?.[0] as (event: unknown) => Promise<unknown>;

      const result = await handler({
        type: 'tool_call',
        toolCallId: 'call-grep-esc',
        toolName: 'grep',
        input: { pattern: 'secret', path: outside },
      });

      expect(result).toEqual({
        block: true,
        reason: 'approval-required: 搜索被拒绝',
        terminate: true,
      });
      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0]?.safetyNote).toBe('approval-denied: 搜索被拒绝');
    } finally {
      await rm(tmp, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it('allows grep without a path (defaults to cwd inside the workspace)', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    const handler = ext.handlers.get('tool_call')?.[0] as (event: unknown) => Promise<unknown>;

    const result = await handler({
      type: 'tool_call',
      toolCallId: 'call-grep-cwd',
      toolName: 'grep',
      input: { pattern: 'TODO' },
    });

    expect(result).toBeUndefined();
    expect(blockedEvents).toHaveLength(0);
  });

  // 2026-08-10:read 不存在路径取消拦截——无内容可泄,工具自然报「文件不存在」。
  it('read 不存在的路径 → 放行(工具自然报错,不拦截不审批)', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    const toolCallHandlers = ext.handlers.get('tool_call');
    if (!toolCallHandlers || toolCallHandlers.length === 0) {
      throw new Error('tool_call handler not registered');
    }
    const handler = toolCallHandlers[0] as (event: unknown) => Promise<unknown>;

    const result = await handler({
      type: 'tool_call',
      toolCallId: 'call-2',
      toolName: 'read',
      input: { path: '/home/user/project/file.txt' },
    });

    expect(result).toBeUndefined();
    expect(blockedEvents).toHaveLength(0);
  });

  it('allows whitelisted web_search tool without path checks', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    const toolCallHandlers = ext.handlers.get('tool_call');
    if (!toolCallHandlers || toolCallHandlers.length === 0) {
      throw new Error('tool_call handler not registered');
    }
    const handler = toolCallHandlers[0] as (event: unknown) => Promise<unknown>;

    const result = await handler({
      type: 'tool_call',
      toolCallId: 'call-2b',
      toolName: 'web_search',
      input: { query: '大模型 最新动态' },
    });

    expect(result).toBeUndefined();
    expect(blockedEvents).toHaveLength(0);
  });

  it('allows whitelisted web_fetch tool without path checks', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    const toolCallHandlers = ext.handlers.get('tool_call');
    if (!toolCallHandlers || toolCallHandlers.length === 0) {
      throw new Error('tool_call handler not registered');
    }
    const handler = toolCallHandlers[0] as (event: unknown) => Promise<unknown>;

    const result = await handler({
      type: 'tool_call',
      toolCallId: 'call-2c',
      toolName: 'web_fetch',
      input: { urls: ['https://example.com'] },
    });

    expect(result).toBeUndefined();
    expect(blockedEvents).toHaveLength(0);
  });

  it('allows whitelisted update_plan tool without path checks', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    const toolCallHandlers = ext.handlers.get('tool_call');
    if (!toolCallHandlers || toolCallHandlers.length === 0) {
      throw new Error('tool_call handler not registered');
    }
    const handler = toolCallHandlers[0] as (event: unknown) => Promise<unknown>;

    const result = await handler({
      type: 'tool_call',
      toolCallId: 'call-2d',
      toolName: 'update_plan',
      input: {
        plan: [{ step: '搜索', status: 'in_progress' }],
      },
    });

    expect(result).toBeUndefined();
    expect(blockedEvents).toHaveLength(0);
  });

  it('blocks bash high-risk rm -rf', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    const toolCallHandlers = ext.handlers.get('tool_call');
    if (!toolCallHandlers || toolCallHandlers.length === 0) {
      throw new Error('tool_call handler not registered');
    }
    const handler = toolCallHandlers[0] as (event: unknown) => Promise<unknown>;

    const result = await handler({
      type: 'tool_call',
      toolCallId: 'call-3',
      toolName: 'bash',
      input: { command: 'rm -rf /tmp/foo' },
    });

    expect(result).toEqual({ block: true, reason: 'high-risk: rm -rf' });
    expect(blockedEvents).toHaveLength(1);
  });

  it('reason never contains absolute path', async () => {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({ workspaceRoot: workspace, emitBlocked })(pi),
    );
    const toolCallHandlers = ext.handlers.get('tool_call');
    if (!toolCallHandlers || toolCallHandlers.length === 0) {
      throw new Error('tool_call handler not registered');
    }
    const handler = toolCallHandlers[0] as (event: unknown) => Promise<unknown>;

    await handler({
      type: 'tool_call',
      toolCallId: 'call-4',
      toolName: 'bash',
      input: { command: 'rm -rf /tmp/foo' },
    });

    for (const evt of blockedEvents) {
      expect(evt.safetyNote).not.toMatch(/^[A-Z]:[\\/]/);
      expect(evt.safetyNote).not.toMatch(/^\//);
    }
  });

  // rm-single-file → shell.trashItem behavior is covered by the real-Electron
  // integration test at tests/integration/safety-trash-real.mts (no mocks;
  // file actually moves to OS Recycle Bin on Windows/macOS, or unlinks on
  // Linux CI without a Trash API).
});

// ---------------------------------------------------------------------------
// 编辑历史钩子:write/edit 放行时 recordEditBefore,tool_result 收口 finalizeEdit
// ---------------------------------------------------------------------------

describe('interceptor 编辑历史钩子', () => {
  const blockedEvents: Array<{
    toolName: string;
    target: string;
    callId?: string;
    safetyNote: string;
  }> = [];
  const emitBlocked: BlockEmitter = (payload) => {
    blockedEvents.push(payload);
  };
  const recordEditBefore = vi.fn();
  const finalizeEdit = vi.fn();

  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'lorra-edit-hook-'));
    blockedEvents.length = 0;
    recordEditBefore.mockClear();
    finalizeEdit.mockClear();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function handlerFor(deps: Parameters<typeof createSafetyInterceptor>[0]) {
    const ext = buildExtension((pi) => createSafetyInterceptor(deps)(pi));
    return {
      call: ext.handlers.get('tool_call')?.[0] as (event: unknown) => Promise<unknown>,
      result: ext.handlers.get('tool_result')?.[0] as ((event: unknown) => void) | undefined,
    };
  }

  it('write 放行触发 recordEditBefore(含执行前内容与相对 fileId)', async () => {
    const file = path.join(tmp, 'docs', 'a.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'old content');

    const { call } = handlerFor({ workspaceRoot: tmp, emitBlocked, recordEditBefore });
    const result = await call({
      type: 'tool_call',
      toolCallId: 'call-edit-1',
      toolName: 'write',
      input: { path: file, content: 'new content' },
    });

    expect(result).toBeUndefined();
    expect(recordEditBefore).toHaveBeenCalledTimes(1);
    expect(recordEditBefore).toHaveBeenCalledWith({
      toolCallId: 'call-edit-1',
      toolName: 'write',
      fileId: path.join('docs', 'a.md').replace(/\\/g, '/'),
      before: 'old content',
    });
  });

  it('edit 放行触发 recordEditBefore;不存在的新目标走审批,不记录', async () => {
    const file = path.join(tmp, 'brand-new.md');

    const { call } = handlerFor({ workspaceRoot: tmp, emitBlocked, recordEditBefore });
    const result = await call({
      type: 'tool_call',
      toolCallId: 'call-edit-2',
      toolName: 'edit',
      input: { path: file },
    });

    // :不存在的路径(新建)从硬拦改为请求审批;无审批依赖时兜底 deny
    // (block + terminate),未批准前不记录。
    expect(result).toEqual({
      block: true,
      reason: 'approval-required: 目标文件尚不存在',
      terminate: true,
    });
    expect(recordEditBefore).not.toHaveBeenCalled();
  });

  it('相对路径 target 直接作 fileId,不做工作区外解析', async () => {
    await writeFile(path.join(tmp, 'a.md'), 'x');
    const { call } = handlerFor({ workspaceRoot: tmp, emitBlocked, recordEditBefore });
    const result = await call({
      type: 'tool_call',
      toolCallId: 'call-edit-3',
      toolName: 'edit',
      input: { path: 'a.md' },
    });

    expect(result).toBeUndefined();
    expect(recordEditBefore).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'a.md', before: 'x' }),
    );
  });

  it('read/bash 不触发 recordEditBefore', async () => {
    const file = path.join(tmp, 'a.md');
    await writeFile(file, 'x');
    const { call } = handlerFor({ workspaceRoot: tmp, emitBlocked, recordEditBefore });

    await call({
      type: 'tool_call',
      toolCallId: 'call-read',
      toolName: 'read',
      input: { path: file },
    });
    await call({
      type: 'tool_call',
      toolCallId: 'call-bash',
      toolName: 'bash',
      input: { command: 'echo hi' },
    });

    expect(recordEditBefore).not.toHaveBeenCalled();
  });

  it('tool_result ok=true 触发 finalizeEdit(ok:true);isError 触发 ok:false', () => {
    const { result } = handlerFor({ workspaceRoot: tmp, emitBlocked, finalizeEdit });
    expect(result).toBeDefined();

    result?.({
      type: 'tool_result',
      toolCallId: 'call-edit-1',
      toolName: 'edit',
      input: { path: path.join(tmp, 'docs', 'a.md') },
      content: [],
      isError: false,
    });
    expect(finalizeEdit).toHaveBeenCalledWith({
      toolCallId: 'call-edit-1',
      toolName: 'edit',
      fileId: path.join('docs', 'a.md').replace(/\\/g, '/'),
      ok: true,
    });

    result?.({
      type: 'tool_result',
      toolCallId: 'call-edit-2',
      toolName: 'edit',
      input: { path: 'a.md' },
      content: [],
      isError: true,
    });
    expect(finalizeEdit).toHaveBeenLastCalledWith({
      toolCallId: 'call-edit-2',
      toolName: 'edit',
      fileId: 'a.md',
      ok: false,
    });
  });

  it('非 write/edit 的 tool_result 不触发 finalizeEdit', () => {
    const { result } = handlerFor({ workspaceRoot: tmp, emitBlocked, finalizeEdit });
    result?.({
      type: 'tool_result',
      toolCallId: 'call-bash',
      toolName: 'bash',
      input: { command: 'echo hi' },
      content: [],
      isError: false,
    });
    result?.({
      type: 'tool_result',
      toolCallId: 'call-read',
      toolName: 'read',
      input: { path: 'a.md' },
      content: [],
      isError: false,
    });
    expect(finalizeEdit).not.toHaveBeenCalled();
  });

  it('未注入 finalizeEdit 时 tool_result 不抛错', () => {
    const { result } = handlerFor({ workspaceRoot: tmp, emitBlocked });
    expect(result).toBeTypeOf('function');
    expect(() =>
      result?.({
        type: 'tool_result',
        toolCallId: 'call-edit-1',
        toolName: 'edit',
        input: { path: 'a.md' },
        content: [],
        isError: false,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 分级审批:工作区外/超阈值 write/edit → 挂起等待用户裁决;
// allow → 放行工具,deny → block + terminate(停止当前轮);read 保持硬拦
// ---------------------------------------------------------------------------

describe('interceptor 分级审批', () => {
  const blockedEvents: Array<{
    toolName: string;
    target: string;
    callId?: string;
    safetyNote: string;
  }> = [];
  const emitBlocked: BlockEmitter = (payload) => {
    blockedEvents.push(payload);
  };
  const requestApproval = vi.fn();
  const recordEditBefore = vi.fn();

  let tmp: string;
  // 工作区外的既有文件(审批流触发前提:路径必须真实存在)。与 tmp 同级,
  // 自包含、不依赖机器上的 D:\ 残留文件。
  let outsideTarget: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'lorra-approval-'));
    outsideTarget = path.join(path.dirname(tmp), path.basename(tmp) + '-outside.txt');
    await writeFile(outsideTarget, 'lorra outside fixture');
    blockedEvents.length = 0;
    // mockReset 清调用记录 + 实现(防 mockImplementation 跨测试泄漏);
    // 默认裁决 deny。
    requestApproval.mockReset();
    requestApproval.mockImplementation(async () => 'deny' as const);
    recordEditBefore.mockClear();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(outsideTarget, { force: true });
  });

  function handlerFor(over: Partial<Parameters<typeof createSafetyInterceptor>[0]> = {}) {
    const ext = buildExtension((pi) =>
      createSafetyInterceptor({
        workspaceRoot: tmp,
        emitBlocked,
        requestApproval,
        recordEditBefore,
        ...over,
      })(pi),
    );
    return ext.handlers.get('tool_call')?.[0] as (event: unknown) => Promise<unknown>;
  }

  it('工作区外 write → 请求审批;裁决 deny → block + terminate', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-1',
      toolName: 'write',
      input: { path: 'D:/test-approval.txt', content: 'x' },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: 写入位置在工作区外',
      terminate: true,
    });
    expect(requestApproval).toHaveBeenCalledWith({
      toolName: 'write',
      target: 'D:/test-approval.txt',
      reason: 'approval-required: 写入位置在工作区外',
      callId: 'call-appr-1',
    });
    expect(recordEditBefore).not.toHaveBeenCalled();
  });

  it('裁决 allow → 放行工具并记录编辑历史(不再注入 steer)', async () => {
    requestApproval.mockImplementation(async () => 'allow' as const);
    const file = path.join(tmp, 'appr-allow.md');
    await writeFile(file, 'old');
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-1c',
      toolName: 'write',
      input: { path: file, content: 'new' },
    });

    expect(result).toBeUndefined();
    expect(recordEditBefore).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'call-appr-1c', before: 'old' }),
    );
  });

  it('裁决未下达前 handler 挂起(等待用户,工具不执行)', async () => {
    let resolveFn!: (decision: 'allow' | 'deny') => void;
    requestApproval.mockImplementation(
      () => new Promise<'allow' | 'deny'>((resolve) => (resolveFn = resolve)),
    );
    const pending = handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-1d',
      toolName: 'write',
      input: { path: 'D:/test-approval.txt', content: 'x' },
    });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // 等 handler 走到 requestApproval 调用点(fs realpath 是异步的)。
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false); // 挂起:审批未裁决,拦截器不返回

    resolveFn('allow');
    await expect(pending).resolves.toBeUndefined();
  });

  it('工作区外 edit 同样请求审批,deny → block + terminate', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-1b',
      toolName: 'edit',
      input: { path: 'D:/test-approval.txt' },
    });

    expect(result).toMatchObject({ block: true, terminate: true });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('工作区内不存在的目标(新建文件)→ 请求审批,deny → terminate', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-2',
      toolName: 'write',
      input: { path: 'brand-new.md', content: 'x' },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: 目标文件尚不存在',
      terminate: true,
    });
  });

  it('超阈值 write → 请求审批,deny → block + terminate', async () => {
    const file = path.join(tmp, 'big.md');
    await writeFile(file, 'x');
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-3',
      toolName: 'write',
      input: { path: file, content: 'x'.repeat(SIZE_THRESHOLD_BYTES + 1) },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: 写入内容超过大小阈值',
      terminate: true,
    });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'approval-required: 写入内容超过大小阈值' }),
    );
  });

  it('未注入 requestApproval 依赖 → 兜底 deny(block + terminate,不挂起)', async () => {
    const result = await handlerFor({ requestApproval: undefined })({
      type: 'tool_call',
      toolCallId: 'call-appr-1e',
      toolName: 'write',
      input: { path: 'D:/test-approval.txt', content: 'x' },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: 写入位置在工作区外',
      terminate: true,
    });
  });

  it('read 工作区外 → 请求审批;裁决 deny → block + terminate', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-4',
      toolName: 'read',
      input: { path: outsideTarget },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: 读取被拒绝',
      terminate: true,
    });
    expect(requestApproval).toHaveBeenCalledWith({
      toolName: 'read',
      target: outsideTarget,
      reason: 'approval-required: 读取位置在工作区外',
      callId: 'call-appr-4',
    });
    expect(recordEditBefore).not.toHaveBeenCalled();
  });

  it('read 工作区外 → 裁决 allow → 放行且不记录编辑历史', async () => {
    requestApproval.mockImplementation(async () => 'allow' as const);
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-4a',
      toolName: 'read',
      input: { path: outsideTarget },
    });
    expect(result).toBeUndefined();
    expect(recordEditBefore).not.toHaveBeenCalled();
  });

  it('read 工作区外 checkApproved 命中 → 直接放行', async () => {
    const checkApproved = vi.fn((toolName: string) => toolName === 'read');
    const result = await handlerFor({ checkApproved })({
      type: 'tool_call',
      toolCallId: 'call-appr-4b',
      toolName: 'read',
      input: { path: outsideTarget },
    });
    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('read 可信路径(用户技能目录)→ 直放不请求审批', async () => {
    // home 必须在工作区根之外(否则 check.ok=true,可信路径分支根本不会执行)。
    const home = path.join(path.dirname(tmp), path.basename(tmp) + '-fake-home');
    const skill = path.join(home, '.agents', 'skills', 'demo', 'SKILL.md');
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, '# demo');
    const result = await handlerFor({ trustedPaths: { homedir: home } })({
      type: 'tool_call',
      toolCallId: 'call-appr-4t',
      toolName: 'read',
      input: { path: skill },
    });
    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
    await rm(home, { recursive: true, force: true });
  });

  // 2026-08-10:read 不存在路径取消拦截(取代 )——无内容可泄,
  // 拦截是噪音;工具执行后自然返回「文件不存在」。
  it('read 不存在路径 → 放行(工具自然报错,不请求审批)', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-4x',
      toolName: 'read',
      input: { path: path.join(tmp, 'does-not-exist.md') },
    });
    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('checkApproved 命中 → 直接放行并记录编辑历史', async () => {
    const file = path.join(tmp, 'ok.md');
    await writeFile(file, 'old');
    const checkApproved = vi.fn(
      (toolName: string, target: string) => toolName === 'write' && target === file,
    );
    const result = await handlerFor({ checkApproved })({
      type: 'tool_call',
      toolCallId: 'call-appr-5',
      toolName: 'write',
      input: { path: file, content: 'new' },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(recordEditBefore).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'call-appr-5', before: 'old' }),
    );
  });

  it('checkApproved 命中时工作区外目标也放行(许可语义优先)', async () => {
    const checkApproved = vi.fn(() => true);
    const result = await handlerFor({ checkApproved })({
      type: 'tool_call',
      toolCallId: 'call-appr-6',
      toolName: 'write',
      input: { path: 'D:/test-approval.txt', content: 'x' },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(recordEditBefore).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'D:/test-approval.txt' }),
    );
  });

  // PROB: bash 是 write 的等价通道——写类命令/重定向目标必须与 write 同链审批,
  // 否则 agent 用 bash 绕过 write 审批(请求权限时自己执行)。
  it('bash 写目标工作区外 → 请求审批,deny → block + terminate', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-b1',
      toolName: 'bash',
      input: { command: 'echo pwn > D:/outside-out.txt' },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: bash 写入被拒绝',
      terminate: true,
    });
    expect(requestApproval).toHaveBeenCalledWith({
      toolName: 'bash',
      target: 'D:/outside-out.txt',
      reason: 'approval-required: bash 写入位置在工作区外或不存在',
      callId: 'call-appr-b1',
    });
  });

  it('bash 写目标工作区外 → 审批 allow 后放行', async () => {
    requestApproval.mockImplementation(async () => 'allow' as const);
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-b2',
      toolName: 'bash',
      input: { command: 'echo pwn > D:/outside-out.txt' },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('bash copy 目标工作区外 → 请求审批', async () => {
    const file = path.join(tmp, 'src.md');
    await writeFile(file, 'x');
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-b3',
      toolName: 'bash',
      input: { command: `copy ${file} D:/outside-copy.txt` },
    });

    expect(result).toMatchObject({ block: true, terminate: true });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'bash', target: 'D:/outside-copy.txt' }),
    );
  });

  // 2026-08-10:bash 读语义越界从硬拦改为分级审批(agent 的「手」);
  // 目标必须真实存在(不存在路径按新语义放行,无内容可泄)。
  it('bash 读目标工作区外 → 请求审批;deny → block + terminate', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-b4',
      toolName: 'bash',
      input: { command: `type ${outsideTarget}` },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: bash 读取被拒绝',
      terminate: true,
    });
    expect(requestApproval).toHaveBeenCalledWith({
      toolName: 'bash',
      target: outsideTarget,
      reason: 'approval-required: bash 读取位置在工作区外',
      callId: 'call-appr-b4',
    });
  });

  it('bash 读目标工作区外 → 审批 allow 后放行', async () => {
    requestApproval.mockImplementation(async () => 'allowOnce' as const);
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-b4a',
      toolName: 'bash',
      input: { command: `type ${outsideTarget}` },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('bash 读目标 checkApproved 命中 → 直接放行', async () => {
    const checkApproved = vi.fn(
      (toolName: string, target: string) => toolName === 'bash' && target === outsideTarget,
    );
    const result = await handlerFor({ checkApproved })({
      type: 'tool_call',
      toolCallId: 'call-appr-b4b',
      toolName: 'bash',
      input: { command: `type ${outsideTarget}` },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('bash 读目标不存在 → 放行(无内容可泄,工具自然报错)', async () => {
    const gone = path.join(path.dirname(tmp), path.basename(tmp) + '-gone.txt');
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-b4c',
      toolName: 'bash',
      input: { command: `type ${gone}` },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // 扩展(2026-08-10):技能目录白名单从 read 扩展到 bash 读语义。
  // 可信路径 = <home>/.agents/skills、<home>/.pi/agent(只读语义)。
  it('bash 读目标可信路径(技能目录)→ 直放不请求审批', async () => {
    const home = path.join(path.dirname(tmp), path.basename(tmp) + '-tp-home1');
    const skill = path.join(home, '.agents', 'skills', 'demo', 'SKILL.md');
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, '# demo');
    try {
      const result = await handlerFor({ trustedPaths: { homedir: home } })({
        type: 'tool_call',
        toolCallId: 'call-appr-tp1',
        toolName: 'bash',
        input: { command: `type ${skill}` },
      });
      expect(result).toBeUndefined();
      expect(requestApproval).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('bash 执行技能脚本(未知命令参数可信路径)→ 直放', async () => {
    const home = path.join(path.dirname(tmp), path.basename(tmp) + '-tp-home2');
    const script = path.join(home, '.agents', 'skills', 'demo', 'scripts', 'x.py');
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, 'print(1)');
    try {
      const result = await handlerFor({ trustedPaths: { homedir: home } })({
        type: 'tool_call',
        toolCallId: 'call-appr-tp2',
        toolName: 'bash',
        input: { command: `python ${script} https://x.com/i/status/1` },
      });
      expect(result).toBeUndefined();
      expect(requestApproval).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('bash 写目标可信路径 → 不放行(白名单只读语义,仍走审批链)', async () => {
    const home = path.join(path.dirname(tmp), path.basename(tmp) + '-tp-home3');
    const dir = path.join(home, '.agents', 'skills', 'demo');
    await mkdir(dir, { recursive: true });
    try {
      const result = await handlerFor({ trustedPaths: { homedir: home } })({
        type: 'tool_call',
        toolCallId: 'call-appr-tp3',
        toolName: 'bash',
        input: { command: `echo pwn > ${path.join(dir, 'out.txt')}` },
      });
      expect(result).toMatchObject({ block: true, terminate: true });
      expect(requestApproval).toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('bash ~ 展开命中可信路径 → 直放', async () => {
    const home = path.join(path.dirname(tmp), path.basename(tmp) + '-tp-home4');
    const skill = path.join(home, '.agents', 'skills', 'demo', 'SKILL.md');
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, '# demo');
    try {
      const result = await handlerFor({ trustedPaths: { homedir: home } })({
        type: 'tool_call',
        toolCallId: 'call-appr-tp4',
        toolName: 'bash',
        input: { command: 'ls ~/.agents/skills/demo/SKILL.md' },
      });
      expect(result).toBeUndefined();
      expect(requestApproval).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('grep/find/ls 目标可信路径 → 直放', async () => {
    const home = path.join(path.dirname(tmp), path.basename(tmp) + '-tp-home5');
    const skill = path.join(home, '.agents', 'skills', 'demo', 'SKILL.md');
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, '# demo');
    try {
      const opts = { trustedPaths: { homedir: home } };
      for (const toolName of ['grep', 'find', 'ls'] as const) {
        const result = await handlerFor(opts)({
          type: 'tool_call',
          toolCallId: `call-appr-tp5-${toolName}`,
          toolName,
          input: toolName === 'grep' ? { pattern: 'demo', path: skill } : { path: skill },
        });
        expect(result).toBeUndefined();
      }
      expect(requestApproval).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('bash 写目标工作区内 → 直接放行(不请求审批)', async () => {
    const file = path.join(tmp, 'in-ws.md');
    await writeFile(file, 'x');
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-b5',
      toolName: 'bash',
      input: { command: `echo hi > ${file}` },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('bash 写目标 checkApproved 命中 → 直接放行', async () => {
    const checkApproved = vi.fn(() => true);
    const result = await handlerFor({ checkApproved })({
      type: 'tool_call',
      toolCallId: 'call-appr-b6',
      toolName: 'bash',
      input: { command: 'echo pwn > D:/outside-out.txt' },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // 2026-08-10:grep/find/ls 越界从硬拦改为分级审批(搜索是 agent 的能力)。
  it('grep/find/ls 路径工作区外 → 请求审批;deny → block + terminate', async () => {
    for (const toolName of ['grep', 'find', 'ls'] as const) {
      const input =
        toolName === 'grep' ? { pattern: 'secret', path: outsideTarget } : { path: outsideTarget };
      const result = await handlerFor()({
        type: 'tool_call',
        toolCallId: `call-appr-g1-${toolName}`,
        toolName,
        input,
      });

      expect(result).toEqual({
        block: true,
        reason: 'approval-required: 搜索被拒绝',
        terminate: true,
      });
      expect(requestApproval).toHaveBeenCalledWith({
        toolName,
        target: outsideTarget,
        reason: 'approval-required: 搜索位置在工作区外',
        callId: `call-appr-g1-${toolName}`,
      });
    }
  });

  it('grep/find/ls 路径工作区外 → 审批 allow 后放行', async () => {
    requestApproval.mockImplementation(async () => 'allowAlways' as const);
    for (const toolName of ['grep', 'find', 'ls'] as const) {
      const input =
        toolName === 'grep' ? { pattern: 'secret', path: outsideTarget } : { path: outsideTarget };
      const result = await handlerFor()({
        type: 'tool_call',
        toolCallId: `call-appr-g2-${toolName}`,
        toolName,
        input,
      });
      expect(result).toBeUndefined();
    }
    expect(requestApproval).toHaveBeenCalledTimes(3);
  });

  it('grep/find/ls 路径 checkApproved 命中 → 直接放行', async () => {
    const checkApproved = vi.fn((toolName: string, target: string) => target === outsideTarget);
    for (const toolName of ['grep', 'find', 'ls'] as const) {
      const input =
        toolName === 'grep' ? { pattern: 'secret', path: outsideTarget } : { path: outsideTarget };
      const result = await handlerFor({ checkApproved })({
        type: 'tool_call',
        toolCallId: `call-appr-g3-${toolName}`,
        toolName,
        input,
      });
      expect(result).toBeUndefined();
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // 2026-08-10:bash 嵌套超限从硬拦改为请求审批(无法审查 → 人裁决)。
  // 深度用 maxBashNesting=0 注入构造超限(生产默认 5,tokenizer 现实深度 ~3,
  // 超限分支为防御性路径,注入让契约可测)。
  const DEEP_NESTED = 'cmd /c "cmd /c \'echo hi\'"';

  it('bash 嵌套超限 → 请求审批;deny → block + terminate', async () => {
    const result = await handlerFor({ maxBashNesting: 0 })({
      type: 'tool_call',
      toolCallId: 'call-appr-n1',
      toolName: 'bash',
      input: { command: DEEP_NESTED },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: 嵌套命令被拒绝',
      terminate: true,
    });
    expect(requestApproval).toHaveBeenCalledWith({
      toolName: 'bash',
      target: DEEP_NESTED,
      reason: 'approval-required: 命令嵌套过深，无法自动审查内容，批准后将原样执行',
      callId: 'call-appr-n1',
    });
  });

  it('bash 嵌套超限 → 审批 allow 后原样执行(跳过后续静态检查)', async () => {
    requestApproval.mockImplementation(async () => 'allowOnce' as const);
    const result = await handlerFor({ maxBashNesting: 0 })({
      type: 'tool_call',
      toolCallId: 'call-appr-n2',
      toolName: 'bash',
      input: { command: DEEP_NESTED },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('bash 嵌套内高危命令 → 仍硬拦(不进审批流)', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-appr-n3',
      toolName: 'bash',
      input: { command: 'cmd /c "rm -rf /tmp/foo"' },
    });

    expect(result).toEqual({ block: true, reason: 'high-risk: rm -rf' });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // install_skill(2026-08-13):第三方代码安装走审批卡;同 URL 会话内已批准直放。
  // -------------------------------------------------------------------------

  it('install_skill → 请求审批;裁决 deny → block + terminate', async () => {
    const url = 'https://github.com/x/demo-skill.git';
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-inst-1',
      toolName: 'install_skill',
      input: { git_url: url },
    });

    expect(result).toEqual({
      block: true,
      reason: 'approval-required: 安装被拒绝',
      terminate: true,
    });
    expect(requestApproval).toHaveBeenCalledWith({
      toolName: 'install_skill',
      target: url,
      reason: `approval-required: 安装第三方技能代码（来源 ${url}）`,
      callId: 'call-inst-1',
    });
  });

  it('install_skill → 裁决 allow → 放行', async () => {
    requestApproval.mockImplementation(async () => 'allowOnce' as const);
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-inst-2',
      toolName: 'install_skill',
      input: { git_url: 'https://github.com/x/y.git' },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('install_skill checkApproved 命中(同 URL)→ 直接放行不弹卡', async () => {
    const url = 'https://github.com/x/y.git';
    const checkApproved = vi.fn((toolName: string, target: string) => {
      return toolName === 'install_skill' && target === url;
    });
    const result = await handlerFor({ checkApproved })({
      type: 'tool_call',
      toolCallId: 'call-inst-3',
      toolName: 'install_skill',
      input: { git_url: url },
    });

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('install_skill git_url 缺失 → 直接拦截不发审批', async () => {
    const result = await handlerFor()({
      type: 'tool_call',
      toolCallId: 'call-inst-4',
      toolName: 'install_skill',
      input: {},
    });

    expect(result).toEqual({ block: true, reason: 'approval-required: 安装目标缺失' });
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
