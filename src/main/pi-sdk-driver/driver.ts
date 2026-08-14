import path from 'node:path';
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory as SdkExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import type { WebContents } from 'electron';
import type { AgentEvent } from '../../shared/agent-events';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import { tMain } from '../i18n';
import type { MemoryRecordedPayload } from '../memory/propose-memory-tool';
import { buildRecallContext, RECALL_CONTEXT_MARKER, stripRecallContext } from '../memory/recall';
import { createEditMechanism } from './edit-history/factory';
import type { EditMechanism } from './edit-history/mechanism';
import { type EditRecord, EditRecordStore } from './edit-records';
import { EventMapper, extractMessageText, extractThinkingSegments } from './event-mapper';
import { EventRouter } from './event-router';
import { lorraConfigDir } from './lorra-config-dir';
import { type SessionRecord, SessionRegistry } from './session-registry';

export interface SessionPersistence {
  list(cwd: string): Promise<SessionInfo[]>;
  open(jsonlPath: string): Promise<AgentSession>;
  continueRecent(cwd: string): Promise<AgentSession>;
  createInMemory(cwd: string): Promise<AgentSession>;
}

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  path: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

export type ExtensionFactory = SdkExtensionFactory;
export type BlockEmitter = (payload: {
  toolName: string;
  target: string;
  callId?: string;
  safetyNote: string;
}) => void;

export interface SendResult {
  accepted: boolean;
  busySessionId?: string;
}

/**
 * 审批裁决三态(2026-08-10,,Codex 式权限卡):
 * allowOnce → 放行本次,不写会话注册表;allowAlways → 放行 + 写注册表;
 * deny → 拦截器 block + terminate。
 */
export type ApprovalDecision = 'allowOnce' | 'allowAlways' | 'deny';

interface PendingApproval {
  sessionId: string;
  toolName: string;
  target: string;
  reason: string;
  state: 'pending' | 'resolved';
  /** 用户裁决回执:respondApproval 时调用,resolve 拦截器挂起的等待。 */
  resolve: (decision: ApprovalDecision) => void;
}

export interface DriverOptions {
  workspacePath: string;
  persistence: SessionPersistence;
  /**
 * 热会话增量(事实管道):任一 SDK 会话活动事件触发时以该会话的 jsonl
 * 路径回调,由应用层防抖后重清洗写入事实库。fire-and-forget,
 * 失败不进入事件热路径。
 */
  onSessionActivity?: (sessionFile: string) => void;
}

/**
 * 会话消息是否属用户消息(召回注入窗口判定):SDK 消息形状为
 * { role: 'user' | 'assistant' | 'toolResult' | ... },经 in/typeof 收窄读取,
 * 未知形状一律视为非用户消息(不注入即可,不误伤发送)。
 */
function isUserMessage(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return 'role' in value && value.role === 'user';
}

export class LorraDriver {
  private registry = new SessionRegistry();
  private router = new EventRouter();
  private attachedWebContents = new Set<WebContents>();
  // 编辑历史:存储与机制分离,记录与对话卡片经 toolCallId 关联。
  private readonly editStore = new EditRecordStore(path.join(lorraConfigDir(), 'edits'));
  private storeReady: Promise<void> | null = null;
  private mechanismReady: Promise<EditMechanism> | null = null;
  /** tool_call → tool_result 之间的暂存(不落盘,等 finalize)。 */
  private pendingEdits = new Map<string, EditRecord>();
  // 分级审批:pending 审批模态目 + 会话内已放行 (toolName,target) 注册表。
  private approvals = new Map<string, PendingApproval>();
  private approvedOnce = new Map<string, boolean>();

  constructor(private readonly opts: DriverOptions) {}

  private ensureStoreLoaded(): Promise<void> {
    this.storeReady ??= this.editStore.load();
    return this.storeReady;
  }

  /** 惰性初始化执行机制(首次编辑触发;git init 有开销,不阻塞启动)。 */
  private initMechanism(): Promise<EditMechanism> {
    this.mechanismReady ??= createEditMechanism(this.opts.workspacePath);
    return this.mechanismReady;
  }

  private approvalKey(toolName: string, target: string): string {
    return `${toolName}\u0000${target}`;
  }

  /**
 * 拦截器调用:write/edit 需审批 → 生成 approvalId、发事件、挂起等待用户裁决。
 * 返回的 Promise 由 respondApproval 按 approvalId resolve(三态裁决);
 * 无活跃会话时无处审批,直接 resolve deny(拦截器兜底 block + terminate)。
 */
  requestApproval(payload: {
    toolName: string;
    target: string;
    reason: string;
    callId?: string;
  }): Promise<ApprovalDecision> {
    const sessionId = this.registry.activeRecord()?.sessionId;
    if (!sessionId) return Promise.resolve('deny');
    const approvalId = crypto.randomUUID();
    const decision = new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(approvalId, {
        sessionId,
        toolName: payload.toolName,
        target: payload.target,
        reason: payload.reason,
        state: 'pending',
        resolve,
      });
    });
    const seq = this.registry.nextSeq(sessionId);
    const event: AgentEvent = {
      type: 'tool.approval-requested',
      sessionId,
      eventId: crypto.randomUUID(),
      seq,
      ts: Date.now(),
      toolName: payload.toolName,
      target: payload.target,
      reason: payload.reason,
      approvalId,
    };
    this.router.emit(sessionId, event);
    return decision;
  }

  /** 拦截器调用:该 (toolName, target) 已在本 driver 生命周期内被允许。 */
  checkApproved(toolName: string, target: string): boolean {
    return this.approvedOnce.get(this.approvalKey(toolName, target)) ?? false;
  }

  /**
 * 用户裁决:resolve 拦截器挂起的等待(allow → 放行工具执行;deny → 拦截器
 * 返回 block + terminate,agent 停止当前轮)。裁决经事件同步渲染端清审批模态。
 */
  async respondApproval(
    _sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error('approval not found');
    if (approval.state === 'resolved') return; // 重复裁决幂等(乐观 UI + 事件双路径)
    approval.state = 'resolved';
    if (decision === 'allowAlways') {
      this.approvedOnce.set(this.approvalKey(approval.toolName, approval.target), true);
    }
    approval.resolve(decision);
    const seq = this.registry.nextSeq(approval.sessionId);
    const event: AgentEvent = {
      type: 'approval.resolved',
      sessionId: approval.sessionId,
      eventId: crypto.randomUUID(),
      seq,
      ts: Date.now(),
      approvalId,
      decision,
    };
    this.router.emit(approval.sessionId, event);
  }

  attachWebContents(wc: WebContents): () => void {
    this.attachedWebContents.add(wc);
    for (const record of this.registry.allRecords()) {
      this.router.subscribe(record.sessionId, wc);
    }
    return () => {
      this.attachedWebContents.delete(wc);
      for (const record of this.registry.allRecords()) {
        this.router.unsubscribe(record.sessionId, wc);
      }
    };
  }

  private subscribeWebContentsToSession(sessionId: string): void {
    for (const wc of this.attachedWebContents) {
      if (!wc.isDestroyed()) {
        this.router.subscribe(sessionId, wc);
      }
    }
  }

  /** Returns the sessionId of the currently active (non-idle) session, or null. */
  getActiveSessionId(): string | null {
    return this.registry.activeRecord()?.sessionId ?? null;
  }

  /** Emit a `tool.blocked` event for the given session through the router. */
  emitToolBlocked(
    sessionId: string,
    payload: {
      toolName: string;
      target: string;
      callId?: string;
      safetyNote: string;
    },
  ): void {
    const seq = this.registry.nextSeq(sessionId);
    const event: AgentEvent = {
      type: 'tool.blocked',
      sessionId,
      eventId: crypto.randomUUID(),
      seq,
      ts: Date.now(),
      ...payload,
    };
    this.router.emit(sessionId, event);
  }

  /**
 * 记忆写入成功事件(/D6):memory 工具 propose/update 成功后经
 * router 发 'memory.recorded'(形状 = agent-events.ts MemoryRecordedEvent,
 * 渲染端 reducer 据此追加只读通知条)。会话未注册时静默跳过。
 * 注:MemoryRecordedEvent 由 RendererAutonomy 在 agent-events.ts 定稿,
 * 未落地前以字面量 + cast 桥接;落地后移除 cast 并改用导出类型。
 */
  emitMemoryRecorded(payload: MemoryRecordedPayload): void {
    try {
      const seq = this.registry.nextSeq(payload.sessionId);
      const event = {
        type: 'memory.recorded',
        sessionId: payload.sessionId,
        eventId: crypto.randomUUID(),
        seq,
        ts: Date.now(),
        entryId: payload.entryId,
        title: payload.title,
        kind: payload.kind,
        evidence: payload.evidence,
      } as unknown as AgentEvent;
      this.router.emit(payload.sessionId, event);
    } catch {
      // 会话未注册(事件无处投递):静默跳过
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.opts.persistence.list(this.opts.workspacePath);
  }

  async openSession(sessionId: string): Promise<{ sessionId: string }> {
    // SessionInfo.path points straight at the JSONL the SDK wrote — no
    // separate id→path index needed (drops resolveJsonlPath duplication).
    const sessions = await this.opts.persistence.list(this.opts.workspacePath);
    const info = sessions.find((s) => s.id === sessionId);
    if (!info) throw new Error(`session not found: ${sessionId}`);
    const handle = await this.opts.persistence.open(info.path);
    // Register and route the window BEFORE replaying persisted messages.
    // attachSessionSubscription emits replay events synchronously.
    const id = handle.sessionId;
    this.registry.register(id, handle);
    this.subscribeWebContentsToSession(id);
    this.attachSessionSubscription(handle);
    return { sessionId: id };
  }

  async continueRecent(): Promise<{ sessionId: string }> {
    const handle = await this.opts.persistence.continueRecent(this.opts.workspacePath);
    const sessionId = handle.sessionId;
    this.registry.register(sessionId, handle);
    this.subscribeWebContentsToSession(sessionId);
    this.attachSessionSubscription(handle);
    return { sessionId };
  }

  async newSession(): Promise<{ sessionId: string }> {
    const handle = await this.opts.persistence.createInMemory(this.opts.workspacePath);
    const sessionId = handle.sessionId;
    this.registry.register(sessionId, handle);
    this.subscribeWebContentsToSession(sessionId);
    this.attachSessionSubscription(handle);
    return { sessionId };
  }

  /**
 * Wire the AgentSession's internal event stream through EventMapper and
 * into the EventRouter for the given handle. Idempotent: replaces any
 * prior subscription on the same handle. Called at registration time
 * (continueRecent/newSession/openSession), NOT inside send — that way
 * historical sessions opened without an immediate send still receive
 * any event the SDK flushes on subscribe.
 */
  private attachSessionSubscription(handle: AgentSession): void {
    const sessionId = handle.sessionId;
    const record = this.registry.get(sessionId);
    record?.unsubscribe?.();
    const mapper = new EventMapper({
      sessionId,
      nextSeq: () => this.registry.nextSeq(sessionId),
      toMessageContent: (msg) => {
        const rawRole =
          msg && typeof msg === 'object' ? (msg as Record<string, unknown>).role : undefined;
        const role =
          rawRole === 'user' || rawRole === 'toolResult' || rawRole === 'assistant'
            ? rawRole
            : 'other';
        const text = extractMessageText(msg);
        // 显示卫生(走查实证):用户消息里的召回注入块(带 HTML 注释 marker)
        // 只在气泡显示层剥离,会话 jsonl 原文(raw 只读)不动。
        const display = role === 'user' ? stripRecallContext(text) : text;
        return {
          role,
          content: { text: display },
        };
      },
      // SDK 消息形状 { role, content: [thinking|text|toolCall…] }(pi-ai
      // createEventConverter 实证):thinking 块在 content 数组内,
      // extractThinkingSegments 期望的是 content 本身,必须先解包——
      // 直传消息对象会恒得空数组,实时对话将丢失全部思考段(P1 走查修复)。
      toMessageThinkingSegments: (msg) => {
        let content: unknown = msg;
        if (msg && typeof msg === 'object' && 'content' in msg) {
          content = msg.content;
        }
        return extractThinkingSegments(content);
      },
      emit: (event) => this.router.emit(sessionId, event),
      toToolTarget: (toolName, input) => {
        if (typeof input === 'string') return input;
        if (input && typeof input === 'object') {
          const path = (input as Record<string, unknown>).path;
          if (typeof path === 'string') return path;
          const command = (input as Record<string, unknown>).command;
          if (typeof command === 'string') return command;
          const pattern = (input as Record<string, unknown>).pattern;
          if (typeof pattern === 'string') return pattern;
          const query = (input as Record<string, unknown>).query;
          if (typeof query === 'string') return query;
        }
        return toolName;
      },
    });
    const unsubscribe = handle.subscribe((rawEvent: AgentSessionEvent) => {
      // 热会话增量旁路:会话活动事件 → 重清洗回调(防抖在应用层)。
      if (onActivity && sessionFile) onActivity(sessionFile);
      const mapped = mapper.map(rawEvent);
      if (mapped) this.router.emit(sessionId, mapped);
      const status = mapper.statusForEvent(rawEvent);
      const rec = this.registry.get(sessionId);
      if (status && rec && status !== rec.status) {
        this.registry.updateStatus(sessionId, status);
        try {
          const seq = this.registry.nextSeq(sessionId);
          const statusEvent: AgentEvent = {
            type: 'session.status',
            sessionId,
            eventId: crypto.randomUUID(),
            seq,
            ts: Date.now(),
            status,
          };
          this.router.emit(sessionId, statusEvent);
        } catch {
          // nextSeq failure → uncaught-handler logs. Do not swallow here.
          throw new Error(`driver.attachSessionSubscription: nextSeq failed`);
        }
      }
    });
    if (record) record.unsubscribe = unsubscribe;

    // Replay any messages the SDK already deserialized from the JSONL so the
    // renderer sees the historical conversation the moment the session is
    // opened (or continueRecent/createInMemory). The SDK's subscribe does
    // NOT replay — it only emits new events from here on (verified at
    // node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
    // :522). Live events below this point keep counter stability because we
    // already consumed handle.messages above.
    // Replay the conversation log the SDK already parsed from the JSONL so
    // the renderer sees the historical chat the moment the session opens.
    // `handle.messages` is empty at attach time (state populates only when the
    // agent actually runs); `sessionManager.fileEntries` is populated
    // synchronously by SessionManager.open and is the source of truth for
    // the persisted log. Cast via unknown — fileEntries is a documented
    // internal of SessionManager and we hand it straight to our mapper.
    const sm = handle.sessionManager as unknown as {
      fileEntries: Array<{ type: string; message?: unknown }>;
      sessionFile?: string;
    };
    const sessionFile = sm.sessionFile ?? '';
    const onActivity = this.opts.onSessionActivity;
    const entries = sm.fileEntries;
    const messages = entries
      .filter((e) => e.type === 'message' && e.message)
      .map((e) => e.message as unknown as Parameters<typeof mapper.replayFromMessages>[0][number]);
    const replayed = mapper.replayFromMessages(messages);
    for (const replay of replayed) {
      this.router.emit(sessionId, replay);
    }
  }

  async send(sessionId: string, text: string): Promise<SendResult> {
    const record = this.registry.get(sessionId);
    if (!record) {
      return { accepted: false };
    }

    if (record.status !== 'idle') {
      const active = this.registry.activeRecord();
      return { accepted: false, busySessionId: active?.sessionId };
    }

    const promptText = this.maybeInjectRecall(record, text);

    this.registry.updateStatus(sessionId, 'streaming');

    // 投递即返回(2026-08-13 UX 修复):send 的语义是「受理投递」,不是「回合结束」。
    // 旧实现 await prompt 直到 agent 答完,IPC 挂住整轮 → 渲染端输入框要等
    // 回答完毕才清空。回合内的状态流转由 SDK 事件流(attachSessionSubscription)
    // 驱动;异步失败在此兜底为 errored + session.status 事件(渲染端据此亮错误条)。
    void record.piSessionHandle
      .prompt(promptText, { streamingBehavior: 'followUp' })
      .catch((error: unknown) => {
        this.registry.updateStatus(sessionId, 'errored');
        const seq = this.registry.nextSeq(sessionId);
        const statusEvent: AgentEvent = {
          type: 'session.status',
          sessionId,
          eventId: crypto.randomUUID(),
          seq,
          ts: Date.now(),
          status: 'errored',
        };
        this.router.emit(sessionId, statusEvent);
        console.error(`[lorra-driver] prompt failed for session ${sessionId}:`, error);
      });

    return { accepted: true };
  }

  /**
 * 会话启动记忆召回注入(design 6.6):仅当该会话尚无任何用户消息(新会话/
 * 首次发送)时,在用户文本前拼接召回块(marker 包裹,\n\n 分隔);历史会话
 * 已有消息不注入,避免重复污染。召回为空/构建失败 → 原样返回用户文本
 * (fail-open:召回绝不阻断发送)。
 */
  private maybeInjectRecall(record: SessionRecord, text: string): string {
    if (this.hasUserMessages(record)) return text;
    let block = '';
    try {
      block = buildRecallContext({ workspace: this.opts.workspacePath });
    } catch {
      // fail-open:召回异常绝不阻塞会话启动
    }
    if (!block) return text;
    return `${RECALL_CONTEXT_MARKER}\n${block}\n${RECALL_CONTEXT_MARKER}\n\n${text}`;
  }

  /**
 * 会话是否已含用户消息:新会话/首条消息前为 false(注入窗口)。
 * 判定依据:handle.messages(会话运行后 SDK 已装载的 agent state)与
 * sessionManager.fileEntries(attach 时已 replay 的历史 jsonl)。
 */
  private hasUserMessages(record: SessionRecord): boolean {
    const handle = record.piSessionHandle;
    if ((handle.messages ?? []).some(isUserMessage)) return true;
    const sm = handle.sessionManager as unknown as {
      fileEntries?: Array<{ type: string; message?: unknown }>;
    };
    const entries = sm.fileEntries ?? [];
    return entries.some((e) => e.type === 'message' && isUserMessage(e.message));
  }

  async abort(sessionId: string): Promise<void> {
    const record = this.registry.get(sessionId);
    if (!record) return;
    await record.piSessionHandle.abort();
    this.registry.updateStatus(sessionId, 'aborted');
    // 该会话挂起的审批模态一并清掉(裁决已无意义):resolve deny 让拦截器
    // 返回 block + terminate,避免 agent 挂起等待永不裁决的审批。
    for (const [id, approval] of this.approvals) {
      if (approval.sessionId === sessionId) {
        approval.state = 'resolved';
        approval.resolve('deny');
        this.approvals.delete(id);
      }
    }
  }

  /**
 * 手动压缩会话上下文(pi TUI `/compact`):委托 AgentSession.compact 汇总旧
 * 消息并截断。仅空闲会话允许;busy 时返回 { accepted: false }(与 send 同款
 * 拒绝形状),其余异常上抛由 IPC 层包装为错误。
 */
  async compact(sessionId: string): Promise<{ accepted: boolean }> {
    const record = this.registry.get(sessionId);
    if (!record) throw new Error(`session not found: ${sessionId}`);
    if (record.status !== 'idle') return { accepted: false };
    await record.piSessionHandle.compact();
    return { accepted: true };
  }

  async dispose(sessionId: string): Promise<void> {
    this.registry.remove(sessionId);
  }

  async shutdownAll(): Promise<void> {
    await this.registry.shutdownAll();
    // 跨工作区/重启的「已批准」许可不过期保留(会话内记忆语义)。
    this.approvedOnce.clear();
    // 挂起审批 resolve deny(拦截器兜底 block + terminate,不永久挂起)。
    for (const approval of this.approvals.values()) {
      approval.state = 'resolved';
      approval.resolve('deny');
    }
    this.approvals.clear();
  }

  // ---- 编辑历史----
  // 拦截器在 write/edit 放行时调 recordEditBefore、tool_result 到达时调
  // finalizeEdit;两者都 fire-and-forget(best-effort 审计,失败不阻断 AI)。

  recordEditBefore(payload: {
    toolCallId: string;
    toolName: 'write' | 'edit';
    fileId: string;
    before: string;
  }): void {
    void (async () => {
      try {
        await this.ensureStoreLoaded();
        const mechanism = await this.initMechanism();
        const record: EditRecord = {
          id: payload.toolCallId,
          sessionId: this.registry.activeRecord()?.sessionId ?? '',
          toolName: payload.toolName,
          fileId: payload.fileId,
          before: payload.before,
          ts: Date.now(),
          status: 'applied',
          kind: mechanism.kind,
        };
        this.pendingEdits.set(payload.toolCallId, record);
      } catch {
        // best-effort:记录失败不阻断 AI 操作
      }
    })();
  }

  finalizeEdit(payload: {
    toolCallId: string;
    toolName: string;
    fileId: string;
    ok: boolean;
  }): void {
    void (async () => {
      try {
        await this.ensureStoreLoaded();
        const record = this.pendingEdits.get(payload.toolCallId);
        if (!record) return;
        if (!payload.ok) return; // 操作失败无痕迹
        const mechanism = await this.initMechanism();
        const { commit, parentCommit } = await mechanism.finalize(record);
        record.commit = commit;
        record.parentCommit = parentCommit;
        await this.editStore.save(record);
      } catch {
        // best-effort:历史记录失败不阻断 AI 操作
      } finally {
        this.pendingEdits.delete(payload.toolCallId);
      }
    })();
  }

  /** 复原编辑:守卫 → 写回/restore → 标记 reverted → 通知渲染端重取中栏。 */
  async revertEdit(editId: string): Promise<Result<{ fileId: string }>> {
    await this.ensureStoreLoaded();
    const record = await this.editStore.get(editId);
    if (!record) {
      return err({ code: 'edit-not-found', message: tMain('errors.edits.notFound') });
    }
    if (record.status === 'reverted') {
      return ok({ fileId: record.fileId }); // 幂等
    }
    try {
      const mechanism = await this.initMechanism();
      const guard = await mechanism.guardBeforeRevert(record);
      if (guard) {
        return err({ code: 'file-dirty', message: guard });
      }
      await mechanism.revert(record);
      await this.editStore.updateStatus(editId, 'reverted');
      this.emitEditsReverted(record);
      return ok({ fileId: record.fileId });
    } catch {
      return err({ code: 'revert-failed', message: tMain('errors.edits.revertFailed') });
    }
  }

  async acceptEdit(editId: string): Promise<Result<{ fileId: string }>> {
    await this.ensureStoreLoaded();
    const record = await this.editStore.get(editId);
    if (!record) {
      return err({ code: 'edit-not-found', message: tMain('errors.edits.notFound') });
    }
    if (record.status === 'reverted') {
      return err({ code: 'edit-already-reverted', message: tMain('errors.edits.alreadyReverted') });
    }
    await this.editStore.updateStatus(editId, 'accepted');
    return ok({ fileId: record.fileId });
  }

  async listEdits(sessionId?: string): Promise<EditRecord[]> {
    await this.ensureStoreLoaded();
    return this.editStore.list(sessionId);
  }

  /** 复原是主进程直接写盘,不走 tool.end 事件流,需显式通知渲染端重取文件。 */
  private emitEditsReverted(record: EditRecord): void {
    try {
      const seq = this.registry.nextSeq(record.sessionId);
      const event: AgentEvent = {
        type: 'edits.reverted',
        sessionId: record.sessionId,
        eventId: crypto.randomUUID(),
        seq,
        ts: Date.now(),
        editId: record.id,
        fileId: record.fileId,
      };
      this.router.emit(record.sessionId, event);
    } catch {
      // 会话未注册(如跨工作区复原):事件无处投递,静默跳过。
    }
  }
}
