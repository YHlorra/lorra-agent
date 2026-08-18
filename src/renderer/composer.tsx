import type { ClipboardEvent, DragEvent, FormEvent, JSX, KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { SlashCommandName } from '@/lib/slash-commands';
import { parseSlashCommand, REVIEW_WEEKLY_ARG, SLASH_COMMANDS } from '@/lib/slash-commands';
import type { SessionStatus } from '../shared/agent-events';
import type { LorraError } from '../shared/result';
import type { ReviewKind } from '../shared/review-api';
import { useT } from './lib/i18n';

export type ComposerReference =
  | { id: string; fileName: string; text: string; kind?: 'selection' }
  | { id: string; kind: 'file'; fileId: string; fileName: string }
  | { id: string; kind: 'image'; fileId: string; fileName: string; dataUrl: string };

/** /skill 触发时拼进 prompt 的技能正文上限(≈4.5k tokens,对齐 SKILL_BUDGET_WARN_TOKENS 精神)。 */
const SKILL_TRIGGER_CHARS_MAX = 16000;

export interface ComposerProps {
  status: SessionStatus;
  onSend: (text: string, images?: Array<{ fileId: string }>) => void;
  onAbort: () => void;
  /** 斜杠命令(pi TUI 风格):返回 true = 已处理(清空输入),false = 未处理。 */
  onCommand?: (command: SlashCommandName) => boolean | Promise<boolean>;
  /** Inline error to render above the textarea; empty string hides it. */
  inlineError?: string;
  /** Model availability: false → show "model unavailable" banner above composer. */
  modelAvailable?: boolean;
  /** Current default model display name; shown in the composer presence row. */
  defaultModelName?: string | null;
  /** Empty state shown when no events yet for the active session. */
  emptyStateMessage?: string;
  /** 引用胶囊(「问 AI」选区文本 / @ 文件):发送时拼进消息体,发送后清空。 */
  references?: ComposerReference[];
  onClearReferences?: () => void;
  /** @ 文件候选:输入框 @ 前缀时查询工作区文件。 */
  onFileCandidates?: (query: string) => Promise<Array<{ fileId: string; name: string }>>;
  /** @ 文件引用发送时读取文件内容快照;返回 null = 读不到(退化为仅文件名)。 */
  onResolveFileRef?: (fileId: string) => Promise<string | null>;
  /** @ 选中文件后追加引用胶囊(由 App 持有引用列表)。 */
  onAppendReference?: (ref: ComposerReference) => void;
  /** 当前工作区绝对路径(拖拽文件 → 工作区内相对路径填充;缺省 = 原样绝对路径)。 */
  workspacePath?: string | null;
  /** 待发送队列(2026-08-17):agent 忙碌时发送的消息在此排队,空闲后按序自动发出。 */
  queue?: Array<{ id: string; text: string }>;
  /** 忙碌时发送 → 入队(替代 onSend;App 层负责出队与打断语义)。 */
  onQueue?: (text: string) => void;
  /** 撤回队列消息。 */
  onQueueRemove?: (id: string) => void;
  /** 原地修正队列消息文本。 */
  onQueueEdit?: (id: string, text: string) => void;
  /** 立即发送该队列消息并打断当前 agent 轮次。 */
  onQueueSendNow?: (id: string) => void;
}

export function Composer({
  status,
  onSend,
  onAbort,
  onCommand,
  inlineError = '',
  modelAvailable = true,
  defaultModelName,
  emptyStateMessage,
  references,
  onClearReferences,
  onFileCandidates,
  onResolveFileRef,
  onAppendReference,
  workspacePath,
  queue,
  onQueue,
  onQueueRemove,
  onQueueEdit,
  onQueueSendNow,
}: ComposerProps): JSX.Element {
  const t = useT();
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 未识别的斜杠命令提示(如 /foo):不清空输入,用户可继续编辑。
  const [commandHint, setCommandHint] = useState<string | null>(null);
  // /review 复盘生成反馈(任务 6.10):pending / 成功 / 退化三态互斥错误,文案同 review-rail。
  const [reviewPending, setReviewPending] = useState<ReviewKind | null>(null);
  const [reviewError, setReviewError] = useState<LorraError | null>(null);
  const [reviewDone, setReviewDone] = useState<ReviewKind | null>(null);
  // IDE 式补全菜单:输入 / 开头弹出候选;menuIndex 高亮,menuDismissed 支持 Esc。
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // @ 文件引用菜单:同斜杠菜单模式,候选来自工作区文件搜索。
  const [fileIndex, setFileIndex] = useState(0);
  const [fileMenuDismissed, setFileMenuDismissed] = useState(false);
  const [fileCandidates, setFileCandidates] = useState<Array<{ fileId: string; name: string }>>([]);
  // /skill 触发菜单(2026-08-14):`/skill <前缀>` 弹技能候选,Enter 直接触发。
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  const [skillCandidates, setSkillCandidates] = useState<Array<{ name: string }>>([]);
  // 粘贴/拖拽失败提示(独立于 commandHint:斜杠横幅语义不同)。
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Tracks the last text we attempted to send so we can decide, after
  // `onSend` resolves, whether to clear or restore based on the parent's
  // `inlineError` prop. Clearing eagerly would lose user input on failure.
  const lastSendRef = useRef<{ text: string; settled: boolean } | null>(null);
  // Bumped after onSend resolves so the effect re-runs once the parent
  // dispatch has propagated into the `inlineError` prop.
  const [sendTick, setSendTick] = useState(0);
  const busy = status === 'streaming' || status === 'tool-running';
  // 消息队列(2026-08-17):忙碌时发送不再禁用——消息入队,由 App 在空闲后自动发出;
  // 队列项支持撤回/原地修正/立即发送打断。斜杠命令不受忙碌影响(不走 agent)。
  const sendDisabled = !modelAvailable;
  // 队列原地编辑态:editingId 非空时该项渲染 input(draft),Enter 保存 / Esc 取消。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const queueEditRef = useRef<HTMLInputElement | null>(null);
  // autoFocus 禁用(无障碍,markdown-editable 同款);编辑态挂载后手动聚焦。
  useEffect(() => {
    if (editingId) queueEditRef.current?.focus();
  }, [editingId]);
  const errorMessage =
    inlineError.trim() || (status === 'errored' ? t('composer.errorBanner') : '');
  // 退化三态互斥文案(review-rail 同款):model-unavailable / review-timed-out / 其他。
  const reviewErrorHint =
    reviewError?.code === 'model-unavailable'
      ? t('composer.reviewNoModel')
      : reviewError?.code === 'review-timed-out'
        ? // #N2 超时提示:重试指引由前端给出,不依赖后端消息;不得混入 model-unavailable 专属文案。
          t('composer.reviewTimeout')
        : reviewError
          ? t('composer.reviewFailed', { message: reviewError.message })
          : null;

  // Decide clear vs. restore AFTER the parent's dispatch settles:
  // - inlineError non-empty → failure, keep the user's text.
  // - inlineError empty → success, drop the text.
  // The `settled` flag prevents a pre-await tick from clearing prematurely.
  useEffect(() => {
    const pending = lastSendRef.current;
    if (!pending?.settled) return;
    if (inlineError) {
      setMessage(pending.text);
    } else {
      setMessage('');
    }
    lastSendRef.current = null;
  }, [inlineError, sendTick]);

  // 菜单状态:整行 / 前缀 + 未 Esc 关闭 → 弹出;候选按前缀过滤。
  const slashPrefix = /^\/([a-z]*)$/.exec(message.trim())?.[1]?.toLowerCase() ?? null;
  const menuOpen = slashPrefix !== null && !menuDismissed;
  const candidates = menuOpen
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashPrefix ?? ''))
    : [];
  const activeIndex = Math.min(menuIndex, Math.max(candidates.length - 1, 0));

  // @ 文件引用:光标在末尾时 `@前缀` 触发候选(与斜杠菜单互斥)。
  const filePrefixMatch = onFileCandidates ? /(^|\s)@([\w.\-/]*)$/.exec(message) : null;
  const filePrefix = filePrefixMatch?.[2] ?? null;
  const fileMenuOpen = filePrefix !== null && !fileMenuDismissed;
  const activeFileIndex = Math.min(fileIndex, Math.max(fileCandidates.length - 1, 0));

  // /skill 触发(2026-08-14):`/skill <前缀>`(kebab-case 与 parseSlashCommand 同口径)
  // 弹技能候选菜单;候选来自 skills.xray 全量发现(渲染端过滤,复用管理页同一发现面)。
  const skillPrefixMatch = /^\/skill\s+([a-z0-9-]*)$/i.exec(message);
  const skillPrefix = skillPrefixMatch?.[1]?.toLowerCase() ?? null;
  const skillMenuOpen =
    skillPrefix !== null && !skillMenuDismissed && Boolean(window.lorra?.skills?.xray);
  const activeSkillIndex = Math.min(skillIndex, Math.max(skillCandidates.length - 1, 0));

  // 候选按前缀异步加载(搜索主进程工作区)。
  useEffect(() => {
    if (!fileMenuOpen || !onFileCandidates) {
      setFileCandidates([]);
      return;
    }
    let cancelled = false;
    void onFileCandidates(filePrefix ?? '').then((list) => {
      if (!cancelled) setFileCandidates(list);
    });
    return () => {
      cancelled = true;
    };
  }, [filePrefix, fileMenuOpen, onFileCandidates]);

  // 技能候选:菜单开启时拉一次 xray,客户端按前缀过滤(命中面 = 管理页五源发现)。
  useEffect(() => {
    if (!skillMenuOpen) {
      setSkillCandidates([]);
      return;
    }
    let cancelled = false;
    void window.lorra?.skills?.xray().then((res) => {
      if (cancelled || !res || !res.ok) return;
      const list = res.value.skills
        .filter((s) => s.name.startsWith(skillPrefix ?? ''))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20)
        .map((s) => ({ name: s.name }));
      if (!cancelled) setSkillCandidates(list);
    });
    return () => {
      cancelled = true;
    };
  }, [skillPrefix, skillMenuOpen]);

  /** @ 选中文件:删输入末尾 @前缀,追加文件引用胶囊。 */
  function selectFileRef(candidate: { fileId: string; name: string }): void {
    const match = /(^|\s)@([\w.\-/]*)$/.exec(message);
    if (!match) return;
    // 保留 @ 前的空格/行首,只去掉 @前缀 本身。
    setMessage(message.slice(0, match.index + match[1].length));
    setFileMenuDismissed(true);
    onAppendReference?.({
      id: crypto.randomUUID(),
      kind: 'file',
      fileId: candidate.fileId,
      fileName: candidate.name,
    });
  }

  /** 执行 /review:composer 直接经 window.lorra.review.generate 生成(不回调 onCommand)。 */
  async function runReview(kind: ReviewKind): Promise<void> {
    if (reviewPending !== null) return;
    setReviewPending(kind);
    setReviewError(null);
    setReviewDone(null);
    try {
      const res = await window.lorra?.review?.generate({ kind });
      if (!res) throw new Error(t('composer.reviewUnavailable'));
      if (res.ok) setReviewDone(kind);
      else setReviewError(res.error);
    } catch (err) {
      setReviewError({
        code: 'review-generate-failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setReviewPending(null);
    }
  }

  /** 触发 /skill:读技能原文 → 拼「按技能执行」prompt 走正常发送(失败保留输入,同普通发送)。 */
  async function runSkill(name: string): Promise<void> {
    if (!window.lorra?.skills?.read) {
      setCommandHint(t('composer.skillUnavailable'));
      return;
    }
    try {
      const res = await window.lorra.skills.read(name);
      if (!res.ok) {
        setCommandHint(res.error?.message ?? t('composer.skillUnavailable'));
        return;
      }
      const raw = res.value.content;
      const content =
        raw.length > SKILL_TRIGGER_CHARS_MAX
          ? `${raw.slice(0, SKILL_TRIGGER_CHARS_MAX)}\n…（已截断）`
          : raw;
      const prompt = `${t('composer.skillPrompt', { name: res.value.name })}\n\n${content}`;
      lastSendRef.current = { text: prompt, settled: false };
      try {
        await onSend(prompt);
      } finally {
        onClearReferences?.();
        setSkillMenuDismissed(true);
      }
      if (lastSendRef.current) lastSendRef.current.settled = true;
      setSendTick((n) => n + 1);
      setCommandHint(null);
      setMessage('');
      setMenuDismissed(true);
    } catch (err) {
      setCommandHint(err instanceof Error ? err.message : t('composer.skillUnavailable'));
    }
  }

  /** 执行斜杠命令:处理后清空输入(命令方负责成败反馈)。 */
  async function runCommand(name: SlashCommandName, arg?: string): Promise<void> {
    if (name === 'review') {
      // /review <其他> 参数非法:不清空输入,用户可继续编辑(同未知命令行为)。
      if (arg !== undefined && arg !== REVIEW_WEEKLY_ARG) {
        setCommandHint(t('composer.reviewBadArg', { arg, weekly: REVIEW_WEEKLY_ARG }));
        return;
      }
      await runReview(arg === REVIEW_WEEKLY_ARG ? 'weekly' : 'daily');
      setCommandHint(null);
      setMessage('');
      setMenuDismissed(true);
      return;
    }
    if (name === 'skill') {
      // /skill 缺技能名:用法提示,不清空输入;菜单路径(有候选)直接触发。
      if (arg === undefined) {
        setCommandHint(t('composer.skillUsage'));
        return;
      }
      await runSkill(arg);
      return;
    }
    const handled = (await onCommand?.(name)) ?? false;
    if (handled) {
      setCommandHint(null);
      setMessage('');
      setMenuDismissed(true);
    }
  }

  /**
 * 粘贴图片(2026-08-14):剪贴板含图片项时走主进程保存 + 图片胶囊;纯文本粘贴
 * 走默认行为(不 preventDefault)。判定基于 paste 事件 clipboardData(同步),
 * 字节读取交给主进程 clipboard.readImage(单一事实源)。
 */
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const hasImage = Array.from(event.clipboardData?.items ?? []).some(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    );
    if (!hasImage) return;
    event.preventDefault();
    if (!window.lorra?.clipboard?.saveImage) return;
    void window.lorra.clipboard
      .saveImage()
      .then((res) => {
        if (!res.ok) {
          setAttachmentError(res.error?.message ?? t('composer.pasteFailed'));
          return;
        }
        setAttachmentError(null);
        onAppendReference?.({
          id: crypto.randomUUID(),
          kind: 'image',
          fileId: res.value.fileId,
          fileName: res.value.name,
          dataUrl: res.value.dataUrl,
        });
      })
      .catch(() => setAttachmentError(t('composer.pasteFailed')));
  }

  /** 拖拽文件 → 自动填充文件地址(2026-08-14):工作区内 → 相对路径,区外 → 绝对路径。 */
  function handleDrop(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const paths = files.map((f) => pathForDrop(f)).filter((p): p is string => p !== null);
    if (paths.length === 0) return;
    // 已有文本(光标前非空白)→ 路径块前补换行,每文件独立一行。
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? message.length;
    const prefix = cursor > 0 && !/\s$/.test(message.slice(0, cursor)) ? '\n' : '';
    const inserted = `${prefix}${paths.join('\n')}`;
    setMessage(message.slice(0, cursor) + inserted + message.slice(cursor));
    // 光标移到插入内容之后(下帧执行,等受控 textarea 落值)。
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.setSelectionRange(cursor + inserted.length, cursor + inserted.length);
    });
    setAttachmentError(null);
    setMenuDismissed(true);
    setFileMenuDismissed(true);
    setSkillMenuDismissed(true);
  }

  /** 拖入悬停需阻止默认(否则浏览器打开文件);与 onDrop 配套。 */
  function handleDragOver(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
  }

  /** 拖拽文件 → 填充文本:工作区内相对路径(posix 分隔,agent cwd=工作区可直接读),区外绝对路径。 */
  function pathForDrop(file: File): string | null {
    const abs = window.lorra?.fs?.getPathForFile?.(file) ?? '';
    if (!abs) return null;
    if (!workspacePath) return abs;
    const norm = abs.replace(/\\/g, '/');
    const wsNorm = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.toLowerCase().startsWith(wsNorm.toLowerCase())) {
      const rel = norm.slice(wsNorm.length).replace(/^\/+/, '');
      return rel || abs;
    }
    return abs;
  }

  async function send(): Promise<void> {
    const text = message.trim();
    const parsed = parseSlashCommand(text);
    if (parsed.kind === 'command') {
      // 斜杠命令:执行后清空输入(pi TUI 行为);命令处理方负责成败反馈。
      await runCommand(parsed.name, parsed.arg);
      return;
    }
    if (parsed.kind === 'unknown') {
      setCommandHint(
        t('composer.unknownCommand', {
          name: parsed.name,
          hints: SLASH_COMMANDS.map((c) => c.hint).join(' '),
        }),
      );
      return;
    }
    if (commandHint) setCommandHint(null);
    if (!text || !modelAvailable) return;
    // 引用胶囊(「问 AI」选区 + @ 文件):拼进消息体后发送;无论成败发送后都清空
    // 胶囊(失败时用户输入由 lastSendRef 恢复,引用已进消息体,不恢复)。
    const blocks: string[] = [];
    const imageFileIds: Array<{ fileId: string }> = [];
    for (const r of references ?? []) {
      if (r.kind === 'file') {
        // @ 文件:发送时读内容快照进 prompt;读不到 → 仅文件名。
        const content = await onResolveFileRef?.(r.fileId);
        if (content) {
          const truncated =
            content.length > 2000 ? `${content.slice(0, 2000)}\n…（已截断）` : content;
          blocks.push(`[文件] ${r.fileName}\n\`\`\`\n${truncated}\n\`\`\``);
        } else {
          blocks.push(`[文件] ${r.fileName}`);
        }
      } else if (r.kind === 'image') {
        // 粘贴图片(2026-08-15):图片字节经 onSend 第二参作为视觉内容块传给模型,
        // 消息体只留一行文本说明(不带断连的 Markdown 图片路径)。非视觉模型下
        // 该说明让模型知道有图但不依赖它 read。
        blocks.push(`[图片] ${r.fileName}\n（图片已作为附件随消息发送，请查看此图片）`);
        imageFileIds.push({ fileId: r.fileId });
      } else {
        blocks.push(
          `[引用] ${r.fileName}\n> ${r.text.length > 500 ? `${r.text.slice(0, 500)}…` : r.text}`,
        );
      }
    }
    const refBlock = blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
    // 忙碌 → 入队(2026-08-17 消息队列):最终文本(含引用块)进队列,空闲后由 App
    // 自动按序发送;输入立即清空。ponytail:队列项只存文本,粘贴图片附件不随队
    // (视觉块依赖发送时模型能力判定,排队重放会失真——文字说明仍在,升级路径是
    // 队列项存 images 元数据并在出队时重新组装)。
    if (busy) {
      onQueue?.(refBlock + text);
      onClearReferences?.();
      setMessage('');
      return;
    }
    lastSendRef.current = { text, settled: false };
    try {
      await onSend(refBlock + text, imageFileIds.length > 0 ? imageFileIds : undefined);
    } finally {
      onClearReferences?.();
      setFileMenuDismissed(true);
    }
    // Mark settled AND bump tick in the same batch so the effect sees a
    // settled ref with the latest inlineError (parent dispatch happened
    // inside onSend and React will batch them together).
    if (lastSendRef.current) lastSendRef.current.settled = true;
    setSendTick((n) => n + 1);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    send();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // /skill 候选菜单:↑/↓ 选择,Enter 直接触发,Tab 补全命令文本,Esc 关闭。
    if (skillMenuOpen && skillCandidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSkillIndex((i) => Math.min(i + 1, skillCandidates.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSkillIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void runSkill(skillCandidates[activeSkillIndex].name);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        setMessage(`/skill ${skillCandidates[activeSkillIndex].name}`);
        setSkillMenuDismissed(true);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSkillMenuDismissed(true);
        return;
      }
    }
    // @ 文件菜单:↑/↓ 选择,Enter 选中成胶囊,Esc 关闭。
    if (fileMenuOpen && fileCandidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setFileIndex((i) => Math.min(i + 1, fileCandidates.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setFileIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        selectFileRef(fileCandidates[activeFileIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setFileMenuDismissed(true);
        return;
      }
    }
    // 补全菜单开启:↑/↓ 选择、Tab 补全、Enter 执行高亮项、Esc 关闭(IDE 行为)。
    if (menuOpen && candidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMenuIndex((i) => Math.min(i + 1, candidates.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMenuIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        setMenuDismissed(true);
        setMessage(`/${candidates[activeIndex].name}`);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void runCommand(candidates[activeIndex].name);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    // 斜杠命令(pi TUI):整行命令时 Enter 直接执行(命令无需换行)。
    if (event.key === 'Enter') {
      if (parseSlashCommand(message).kind !== 'none') {
        event.preventDefault();
        send();
        return;
      }
      // Enter 发送(2026-08-09 UX 调整:回车即发送);Ctrl+Enter 换行(textarea 默认插入)。
      if (!event.ctrlKey) {
        event.preventDefault();
        send();
      }
    }
  }

  return (
    <div className="composer-region">
      {emptyStateMessage ? (
        <div className="composer-empty-state" role="status">
          <span className="composer-empty-rule" aria-hidden="true" />
          <p>{emptyStateMessage}</p>
          <span className="composer-empty-rule" aria-hidden="true" />
        </div>
      ) : null}

      {commandHint ? (
        <div className="composer-banner composer-banner-warning" role="status">
          <strong>{t('composer.slashCommand')}</strong>
          <span>{commandHint}</span>
        </div>
      ) : null}

      {attachmentError ? (
        <div className="composer-banner composer-banner-warning" role="status">
          <strong>{t('composer.referenceImage')}</strong>
          <span>{attachmentError}</span>
        </div>
      ) : null}

      {/* /review 反馈:生成中 / 成功 / 退化三态错误(文案与判别同 review-rail)。 */}
      {reviewPending !== null && (
        <div className="composer-banner" role="status" data-testid="review-pending">
          <strong>{t('composer.review')}</strong>
          <span>
            {t('composer.reviewing', {
              label:
                reviewPending === 'daily'
                  ? t('composer.review.daily')
                  : t('composer.review.weekly'),
            })}
          </span>
        </div>
      )}
      {reviewDone !== null && (
        <div className="composer-banner" role="status" data-testid="review-done">
          <strong>{t('composer.review')}</strong>
          <span>{t('composer.reviewDone')}</span>
        </div>
      )}
      {reviewError !== null && (
        <div
          className="composer-banner composer-banner-error"
          role="alert"
          data-testid="review-error"
        >
          <strong>{t('composer.review')}</strong>
          <span>{reviewErrorHint}</span>
        </div>
      )}

      {!modelAvailable ? (
        <div className="composer-banner composer-banner-warning" role="status">
          <strong>{t('composer.modelUnavailable')}</strong>
          <span>{t('composer.modelUnavailableDesc')}</span>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="composer-banner composer-banner-error" role="alert">
          <strong>{t('composer.sendFailed')}</strong>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {/* 2026-08-13 去 AI 味:移除 MagicUI 光束扫边(border-beam)。busy 语义由
 思考环 + presence 文案承担(§Thinking Orb 统一视觉语言)。 */}
      <form
        className={`composer composer-${status}`}
        onSubmit={handleSubmit}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <label htmlFor="agent-message">{t('composer.inputLabel')}</label>
        {/* 待发送队列(2026-08-17):忙碌时发送的消息排队于此,支持撤回/原地修正/
 立即发送打断;Agent 空闲后按序自动发出。 */}
        {queue && queue.length > 0 ? (
          <ul className="composer-queue" aria-label={t('composer.queueLabel')}>
            <li className="composer-queue-hint" aria-hidden="true">
              {t('composer.queueHint')}
            </li>
            {queue.map((item, i) => (
              <li key={item.id} className="composer-queue-item">
                <span className="composer-queue-index">{i + 1}</span>
                {editingId === item.id ? (
                  <>
                    <input
                      ref={queueEditRef}
                      className="composer-queue-edit"
                      aria-label={t('composer.queueEditInput')}
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const next = editDraft.trim();
                          if (next) onQueueEdit?.(item.id, next);
                          setEditingId(null);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingId(null);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="composer-queue-btn"
                      onClick={() => {
                        const next = editDraft.trim();
                        if (next) onQueueEdit?.(item.id, next);
                        setEditingId(null);
                      }}
                    >
                      {t('composer.queueSave')}
                    </button>
                    <button
                      type="button"
                      className="composer-queue-btn"
                      onClick={() => setEditingId(null)}
                    >
                      {t('composer.queueCancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="composer-queue-text">{item.text}</span>
                    <button
                      type="button"
                      className="composer-queue-btn"
                      aria-label={t('composer.queueEdit')}
                      onClick={() => {
                        setEditingId(item.id);
                        setEditDraft(item.text);
                      }}
                    >
                      {t('composer.queueEdit')}
                    </button>
                    <button
                      type="button"
                      className="composer-queue-btn"
                      aria-label={t('composer.queueRemove')}
                      onClick={() => onQueueRemove?.(item.id)}
                    >
                      {t('composer.queueRemove')}
                    </button>
                    <button
                      type="button"
                      className="composer-queue-btn composer-queue-send"
                      aria-label={t('composer.queueSendNow')}
                      onClick={() => onQueueSendNow?.(item.id)}
                    >
                      {t('composer.queueSendNow')}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {references && references.length > 0 ? (
          <ul className="composer-references" aria-label={t('composer.referencesLabel')}>
            {references.map((r) => (
              <li key={r.id} className="composer-reference">
                {r.kind === 'file' && (
                  <span className="composer-reference-kind">{t('composer.referenceFile')}</span>
                )}
                {r.kind === 'image' && (
                  <>
                    <span className="composer-reference-kind">{t('composer.referenceImage')}</span>
                    <img
                      className="composer-reference-thumb"
                      src={r.dataUrl}
                      alt=""
                      aria-hidden="true"
                    />
                  </>
                )}
                <span className="composer-reference-file">{r.fileName}</span>
                {r.kind !== 'file' && r.kind !== 'image' && (
                  <span className="composer-reference-text">
                    {r.text.length > 40 ? `${r.text.slice(0, 40)}…` : r.text}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={t('composer.removeReference')}
                  onClick={onClearReferences}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          id="agent-message"
          aria-label={t('composer.inputLabel')}
          value={message}
          ref={textareaRef}
          onChange={(event) => {
            setMessage(event.target.value);
            setMenuDismissed(false);
            setMenuIndex(0);
            setFileMenuDismissed(false);
            setFileIndex(0);
            setSkillMenuDismissed(false);
            setSkillIndex(0);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t('composer.placeholder')}
          rows={3}
          aria-haspopup="listbox"
        />
        {fileMenuOpen && fileCandidates.length > 0 && (
          <div
            id="file-ref-menu"
            className="slash-menu"
            role="listbox"
            aria-label={t('composer.fileMenu')}
          >
            {fileCandidates.map((c, i) => (
              <button
                type="button"
                id={`file-ref-opt-${c.fileId}`}
                key={c.fileId}
                role="option"
                aria-selected={i === activeFileIndex}
                className={`slash-menu-item${i === activeFileIndex ? ' slash-menu-item-active' : ''}`}
                onMouseEnter={() => setFileIndex(i)}
                onMouseDown={(e) => {
                  // 点击选中:阻止 textarea 失焦导致的菜单关闭时序问题
                  e.preventDefault();
                  selectFileRef(c);
                }}
              >
                <span className="slash-menu-hint">@</span>
                <span className="slash-menu-desc">{c.name}</span>
              </button>
            ))}
          </div>
        )}
        {skillMenuOpen && skillCandidates.length > 0 && (
          <div
            id="skill-menu"
            className="slash-menu"
            role="listbox"
            aria-label={t('composer.skillMenu')}
          >
            {skillCandidates.map((c, i) => (
              <button
                type="button"
                id={`skill-opt-${c.name}`}
                key={c.name}
                role="option"
                aria-selected={i === activeSkillIndex}
                className={`slash-menu-item${i === activeSkillIndex ? ' slash-menu-item-active' : ''}`}
                onMouseEnter={() => setSkillIndex(i)}
                onMouseDown={(e) => {
                  // 点击触发:阻止 textarea 失焦导致的菜单关闭时序问题
                  e.preventDefault();
                  void runSkill(c.name);
                }}
              >
                <span className="slash-menu-hint">技能</span>
                <span className="slash-menu-desc">{c.name}</span>
              </button>
            ))}
          </div>
        )}
        {menuOpen && candidates.length > 0 && (
          <div
            id="slash-command-menu"
            className="slash-menu"
            role="listbox"
            aria-label={t('composer.slashMenu')}
          >
            {candidates.map((c, i) => (
              <button
                type="button"
                id={`slash-opt-${c.name}`}
                key={c.name}
                role="option"
                aria-selected={i === activeIndex}
                className={`slash-menu-item${i === activeIndex ? ' slash-menu-item-active' : ''}`}
                onMouseEnter={() => setMenuIndex(i)}
                onClick={() => void runCommand(c.name)}
              >
                <span className="slash-menu-hint">{c.hint}</span>
                <span className="slash-menu-desc">{t(c.descriptionKey)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-actions">
          <div className="composer-presence" aria-live="polite">
            {status === 'streaming' ? (
              <>
                <span className="composer-status-dot is-streaming" aria-hidden="true" />
                <span>{t('composer.answering')}</span>
              </>
            ) : status === 'tool-running' ? (
              <>
                <span className="composer-spinner" aria-hidden="true" />
                <span>{t('composer.usingTools')}</span>
              </>
            ) : (
              <>
                {defaultModelName && (
                  <span className="composer-model-name">{defaultModelName}</span>
                )}
                <span className="composer-shortcut">{t('composer.sendHint')}</span>
              </>
            )}
          </div>

          {busy ? (
            <button
              className="stop-button"
              type="button"
              onClick={onAbort}
              aria-label={t('composer.stopLabel')}
            >
              <span aria-hidden="true" />
              {t('composer.stop')}
            </button>
          ) : null}
          <button
            className="send-button"
            type="submit"
            disabled={sendDisabled}
            aria-disabled={sendDisabled}
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
