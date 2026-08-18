import { BookmarkPlus, Check, Copy, Plus } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import type { SlashCommandName } from '@/lib/slash-commands';
import type { AgentEvent, SessionStatus } from '../shared/agent-events';
import type { MessageKey } from '../shared/i18n-core';
import { MEMORY_EVIDENCE_LABELS, MEMORY_KIND_LABELS } from '../shared/memory-schema';
import { ApprovalModal } from './approval-modal';
import { Composer, type ComposerReference } from './composer';
import { DiffCard } from './diff-card';
import { type ChatRowModel, groupChatEvents } from './lib/chat-groups';
import { formatDuration } from './lib/format-duration';
import { useT } from './lib/i18n';
import { PlanCard } from './plan-card';
import type { RecordedNotice } from './reducer';
import { SafeMarkdown } from './safe-markdown';
import { ThinkingCard } from './thinking-card';
import { isWriteTool, ToolCard } from './tool-card';

const STATUS_LABEL_KEY: Record<SessionStatus, MessageKey> = {
  idle: 'chat.status.idle',
  streaming: 'chat.status.streaming',
  'tool-running': 'chat.status.toolRunning',
  aborted: 'chat.status.aborted',
  errored: 'chat.status.errored',
};

/** 记忆通知条自动消退时长(ms):超时后逐条移除;下一事件到来时保留至事件流覆盖。 */
const NOTICE_AUTO_DISMISS_MS = 6000;

interface ChatPaneProps {
  status: SessionStatus;
  events: AgentEvent[];
  modelAvailable: boolean;
  modelLoading: boolean;
  defaultModelName: string | null;
  inlineError: string;
  onOpenProviders: () => void;
  // App 的 sendMessage 实际返回「是否被 driver 受理」供消息队列出队解锁(2026-08-17);
  // 本组件不消费返回值,用 unknown 放行 void/boolean 两类实现。
  onSend: (text: string, images?: Array<{ fileId: string }>) => Promise<unknown>;
  onAbort: () => Promise<void>;
  /** 新建 Agent 对话(顶栏 + 空态 hero);缺省 = 不渲染可点行为。 */
  onCreateSession?: () => void;
  /** 斜杠命令(pi TUI 风格):composer 输入 /命令 回车时回调。 */
  onCommand?: (command: SlashCommandName) => boolean | Promise<boolean>;
  /** 「问 AI」引用胶囊(单选替换,不做多胶囊)。 */
  references?: ComposerReference[];
  onClearReferences?: () => void;
  /** 待发送队列(2026-08-17):agent 忙碌时发送的消息排队,透传 Composer。 */
  queue?: Array<{ id: string; text: string }>;
  onQueue?: (text: string) => void;
  onQueueRemove?: (id: string) => void;
  onQueueEdit?: (id: string, text: string) => void;
  onQueueSendNow?: (id: string) => void;
  /** 工具行「在中栏打开」(diff 卡)。 */
  onOpenFile?: (target: string) => void;
  /** diff 卡「接受」。 */
  onAcceptEdit?: (editId: string) => Promise<boolean>;
  /** diff 卡「复原」。 */
  onRevertEdit?: (editId: string) => Promise<{ ok: boolean; fileId?: string; error?: string }>;
  /** 复原成功后通知(中栏重取文件)。 */
  onFileReverted?: (fileId: string) => void;
  /** 挂起的工具审批;undefined = 无审批模态。 */
  pendingApproval?: { approvalId: string; toolName: string; target: string; reason: string };
  /** 审批裁决回调(允许一次/总是允许/拒绝)。 */
  onRespondApproval?: (
    approvalId: string,
    decision: 'allowOnce' | 'allowAlways' | 'deny',
  ) => Promise<void>;
  /** 会话内记忆只读通知(1.6);缺省/空数组 = 不渲染通知条。 */
  recordedNotices?: RecordedNotice[];
  /** 通知条自动消退后移除回调。 */
  onMemoryNoticeDismissed?: (entryId: string) => void;
  /** @ 文件候选查询。 */
  onFileCandidates?: (query: string) => Promise<Array<{ fileId: string; name: string }>>;
  /** @ 文件引用内容快照。 */
  onResolveFileRef?: (fileId: string) => Promise<string | null>;
  /** @ 选中文件后追加引用胶囊。 */
  onAppendReference?: (ref: ComposerReference) => void;
  /** 当前工作区绝对路径（拖拽文件填充相对路径用）。 */
  workspacePath?: string | null;
  /**
   * thinking 流时间锚点(messageId → 首个 partial ts)。reducer 折叠后 events
   * 里无 partial,组时间/思考耗时依赖此锚点;缺省 = 直传事件流路径,内部自记。
   */
  thinkingFirstTs?: Readonly<Record<string, number>>;
}

// 右栏对话区(design.md .1):聊天流 + 流式输出 + 可折叠思考气泡 + 工具卡片。
export function ChatPane(props: ChatPaneProps): JSX.Element {
  const t = useT();
  const hasEvents = props.events.length > 0;
  const busy = props.status === 'streaming' || props.status === 'tool-running';
  // 事件流 → 行模型(Codex 式活动条):消息独立成行,思考/工具归组。
  const rows = useMemo(
    () => groupChatEvents(props.events, props.thinkingFirstTs),
    [props.events, props.thinkingFirstTs],
  );
  // 6.13 用户结晶「记住这段」:一次性的成功/失败轻提示,下次结晶前保持。
  const [crystallizeNotice, setCrystallizeNotice] = useState<{
    kind: 'ok' | 'error';
    message: string;
  } | null>(null);

  async function handleCrystallize(text: string): Promise<void> {
    // 标题 = 首行截断(60 字符上限);空首行不传 title。
    const title = text.split('\n')[0].trim().slice(0, 60) || undefined;
    try {
      const res = await window.lorra.memory.crystallize({ content: text, title });
      setCrystallizeNotice(
        res.ok
          ? { kind: 'ok', message: t('chat.crystallizeOk') }
          : { kind: 'error', message: t('chat.crystallizeFailed', { message: res.error.message }) },
      );
    } catch {
      setCrystallizeNotice({ kind: 'error', message: t('chat.crystallizeUnavailable') });
    }
  }

  // 记忆只读通知:引用稳定(useMemo 保持数组引用,reducer 变更才重建),
  // 每条超时自动消退(onMemoryNoticeDismissed 语义稳定,排除出依赖防重排)。
  const notices = useMemo(() => props.recordedNotices ?? [], [props.recordedNotices]);
  useEffect(() => {
    if (notices.length === 0) return;
    const timers = notices.map((n) =>
      window.setTimeout(() => props.onMemoryNoticeDismissed?.(n.entryId), NOTICE_AUTO_DISMISS_MS),
    );
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 回调由 App 内联,身份每渲染变化;语义稳定
  }, [notices]);

  // 发送后把对话框移到最新(2026-08-09 UX 调整):用户消息落流时跟随到底部。
  // 只盯用户消息——流式回答过程不打断用户回读上文的滚动位置。
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const last = props.events.at(-1);
    if (last?.type === 'message.final' && last.role === 'user' && streamRef.current) {
      streamRef.current.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [props.events]);
  // 会话恢复落底(2026-08-13 修复):历史重放是主进程同步批量 emit,首条事件
  // 落流时内容远未齐,故延迟两次(300/900ms)锚定到底——覆盖整批渲染完成。
  // 一次性生效(flag):之后的新事件不打断用户回读位置(与上方只盯用户消息一致)。
  // 用 scrollTop 赋值(瞬时)而非 scrollTo(smooth),恢复跳转不做长滚动动画。
  const followedRestore = useRef(false);
  useEffect(() => {
    if (followedRestore.current) return;
    if (props.events.length === 0) return;
    const el = streamRef.current;
    if (!el) return;
    followedRestore.current = true;
    window.setTimeout(() => {
      el.scrollTop = el.scrollHeight;
    }, 300);
    window.setTimeout(() => {
      el.scrollTop = el.scrollHeight;
    }, 900);
  }, [props.events]);

  return (
    <section className="chat-pane" aria-label={t('chat.regionLabel')}>
      <header className="chat-header">
        <div>
          <p className="chat-title">Agent</p>
          <button
            type="button"
            className="model-state-btn"
            onClick={props.onOpenProviders}
            aria-label={props.modelAvailable ? t('chat.openProviders') : t('chat.connectModel')}
          >
            <span
              className={`model-state-dot${props.modelAvailable ? '' : ' is-off'}`}
              aria-hidden="true"
            />
            {props.modelAvailable
              ? (props.defaultModelName ?? t('chat.connected'))
              : t('chat.connectModel')}
            {props.status !== 'idle' && (
              <span className="chat-status-chip">{t(STATUS_LABEL_KEY[props.status])}</span>
            )}
          </button>
        </div>
        <button type="button" aria-label={t('chat.newAgentChat')} onClick={props.onCreateSession}>
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="chat-stream" aria-live="polite" ref={streamRef}>
        {props.pendingApproval ? (
          <ApprovalModal
            approval={props.pendingApproval}
            onRespond={
              props.onRespondApproval ??
              (async () => {
                // 未接线时静默(测试环境)
              })
            }
          />
        ) : null}
        <div className="context-note">{t('chat.contextNote')}</div>
        {crystallizeNotice && (
          <div
            className={`crystallize-notice is-${crystallizeNotice.kind}`}
            role="status"
            aria-live="polite"
          >
            {crystallizeNotice.message}
          </div>
        )}
        {!hasEvents && !props.modelLoading && !props.modelAvailable ? (
          <div className="chat-empty-cta">
            <p>{t('chat.noModelEmpty')}</p>
            <button className="pc-btn pc-btn-primary" type="button" onClick={props.onOpenProviders}>
              {t('chat.connectModel')}
            </button>
          </div>
        ) : !hasEvents ? (
          <WelcomeState onCommand={props.onCommand} />
        ) : null}
        {rows.map((row) => (
          <ChatRow
            key={row.key}
            row={row}
            onOpenFile={props.onOpenFile}
            onAcceptEdit={props.onAcceptEdit}
            onRevertEdit={props.onRevertEdit}
            onFileReverted={props.onFileReverted}
            onCrystallize={handleCrystallize}
          />
        ))}
        {/* 签名微交互:agent 思考中,回复位置浮现小光球(design.md .3)。
 thinking-orbs 只支持 dark/light 墨水,纸底上取 theme="light" 深色光球。 */}
        {busy && (
          <div className="flex justify-center py-2">
            <ThinkingOrb
              state={props.status === 'streaming' ? 'working' : 'searching'}
              size={20}
              theme="light"
            />
          </div>
        )}
        {/* 会话内记忆只读通知(1.6):memory.recorded 事件 → 标题 + 类别/证据徽标,
 无任何按钮,自动消退或保留至下一事件。 */}
        {notices.length > 0 && (
          <div className="memory-notice-list" data-testid="memory-notice-list" aria-live="polite">
            {notices.map((n) => (
              <div
                className="memory-notice"
                data-testid="memory-notice"
                data-entry-id={n.entryId}
                key={n.entryId}
              >
                <span className="rev-badge memory-kind-badge">{MEMORY_KIND_LABELS[n.kind]}</span>
                <span className="rev-badge memory-evidence-badge">
                  {MEMORY_EVIDENCE_LABELS[n.evidence]}
                </span>
                <span className="memory-notice-title">{n.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Composer
        status={props.status}
        onSend={props.onSend}
        onAbort={props.onAbort}
        onCommand={props.onCommand}
        inlineError={props.inlineError}
        modelAvailable={props.modelAvailable}
        // 空会话且无模型时 chat-empty-cta 已传达同一信息,不再重复渲染底部 banner。
        modelUnavailableBanner={!props.modelAvailable && hasEvents}
        defaultModelName={props.defaultModelName}
        emptyStateMessage={hasEvents || !props.modelAvailable ? '' : t('chat.waitingAi')}
        references={props.references}
        onClearReferences={props.onClearReferences}
        queue={props.queue}
        onQueue={props.onQueue}
        onQueueRemove={props.onQueueRemove}
        onQueueEdit={props.onQueueEdit}
        onQueueSendNow={props.onQueueSendNow}
        onFileCandidates={props.onFileCandidates}
        onResolveFileRef={props.onResolveFileRef}
        onAppendReference={props.onAppendReference}
        workspacePath={props.workspacePath}
      />
    </section>
  );
}

/** 空态欢迎页(2026-08-07):问候 + 快捷键提示 + 真实能力快捷入口。
 * 入口全部映射既有能力(斜杠命令),不造假功能。 */
function WelcomeState({
  onCommand,
}: {
  onCommand?: (command: SlashCommandName) => boolean | Promise<boolean>;
}): JSX.Element {
  const t = useT();
  const shortcuts: Array<{ labelKey: MessageKey; command: SlashCommandName }> = [
    { labelKey: 'chat.welcome.newChat', command: 'new' },
    { labelKey: 'chat.welcome.resume', command: 'resume' },
    { labelKey: 'chat.welcome.configureModel', command: 'model' },
    { labelKey: 'chat.welcome.hotkeys', command: 'hotkeys' },
    { labelKey: 'chat.welcome.openSettings', command: 'settings' },
  ];
  return (
    <div className="chat-welcome" data-testid="chat-welcome">
      <p className="chat-welcome-hint">
        <kbd>Ctrl</kbd> + <kbd>P</kbd> {t('chat.welcome.hint')}
      </p>
      <h2 className="chat-welcome-title">{t('chat.welcome.title')}</h2>
      <p className="chat-welcome-sub">{t('chat.welcome.sub')}</p>
      <div className="chat-welcome-actions">
        {shortcuts.map((s) => (
          <button
            key={s.command}
            type="button"
            className="chat-welcome-chip"
            onClick={() => void onCommand?.(s.command)}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 助手消息底部按钮行(2026-08-11 改版:紧贴气泡下方常驻,截图样式):
 * 目前「复制」+「记住这段」两个动作,后续动作按同一模式向 actions 数组追加。
 * 复制成功图标短暂换勾(2s 后恢复);剪贴板不可用时静默。
 */
function MessageActions({
  text,
  onCrystallize,
}: {
  text: string;
  onCrystallize?: (text: string) => void;
}): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const actions = [
    {
      key: 'copy',
      label: t('chat.copyReply'),
      icon: copied ? <Check size={13} /> : <Copy size={13} />,
      onClick: () => {
        try {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => {
              /* clipboard 写入失败:静默 */
            });
        } catch {
          /* clipboard 不可用:静默 */
        }
      },
    },
    {
      key: 'remember',
      label: t('chat.rememberThis'),
      icon: <BookmarkPlus size={13} />,
      onClick: () => onCrystallize?.(text),
    },
  ] as const;
  return (
    <div className="message-actions">
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          className="message-action-btn"
          aria-label={a.label}
          title={a.label}
          onClick={a.onClick}
        >
          {a.icon}
        </button>
      ))}
    </div>
  );
}

function ChatRow({
  row,
  onOpenFile,
  onAcceptEdit,
  onRevertEdit,
  onFileReverted,
  onCrystallize,
}: {
  row: ChatRowModel;
  onOpenFile?: (target: string) => void;
  onAcceptEdit?: (editId: string) => Promise<boolean>;
  onRevertEdit?: (editId: string) => Promise<{ ok: boolean; fileId?: string; error?: string }>;
  onFileReverted?: (fileId: string) => void;
  /** 6.13「记住这段」:助手消息底部按钮行结晶入口。 */
  onCrystallize?: (text: string) => void;
}): JSX.Element | null {
  const t = useT();
  if (row.kind === 'message') {
    const event = row.event;
    // assistant 输出默认带 markdown 结构(标题/列表/代码块)→ SafeMarkdown 渲染提升可读性;
    // user 输入是非结构化文本 → 保持纯文本,避免误把 # 当标题渲染。
    const body =
      event.role === 'assistant' ? (
        <SafeMarkdown content={event.content.text} />
      ) : (
        <p>{event.content.text}</p>
      );
    // 按钮行只对非空助手消息渲染(user 消息无动作)。
    const rememberable = event.role === 'assistant' && event.content.text.trim() !== '';
    return (
      <div className={`message ${event.role}`}>
        <div className="message-col">
          <div className="message-bubble">{body}</div>
          {rememberable && (
            <MessageActions text={event.content.text} onCrystallize={onCrystallize} />
          )}
        </div>
      </div>
    );
  }
  if (row.kind === 'error') {
    // 错误信息可能是技术 trace → 强制纯文本,避免 markdown 误读。
    return (
      <div className="message assistant message-error">
        <div className="message-bubble">
          <p>{row.event.content.text}</p>
        </div>
      </div>
    );
  }
  if (row.kind === 'thinking') {
    // 思考段内联在消息流中(连续流范式):弱化样式、默认折叠、流式可见。
    return (
      <ThinkingCard
        messageId={row.row.messageId}
        segmentIndex={row.row.segmentIndex}
        thinking={row.row.thinking}
        running={row.row.running}
        thinkingRedacted={row.row.redacted}
        durationMs={row.row.durationMs}
      />
    );
  }
  if (row.kind === 'turn-marker') {
    // 回合耗时标记:user 消息下方的双线分隔(pi-gui TimelineTurnMarkerItem 形态)。
    return (
      <div className="turn-marker" data-testid="turn-marker">
        <span className="turn-marker-label">
          {t('chat.turnWorked', { duration: formatDuration(row.durationMs, t) })}
        </span>
      </div>
    );
  }
  // 工具调用内联在消息流中:类型图标 + 状态 + 输入/输出分区。
  return (
    <ToolCard
      toolName={row.row.toolName}
      target={row.row.target}
      callId={row.row.key}
      args={row.row.args}
      status={row.row.status === 'ok' ? 'ok' : row.row.status === 'running' ? 'running' : 'error'}
      delta={row.row.delta}
      result={row.row.result}
      safetyNote={row.row.safetyNote}
      // edit/write 成功默认展开:diff 卡与操作按钮是第一眼就该看到的
      // 内容(用户两次反馈「看不到 diff 卡」——折叠藏得太深)。
      defaultOpen={
        row.row.status === 'error' ||
        row.row.status === 'blocked' ||
        Boolean(row.row.plan) ||
        (isWriteTool(row.row.toolName) && row.row.status === 'ok' && Boolean(row.row.result))
      }
      detailOverride={
        row.row.plan ? (
          <PlanCard
            plan={row.row.plan.plan}
            explanation={row.row.plan.explanation}
            running={row.row.plan.running}
          />
        ) : isWriteTool(row.row.toolName) && row.row.status === 'ok' && row.row.result ? (
          <DiffCard
            diff={row.row.result}
            fileName={row.row.target}
            editId={row.row.key}
            onOpen={() => onOpenFile?.(row.row.target)}
            onAccept={onAcceptEdit ?? (async () => false)}
            onRevert={
              onRevertEdit ?? (async () => ({ ok: false, error: t('chat.editUnavailable') }))
            }
            onReverted={onFileReverted}
          />
        ) : undefined
      }
    />
  );
}
