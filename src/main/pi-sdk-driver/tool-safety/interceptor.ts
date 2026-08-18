import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionFactory as SdkExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { shell } from 'electron';
import { MEMORY_TOOL_NAME } from '../../memory/propose-memory-tool';
import { KNOWLEDGE_TOOL_NAME } from '../../ofk/knowledge-tool';
import type { BlockEmitter } from '../driver';
import { SKILL_INSTALL_TOOL_NAME } from '../skill-tools/install-skill-tool';
import { extractBashArgPaths } from './bash-arg-paths';
import { classifyBashIo } from './bash-io';
import { normalizeBash } from './bash-parser';
import { classifyHighRisk } from './high-risk-cmd';
import { resolveAndCheck } from './path-check';
import { checkWriteSize } from './size-threshold';
import { isTrustedReadPath, type TrustedPathsOpts } from './trusted-paths';

const WHITELIST = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'web_search',
  'web_fetch',
  'update_plan',
  // :memory 工具是 agent 的双手(propose/update/retire/search),
  // 不触工作区文件系统——放行(后续无 path/bash 检查分支,即直通)。
  MEMORY_TOOL_NAME,
  // 技能安装走审批卡(Step 1.5 分支),不放行直通。
  SKILL_INSTALL_TOOL_NAME,
  // :knowledge 工具只写 ~/.lorra/knowledge,不触工作区——放行直通
  // (与 MEMORY_TOOL_NAME 同理由)。
  KNOWLEDGE_TOOL_NAME,
]);

export interface SafetyInterceptorDeps {
  workspaceRoot: string;
  emitBlocked: BlockEmitter;
  /** write/edit 放行时记录执行前内容(编辑历史 )。 */
  recordEditBefore?: (payload: {
    toolCallId: string;
    toolName: 'write' | 'edit';
    fileId: string;
    before: string;
  }) => void;
  /** tool_result 到达时收口编辑记录(ok=false 的调用不落盘)。 */
  finalizeEdit?: (payload: {
    toolCallId: string;
    toolName: string;
    fileId: string;
    ok: boolean;
  }) => void;
  /**
 * write/edit 需审批时请求用户许可;返回的 Promise 由用户裁决 resolve:
 * allow → 放行工具,deny → 拦截器返回 block + terminate(停止当前轮)。
 */
  requestApproval?: (payload: {
    toolName: string;
    target: string;
    reason: string;
    callId?: string;
  }) => Promise<'allowOnce' | 'allowAlways' | 'deny'>;
  /** 会话内已批准的 (toolName, target) 直接放行。 */
  checkApproved?: (toolName: string, target: string) => boolean;
  /** 可信读取路径注入(测试用);缺省 os.homedir。 */
  trustedPaths?: TrustedPathsOpts;
  /**
 * bash 嵌套执行器深度上限注入(测试用);缺省 MAX_BASH_NESTING。
 * 嵌套超限 = 无法静态审查 → 走审批卡(批准后原样执行),不是硬拦。
 */
  maxBashNesting?: number;
}

/**
 * Returns an SDK `ExtensionFactory` function (pi) => void. The caller
 * passes it to `loadExtensionFromFactory` which binds the `pi.on(...)`
 * handlers onto the runtime; from that point on `tool_call` events fire
 * into our handlers before each tool execution.
 *
 * Per / spec tool-safety-interceptor: default-deny, no
 * try/catch swallowing — any exception in the chain returns `{block:true}`
 * via the SDK's runOnError path.
 */
export const createSafetyInterceptor =
  (deps: SafetyInterceptorDeps): SdkExtensionFactory =>
  (pi: ExtensionAPI): void => {
    pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
      const toolName = event.toolName;

      // 放行 write/edit:记录执行前内容(编辑历史 )。新建文件 → 空串;
      // fileId 统一为相对工作区路径(/ 分隔),与渲染端文件胶囊一致。
      async function allowWriteEdit(
        ev: ToolCallEvent,
        name: string,
        targetPath: string,
      ): Promise<undefined> {
        const abs = path.resolve(deps.workspaceRoot, targetPath);
        let before = '';
        try {
          before = await readFile(abs, 'utf8');
        } catch {
          before = '';
        }
        const rel = path.isAbsolute(targetPath)
          ? path.relative(deps.workspaceRoot, abs)
          : targetPath;
        deps.recordEditBefore?.({
          toolCallId: ev.toolCallId,
          toolName: name as 'write' | 'edit',
          fileId: rel.replace(/\\/g, '/'),
          before,
        });
        return undefined;
      }

      // Step 1: tool whitelist。MCP 工具（mcp_ 前缀，动态名）按前缀放行 + 审批卡。
      const isMcpTool = toolName.startsWith('mcp_');
      if (!WHITELIST.has(toolName) && !isMcpTool) {
        const reason = 'tool-not-allowed';
        deps.emitBlocked({ toolName, target: '', callId: event.toolCallId, safetyNote: reason });
        return { block: true, reason };
      }

      // Step 1.5: install_skill → 第三方代码安装走审批卡(供应链风险,2026-08-13)。
      // 与 write 同链:会话内已批准同 URL 直放;deny → block + terminate。
      if (toolName === SKILL_INSTALL_TOOL_NAME) {
        const input = event.input as { git_url?: unknown };
        const target = typeof input?.git_url === 'string' ? input.git_url : '';
        if (target === '') {
          const reason = 'approval-required: 安装目标缺失';
          deps.emitBlocked({ toolName, target, callId: event.toolCallId, safetyNote: reason });
          return { block: true, reason };
        }
        if (deps.checkApproved?.(toolName, target)) return undefined;
        const decision =
          (await deps.requestApproval?.({
            toolName,
            target,
            reason: `approval-required: 安装第三方技能代码（来源 ${target}）`,
            callId: event.toolCallId,
          })) ?? 'deny';
        if (decision === 'deny') {
          deps.emitBlocked({
            toolName,
            target,
            callId: event.toolCallId,
            safetyNote: 'approval-denied: 安装被拒绝',
          });
          return { block: true, reason: 'approval-required: 安装被拒绝', terminate: true };
        }
        return undefined;
      }

      // Step 1.6: MCP 工具（mcp_ 前缀，plan S3）→ 首次调用走审批卡。
      // 会话内同 (toolName, 工具名) 已批准直放（与 install_skill/write 同链）。
      if (isMcpTool) {
        if (deps.checkApproved?.(toolName, toolName)) return undefined;
        const decision =
          (await deps.requestApproval?.({
            toolName,
            target: toolName,
            reason: 'approval-required: 调用 MCP 工具 ' + toolName,
            callId: event.toolCallId,
          })) ?? 'deny';
        if (decision === 'deny') {
          deps.emitBlocked({
            toolName,
            target: toolName,
            callId: event.toolCallId,
            safetyNote: 'approval-denied: MCP 工具调用被拒绝',
          });
          return { block: true, reason: 'approval-required: MCP 工具调用被拒绝', terminate: true };
        }
        return undefined;
      }

      // Step 2: read/write/edit → path-check + (write/edit only) size threshold
      if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
        const input = event.input as { path?: unknown; content?: unknown };
        const target = typeof input?.path === 'string' ? input.path : '';
        if (!target) {
          const reason = 'path-out-of-workspace';
          deps.emitBlocked({ toolName, target, callId: event.toolCallId, safetyNote: reason });
          return { block: true, reason };
        }

        // 分级审批:write/edit 在工作区外/超阈值/目标不存在时挂起等待
        // 用户裁决。allow → 放行工具执行;deny → block + terminate(0.84.1:
        // 停止当前轮,不再让模型自行重试)。read 同链审批(越界读
        // 可裁决、可信路径直放、不存在路径硬拦)。
        const needApprovalFor = async (reason: string) => {
          if (deps.checkApproved?.(toolName, target)) {
            return allowWriteEdit(event, toolName, target);
          }
          const decision =
            (await deps.requestApproval?.({
              toolName,
              target,
              reason,
              callId: event.toolCallId,
            })) ?? 'deny'; // 无审批依赖 → 兜底拒绝,不挂起
          if (decision === 'deny') return { block: true, reason, terminate: true };
          return allowWriteEdit(event, toolName, target);
        };

        const check = await resolveAndCheck(deps.workspaceRoot, target, deps.trustedPaths?.homedir);
        if (!check.ok) {
          if (toolName === 'read') {
            // /0022:读取从硬拦改为分级审批;可信路径(agent 自有环境)直放;
            // 不存在的路径(无 realpath)直接放行——无内容可泄,拦截是噪音,
            // 工具执行后自然返回「文件不存在」。
            if (check.realpath && isTrustedReadPath(check.realpath, deps.trustedPaths)) {
              return undefined;
            }
            if (!check.realpath) return undefined;
            if (deps.checkApproved?.(toolName, target)) return undefined;
            const decision =
              (await deps.requestApproval?.({
                toolName,
                target,
                reason: 'approval-required: 读取位置在工作区外',
                callId: event.toolCallId,
              })) ?? 'deny';
            if (decision === 'deny') {
              deps.emitBlocked({
                toolName,
                target,
                callId: event.toolCallId,
                safetyNote: 'approval-denied: 读取被拒绝',
              });
              return { block: true, reason: 'approval-required: 读取被拒绝', terminate: true };
            }
            return undefined;
          }
          // 词法上在工作区内但 realpath 失败 = 目标尚不存在(新建文件);
          // 否则 = 真·工作区外。
          const lexicalInside = path
            .resolve(deps.workspaceRoot, target)
            .startsWith(path.resolve(deps.workspaceRoot) + path.sep);
          return needApprovalFor(
            lexicalInside
              ? 'approval-required: 目标文件尚不存在'
              : 'approval-required: 写入位置在工作区外',
          );
        }
        if (toolName === 'write' || toolName === 'edit') {
          const size = checkWriteSize({
            path: target,
            content: typeof input.content === 'string' ? input.content : undefined,
          });
          if (!size.ok) {
            return needApprovalFor('approval-required: 写入内容超过大小阈值');
          }
          return allowWriteEdit(event, toolName, target);
        }
        return undefined;
      }

      // Step 2.5: grep/find/ls → optional `path` start point gets a workspace
      // check; omitted path defaults to cwd (inside the workspace), so only
      // explicit out-of-workspace start points are gated. 可信路径
      // (技能目录, 扩展)放行——技能搜索是技能读取的一部分;
      // 越界从硬拦改为分级审批(2026-08-10)——搜索是 agent 的能力,
      // 由人裁决;不存在的路径(无 realpath)放行,工具自然报错。
      if (toolName === 'grep' || toolName === 'find' || toolName === 'ls') {
        const input = event.input as { path?: unknown };
        const target = typeof input?.path === 'string' ? input.path : '';
        if (target === '') return undefined;
        const check = await resolveAndCheck(deps.workspaceRoot, target, deps.trustedPaths?.homedir);
        if (!check.ok) {
          if (check.realpath && isTrustedReadPath(check.realpath, deps.trustedPaths)) {
            return undefined;
          }
          if (!check.realpath) return undefined;
          if (deps.checkApproved?.(toolName, target)) return undefined;
          const decision =
            (await deps.requestApproval?.({
              toolName,
              target,
              reason: 'approval-required: 搜索位置在工作区外',
              callId: event.toolCallId,
            })) ?? 'deny';
          if (decision === 'deny') {
            deps.emitBlocked({
              toolName,
              target,
              callId: event.toolCallId,
              safetyNote: 'approval-denied: 搜索被拒绝',
            });
            return { block: true, reason: 'approval-required: 搜索被拒绝', terminate: true };
          }
          return undefined;
        }
        return undefined;
      }

      // Step 3: bash → high-risk + bash-arg path-check + 写/读语义分流。
      // 高危命令(rm -rf 类:有安全等价物/无正当需求)→ 直接拦截,不弹卡
      // (拦截 = 不让 agent 用);嵌套超限(unanalyzable:无法静态审查)
      // → 请求审批,批准后原样执行、不记注册表;写语义目标与 write 同链审批;
      // 读语义越界 → 请求审批(agent 的「手」),不存在路径放行自然报错。
      if (toolName === 'bash') {
        const input = event.input as { command?: unknown };
        const command = typeof input?.command === 'string' ? input.command : '';

        const hr = classifyHighRisk(normalizeBash(command), 0, deps.maxBashNesting);
        if (hr.blocked) {
          if (hr.category === 'unanalyzable') {
            // 无法审查 → 人裁决;批准后原样执行(跳过后续静态检查),不记注册表。
            const decision =
              (await deps.requestApproval?.({
                toolName,
                target: command,
                reason: 'approval-required: 命令嵌套过深，无法自动审查内容，批准后将原样执行',
                callId: event.toolCallId,
              })) ?? 'deny';
            if (decision === 'deny') {
              deps.emitBlocked({
                toolName,
                target: command,
                callId: event.toolCallId,
                safetyNote: 'approval-denied: 嵌套命令被拒绝',
              });
              return {
                block: true,
                reason: 'approval-required: 嵌套命令被拒绝',
                terminate: true,
              };
            }
            return undefined;
          }
          deps.emitBlocked({
            toolName,
            target: command,
            callId: event.toolCallId,
            safetyNote: hr.reason,
          });
          return { block: true, reason: hr.reason };
        }

        // 写语义目标 → 审批链(checkApproved 会话内直放;deny → block + terminate)。
        const io = classifyBashIo(command);
        const approvedWrites = new Set<string>();
        for (const p of io.writes) {
          const c = await resolveAndCheck(deps.workspaceRoot, p, deps.trustedPaths?.homedir);
          if (!c.ok) {
            if (deps.checkApproved?.(toolName, p)) {
              approvedWrites.add(p);
              continue;
            }
            const decision =
              (await deps.requestApproval?.({
                toolName,
                target: p,
                reason: 'approval-required: bash 写入位置在工作区外或不存在',
                callId: event.toolCallId,
              })) ?? 'deny';
            if (decision === 'deny') {
              deps.emitBlocked({
                toolName,
                target: command,
                callId: event.toolCallId,
                safetyNote: 'approval-denied: bash 写入被拒绝',
              });
              return { block: true, reason: 'approval-required: bash 写入被拒绝', terminate: true };
            }
            approvedWrites.add(p);
          }
        }

        // 读语义 + 未知命令参数 → 越界请求审批(2026-08-10);
        // 可信路径(技能目录)直放——执行技能脚本是技能读取的完整形态;
        // 不存在的路径放行(无内容可泄,工具自然报错);已审批放行的写目标豁免,
        // 避免同一目标在路径检查里二次拦截。
        const argPaths = [
          ...new Set(
            [...extractBashArgPaths(command), ...io.reads].filter((p) => !approvedWrites.has(p)),
          ),
        ];
        for (const p of argPaths) {
          const c = await resolveAndCheck(deps.workspaceRoot, p, deps.trustedPaths?.homedir);
          if (!c.ok) {
            if (c.realpath && isTrustedReadPath(c.realpath, deps.trustedPaths)) {
              continue;
            }
            if (!c.realpath) continue;
            if (deps.checkApproved?.(toolName, p)) continue;
            const decision =
              (await deps.requestApproval?.({
                toolName,
                target: p,
                reason: 'approval-required: bash 读取位置在工作区外',
                callId: event.toolCallId,
              })) ?? 'deny';
            if (decision === 'deny') {
              deps.emitBlocked({
                toolName,
                target: command,
                callId: event.toolCallId,
                safetyNote: 'approval-denied: bash 读取被拒绝',
              });
              return { block: true, reason: 'approval-required: bash 读取被拒绝', terminate: true };
            }
          }
        }

        // M3: rm/del/rmdir → trash each path arg via shell.trashItem, then block the bash exec.
        const tokens = normalizeBash(command);
        const head = tokens[0]?.toLowerCase().split(/[\\/]/).pop();
        const rewriteable = ['rm', 'del', 'rmdir'];
        if (rewriteable.includes(head ?? '')) {
          for (const t of tokens.slice(1)) {
            if (t.startsWith('-')) continue;
            try {
              await shell.trashItem(t);
            } catch {
              // best-effort: original bash is blocked anyway, partial trash is acceptable
            }
          }
          const reason = 'trashed-via-trashItem';
          deps.emitBlocked({
            toolName,
            target: command,
            callId: event.toolCallId,
            safetyNote: reason,
          });
          return { block: true, reason };
        }
        return undefined;
      }

      return undefined;
    });

    // 编辑历史:tool_result 到达时收口记录(调用方在 driver 侧落盘)。
    // 被阻断/未执行的调用不会产生 tool_result,天然只有真正执行的编辑被记录。
    pi.on('tool_result', (event: ToolResultEvent): void => {
      if (!deps.finalizeEdit) return;
      if (event.toolName !== 'write' && event.toolName !== 'edit') return;
      const input = event.input as { path?: unknown };
      const target = typeof input?.path === 'string' ? input.path : '';
      if (!target) return;
      const abs = path.isAbsolute(target)
        ? path.resolve(target)
        : path.resolve(deps.workspaceRoot, target);
      const rel = path.isAbsolute(target) ? path.relative(deps.workspaceRoot, abs) : target;
      deps.finalizeEdit({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        fileId: rel.replace(/\\/g, '/'),
        ok: !event.isError,
      });
    });
  };
