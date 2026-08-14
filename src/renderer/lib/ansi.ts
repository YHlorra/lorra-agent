/** 剥离 SDK 工具结果里的 ANSI 颜色转义(仅 SGR 序列;diff 渲染只用颜色)。 */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 必须匹配 ESC 控制字符才能剥离 ANSI SGR
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
