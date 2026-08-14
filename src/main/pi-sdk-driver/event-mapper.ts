import type { Message as AgentMessage } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentEvent, SessionStatus } from '../../shared/agent-events';
// 纯共享模块(零 node 依赖):event-mapper 会被 renderer/client 测试图打包,
// 不能经 recall.ts 间接拖入 node:sqlite(同款纪律)。
import { stripRecallContext } from '../../shared/recall-context';

export interface MapperDeps {
  sessionId: string;
  nextSeq: () => number;
  toMessageContent(message: unknown): {
    role: 'user' | 'assistant' | 'toolResult' | 'other';
    content: { text: string };
  };
  /**
 * Extract the SDK thinking blocks (`{ type: 'thinking', thinking }`) from a
 * message as an ordered segment list — block boundaries are preserved so the
 * renderer can render each thinking segment inline in the message stream.
 * Empty array = no thinking content.
 */
  toMessageThinkingSegments(
    message: unknown,
  ): Array<{ thinking: string; redacted?: boolean }> | null;
  toToolTarget(toolName: string, input: unknown): string;
  onToolEnd?: (toolName: string, target: string) => void;
  /** Emit additional product events alongside the one returned by map (e.g. thinking.partial/final). */
  emit?: (event: AgentEvent) => void;
}

/**
 * Recognised safety-interceptor `safetyNote` prefixes — when the SDK surfaces
 * a tool_execution_end whose result text starts with one of these, the
 * renderer treats the call as a block (matches spec tool-safety-interceptor).
 */
const BLOCKED_SAFETY_PREFIXES = [
  'path-out-of-workspace',
  'size-exceeds-threshold',
  'high-risk:',
  'tool-not-allowed',
  'approval-required',
] as const;

export class EventMapper {
  private activeMessageId: string | undefined;
  /** tool_execution_start 的原始参数:end 事件不带 args,target 需从调用参数提取。 */
  private toolArgsByCall = new Map<string, unknown>();
  /**
 * Last thinking text emitted per segment for the in-flight assistant message,
 * so duplicate thinking.partial events (text-only updates carry the
 * accumulated thinking too) are suppressed per segment. Reset at message_end.
 */
  private lastSegmentTexts = new Map<number, string>();

  constructor(private readonly deps: MapperDeps) {}

  private freshEnvelope() {
    return {
      sessionId: this.deps.sessionId,
      eventId: crypto.randomUUID(),
      seq: this.deps.nextSeq(),
      ts: Date.now(),
    };
  }

  map(event: AgentSessionEvent): AgentEvent | null {
    // M3 (Oracle ): let nextSeq throw — uncaught-handler logs. Do NOT
    // swallow the error here; that would violate .
    const seq = this.deps.nextSeq();

    const envelope = {
      sessionId: this.deps.sessionId,
      eventId: crypto.randomUUID(),
      seq,
      ts: Date.now(),
    };

    switch (event.type) {
      case 'message_start':
      case 'message_update':
      case 'message_end': {
        const msg = event.message;
        if (!msg) return null;
        const { role, content } = this.deps.toMessageContent(msg);
        if (role === 'toolResult' || role === 'other') {
          if (event.type === 'message_end') this.activeMessageId = undefined;
          return null;
        }

        const messageId = this.activeMessageId ?? crypto.randomUUID();
        this.activeMessageId = event.type === 'message_end' ? undefined : messageId;

        // The SDK streams thinking progressively: each message_update carries the
        // accumulated thinking text (verified in pi-ai's createEventConverter +
        // agent-loop's message_update emission). Emit thinking.partial while it
        // grows and thinking.final at message_end, correlated to messageId.
        // The thinking event takes the already-allocated `envelope` seq and is
        // emitted first via deps.emit; the returned message event then takes a
        // fresh seq so per-session seq stays monotonic in emission order.
        let msgEnvelope = envelope;
        if (role === 'assistant') {
          const segments = this.deps.toMessageThinkingSegments(msg);
          if (segments && segments.length > 0) {
            if (event.type === 'message_end') {
              this.lastSegmentTexts.clear();
              segments.forEach((seg, i) => {
                if (!seg.thinking && !seg.redacted) return;
                this.deps.emit?.({
                  ...envelope,
                  type: 'thinking.final',
                  role: 'assistant',
                  messageId,
                  segmentIndex: i,
                  segmentCount: segments.length,
                  content: { thinking: seg.thinking },
                  ...(seg.redacted ? { thinkingRedacted: true } : {}),
                });
              });
              msgEnvelope = this.freshEnvelope();
            } else {
              // 流式:每段独立比较文本增长,逐段发射 partial(块边界保留)。
              segments.forEach((seg, i) => {
                const prev = this.lastSegmentTexts.get(i) ?? '';
                if (seg.thinking && seg.thinking !== prev) {
                  this.lastSegmentTexts.set(i, seg.thinking);
                  this.deps.emit?.({
                    ...envelope,
                    type: 'thinking.partial',
                    role: 'assistant',
                    messageId,
                    segmentIndex: i,
                    segmentCount: segments.length,
                    content: { thinking: seg.thinking },
                  });
                }
              });
              msgEnvelope = this.freshEnvelope();
            }
          }
        }

        if (role === 'assistant' && !content.text && event.type === 'message_end') return null;

        if (role === 'user') {
          return { ...msgEnvelope, type: 'message.final', role, messageId, content };
        }
        if (!content.text && event.type !== 'message_end') return null;
        return {
          ...msgEnvelope,
          type: event.type === 'message_end' ? 'message.final' : 'message.partial',
          role,
          messageId,
          content,
        };
      }

      case 'tool_execution_start': {
        const target = this.deps.toToolTarget(event.toolName, event.args);
        this.toolArgsByCall.set(event.toolCallId, event.args);
        return {
          ...envelope,
          type: 'tool.start',
          toolName: event.toolName,
          target,
          callId: event.toolCallId,
          args: event.args,
        };
      }

      case 'tool_execution_update': {
        const target = this.deps.toToolTarget(event.toolName, event.args);
        return {
          ...envelope,
          type: 'tool.update',
          toolName: event.toolName,
          target,
          callId: event.toolCallId,
          delta: typeof event.partialResult === 'string' ? event.partialResult : '',
          args: event.args,
        };
      }

      case 'tool_execution_end': {
        const target = this.deps.toToolTarget(
          event.toolName,
          this.toolArgsByCall.get(event.toolCallId) ?? event.result,
        );
        this.toolArgsByCall.delete(event.toolCallId);
        // tool_execution_end.result 是 AgentToolResult 对象({content, details}),
        // 不是字符串:edit 的 diff 在 details.diff(纯文本),其余工具结果在
        // content 文本块。统一提取为展示文本。
        const result = extractToolResultText(event.result);

        // M4 (Oracle ): if the safety interceptor surfaced a blocked
        // result via the SDK's tool_execution_end (isError + safetyNote prefix),
        // emit tool.blocked for the renderer. The Extension's emitBlocked
        // callback may also fire earlier — both paths converge on the same
        // event shape so duplicate suppression happens at the renderer.
        if (event.isError && BLOCKED_SAFETY_PREFIXES.some((p) => result.startsWith(p))) {
          if (this.deps.onToolEnd) this.deps.onToolEnd(event.toolName, target);
          return {
            ...envelope,
            type: 'tool.blocked',
            toolName: event.toolName,
            target,
            callId: event.toolCallId,
            safetyNote: result,
          };
        }

        if (this.deps.onToolEnd) {
          this.deps.onToolEnd(event.toolName, target);
        }
        return {
          ...envelope,
          type: 'tool.end',
          toolName: event.toolName,
          target,
          callId: event.toolCallId,
          result,
          ok: !event.isError,
        };
      }

      case 'turn_start':
      case 'agent_start': {
        return { ...envelope, type: 'session.status', status: 'streaming' };
      }

      case 'turn_end':
      case 'agent_end':
      case 'agent_settled': {
        return { ...envelope, type: 'session.status', status: 'idle' };
      }

      default:
        return null;
    }
  }

  statusForEvent(event: AgentSessionEvent): SessionStatus | null {
    switch (event.type) {
      // N1 (Oracle ): turn_start / agent_start open a streaming turn
      // but the first tool_execution_start is what flips to tool-running.
      // Status must agree with the session.status event the mapper emits.
      case 'turn_start':
      case 'agent_start':
        return 'streaming';
      case 'tool_execution_start':
        return 'tool-running';
      case 'turn_end':
      case 'agent_end':
      case 'agent_settled':
        return 'idle';
      default:
        return null;
    }
  }

  /**
 * Project an in-memory AgentMessage[] (already deserialized from the JSONL
 * by SessionManager.open) into the same AgentEvent envelope the live event
 * stream emits. Used at session registration time to give the renderer
 * the historical conversation without re-parsing the JSONL ourselves.
 *
 * The discriminator is `msg.role`:
 * - 'user' / 'assistant' → message.final
 * - tool calls inside assistant content → tool.start
 * - 'toolResult' → tool.end
 * - internal messages (bashExecution / branchSummary / compactionSummary
 * / custom) → null (status / VM internals; not chat content)
 */
  replayFromMessages(messages: readonly AgentMessage[]): AgentEvent[] {
    const out: AgentEvent[] = [];
    // toolUse input 缓存:toolResult 消息不带调用参数,target 需从调用侧取。
    const replayToolInputs = new Map<string, unknown>();
    for (const msg of messages) {
      const role = (msg as { role?: string }).role;
      // pi-ai Message 自带 timestamp(ms):重放事件用它替代 Date.now,
      // 否则同步循环内所有事件 ts 几乎同刻,回合标记的耗时恒 ≈0 不显示。
      const rawTs = (msg as { timestamp?: unknown }).timestamp;
      const msgTs = typeof rawTs === 'number' && Number.isFinite(rawTs) ? rawTs : undefined;
      // 持久化消息 id → messageId 稳定源(重复打开会话时 reducer 折叠槽按
      // messageId 收敛,重放不会整段重复;旧文件无 id → 回退随机)。
      const stableMessageId = (m: unknown): string | undefined => {
        const raw = (m as { id?: unknown }).id;
        return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
      };
      // 每事件独立 envelope(eventId/seq 各自递增),仅覆盖 ts:
      const env = (): { sessionId: string; eventId: string; seq: number; ts: number } =>
        msgTs !== undefined ? { ...envelope(this.deps), ts: msgTs } : envelope(this.deps);
      switch (role) {
        case 'user': {
          const text = extractText((msg as { content?: unknown }).content);
          // 显示卫生(走查实证):重放路径同样剥离召回注入块(实时路径在
          // toMessageContent,此处是历史会话重放的独立分支,曾漏剥)。
          out.push(
            makeMessageFinal(
              'user',
              stripRecallContext(text),
              this.deps,
              msgTs,
              stableMessageId(msg),
            ),
          );
          break;
        }
        case 'assistant': {
          const content = (msg as { content?: unknown }).content;
          const messageId = stableMessageId(msg) ?? crypto.randomUUID();
          // 块序保真:thinking/toolCall 按 content 块数组原始顺序
          // 交错发射,位置 = 段首现处;text 块累积为消息末尾的 message.final。
          // 曾用三段分离遍历(thinking 全前置/工具全后置),与实时路径的事件
          // 到达顺序不符——重放与实时展示不一致(M1 修复)。
          const textParts: string[] = [];
          // SDK 持久化块是 toolCall(id/name/arguments);历史实现曾用
          // toolUse(id/name/input) 形状——双形状都认,防格式漂移。
          const toolUses: Array<{
            id?: string;
            name?: string;
            input?: unknown;
            arguments?: unknown;
          }> = [];
          const thinkingBlocks: Array<{ thinking: string; redacted?: boolean }> = [];
          // 发射骨架:thinking/tool 按块序交错(索引指向各自收集数组)。
          const emitOrder: Array<'thinking' | 'tool'> = [];
          if (Array.isArray(content)) {
            for (const block of content) {
              const t = (block as { type?: string }).type;
              if (t === 'text') {
                textParts.push(extractText(block));
              } else if (t === 'toolUse' || t === 'toolCall') {
                toolUses.push(block as { id?: string; name?: string; input?: unknown });
                emitOrder.push('tool');
              } else if (t === 'thinking') {
                const seg = block as { thinking?: unknown; redacted?: unknown };
                thinkingBlocks.push({
                  thinking: String(seg.thinking ?? ''),
                  redacted: seg.redacted ? true : undefined,
                });
                emitOrder.push('thinking');
              }
            }
          } else {
            textParts.push(extractText(content));
          }
          let thinkIdx = 0;
          let toolIdx = 0;
          for (const kind of emitOrder) {
            if (kind === 'thinking') {
              const seg = thinkingBlocks[thinkIdx];
              thinkIdx += 1;
              if (!seg.thinking && !seg.redacted) continue;
              out.push({
                ...env(),
                type: 'thinking.final',
                role: 'assistant',
                messageId,
                segmentIndex: thinkIdx - 1,
                segmentCount: thinkingBlocks.length,
                content: { thinking: seg.thinking },
                ...(seg.redacted ? { thinkingRedacted: true } : {}),
              });
            } else {
              const tu = toolUses[toolIdx];
              toolIdx += 1;
              const toolName = String(tu.name ?? '');
              const input = tu.input ?? tu.arguments;
              if (tu.id) replayToolInputs.set(tu.id, input);
              out.push({
                ...env(),
                type: 'tool.start',
                toolName,
                target: this.deps.toToolTarget(toolName, input),
                callId: tu.id,
              });
            }
          }
          const joined = textParts.filter(Boolean).join('\n');
          if (joined) {
            out.push({
              ...env(),
              type: 'message.final',
              role: 'assistant',
              messageId,
              content: { text: joined },
            });
          }
          break;
        }
        case 'toolResult': {
          const tr = msg as {
            toolUseId?: string;
            toolCallId?: string;
            toolName?: string;
            content?: unknown;
            details?: unknown;
            isError?: boolean;
          };
          const toolName = String(tr.toolName ?? 'tool');
          // 持久化字段名兼容:JSONL 里是 toolCallId,历史实现用 toolUseId。
          const callId = tr.toolUseId ?? tr.toolCallId;
          // 与实时路径同款提取:edit 的 diff 在 details.diff(JSONL 持久化了
          // details),其余工具结果在 content 文本块。
          const result = extractToolResultText({ content: tr.content, details: tr.details });
          const target = this.deps.toToolTarget(
            toolName,
            (callId && replayToolInputs.get(callId)) ?? tr.content,
          );
          // 与实时路径同款 blocked 判定(isError + 拦截前缀表):重放历史被拦
          // 调用 → tool.blocked 而非 tool.end(双路径语义一致,M2 修复)。
          if (tr.isError && BLOCKED_SAFETY_PREFIXES.some((p) => result.startsWith(p))) {
            out.push({
              ...env(),
              type: 'tool.blocked',
              toolName,
              target,
              callId,
              safetyNote: result,
            });
            break;
          }
          out.push({
            ...env(),
            type: 'tool.end',
            toolName,
            target,
            callId,
            result,
            ok: !tr.isError,
          });
          break;
        }
        default:
          // bashExecution / branchSummary / compactionSummary / custom → not
          // chat content; drop silently so history is clean.
          break;
      }
    }
    return out;
  }
}

function envelope(deps: MapperDeps) {
  return {
    sessionId: deps.sessionId,
    eventId: crypto.randomUUID(),
    seq: deps.nextSeq(),
    ts: Date.now(),
  };
}

function makeMessageFinal(
  role: 'user' | 'assistant',
  text: string,
  deps: MapperDeps,
  ts?: number,
  messageId?: string,
): AgentEvent {
  return {
    ...envelope(deps),
    ...(ts !== undefined ? { ts } : {}),
    type: 'message.final',
    role,
    messageId: messageId ?? crypto.randomUUID(),
    content: { text },
  };
}

export function extractMessageText(message: unknown): string {
  if (message && typeof message === 'object' && 'content' in message) {
    return extractText((message as { content?: unknown }).content);
  }
  return extractText(message);
}

/**
 * 提取消息内容里的 thinking 块为有序段列表(保留块边界)。
 * 空数组 = 无思考内容。历史 extractThinking(拼接单字符串)被分段版取代——
 * 机械拼接丢失段边界,渲染端无法把思考段与工具调用交替内联。
 */
export function extractThinkingSegments(
  content: unknown,
): Array<{ thinking: string; redacted?: boolean }> {
  const out: Array<{ thinking: string; redacted?: boolean }> = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      const block = c as { type?: string; thinking?: unknown; redacted?: unknown };
      if (block.type === 'thinking') {
        out.push({
          thinking: String(block.thinking ?? ''),
          redacted: block.redacted ? true : undefined,
        });
      }
    }
  } else if (content && typeof content === 'object') {
    const block = content as { type?: string; thinking?: unknown; redacted?: unknown };
    if (block.type === 'thinking') {
      out.push({
        thinking: String(block.thinking ?? ''),
        redacted: block.redacted ? true : undefined,
      });
    }
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const t = (c as { type?: string }).type;
        if (t === 'text') return String((c as { text?: unknown }).text ?? '');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const t = (content as { type?: string }).type;
    if (t === 'text') return String((content as { text?: unknown }).text ?? '');
  }
  return '';
}

/**
 * 实时工具结果提取:tool_execution_end.result 是 AgentToolResult 对象
 * ({ content: TextContent[], details }),不是字符串。edit 的 diff 在
 * details.diff(纯文本,无 ANSI)——对话内 diff 卡的数据源;其余工具结果
 * 在 content 文本块。字符串直通(兼容旧 SDK 行为)。
 */
function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const record = result as { content?: unknown; details?: { diff?: unknown } };
  const diff = record.details?.diff;
  if (typeof diff === 'string' && diff.length > 0) return diff;
  const content = record.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const block = c as { type?: string; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
