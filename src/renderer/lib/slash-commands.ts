import type { MessageKey } from '../../shared/i18n-core';

// 斜杠命令(模仿 pi TUI):composer 输入 /命令 回车执行。
// 模型相关命令(/model /login /logout /settings)由模型配置页承担,不在此列。
// description 为 UI 可见文案,存词条 key,渲染端经 useT 翻译。
export const SLASH_COMMANDS = [
  { name: 'new', descriptionKey: 'slash.new' as MessageKey, hint: '/new' },
  { name: 'compact', descriptionKey: 'slash.compact' as MessageKey, hint: '/compact' },
  { name: 'resume', descriptionKey: 'slash.resume' as MessageKey, hint: '/resume' },
  { name: 'model', descriptionKey: 'slash.model' as MessageKey, hint: '/model' },
  { name: 'settings', descriptionKey: 'slash.settings' as MessageKey, hint: '/settings' },
  { name: 'quit', descriptionKey: 'slash.quit' as MessageKey, hint: '/quit' },
  { name: 'hotkeys', descriptionKey: 'slash.hotkeys' as MessageKey, hint: '/hotkeys' },
  { name: 'copy', descriptionKey: 'slash.copy' as MessageKey, hint: '/copy' },
  { name: 'review', descriptionKey: 'slash.review' as MessageKey, hint: '/review' },
  { name: 'skill', descriptionKey: 'slash.skill' as MessageKey, hint: '/skill' },
] as const;

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]['name'];

/** /review 唯一合法第二 token:weekly;arg 缺省 = daily 语义。 */
export const REVIEW_WEEKLY_ARG = 'weekly';

export type SlashCommandParse =
  | { kind: 'command'; name: SlashCommandName; arg?: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'none' };

/** 识别输入是否形如 /命令。整行纯命令才匹配(pi 行为:命令必须独占一行)。
 * /review 支持可选第二 token(/review weekly);/skill 支持第二 token(技能名,
 * kebab-case 与前端 `[a-z][a-z-]*` 一致);其余命令带第二 token 不拦截(原行为)。
 * /review <其他> /skill <未知名> 解析为 command 但 arg 非法/未知,由消费方(composer)拒绝。 */
export function parseSlashCommand(text: string): SlashCommandParse {
  const m = /^\/([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?$/i.exec(text.trim());
  if (!m) return { kind: 'none' };
  const name = m[1].toLowerCase();
  if (!SLASH_COMMANDS.some((c) => c.name === name)) return { kind: 'unknown', name };
  const arg = m[2]?.toLowerCase();
  if (arg !== undefined && name !== 'review' && name !== 'skill') return { kind: 'none' };
  return arg === undefined
    ? { kind: 'command', name: name as SlashCommandName }
    : { kind: 'command', name: name as SlashCommandName, arg };
}
