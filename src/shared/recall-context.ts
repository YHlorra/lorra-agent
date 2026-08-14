/**
 * 召回注入块的包裹标记与显示剥离(2026-08-09 走查实证新增)。
 *
 * 本模块必须保持纯常量 + 纯函数、零 node:* 导入:event-mapper(经 driver)
 * 与 renderer 侧测试图都会引用它——把 node:sqlite 之类拉进 client 打包会
 * 运行期崩溃(同款纪律,见 memory-schema.ts 顶部注释)。
 * 注入格式(driver.maybeInjectRecall):
 * `${marker}\n${block}\n${marker}\n\n${text}`
 * 该文本进入会话 jsonl(raw 只读,SDK 原文保留);显示层(实时映射 + 历史
 * 重放 + 会话标题)用它剥离注入前缀,用户原文一字不动。
 */

/** 注入块包裹标记:driver send 挂点用它包裹召回块,测试以它断言注入文本存在。 */
export const RECALL_CONTEXT_MARKER = '<!-- lorra-memory-recall:reference-only -->';

/**
 * 显示层剥离召回注入块:只剥离 marker 包裹的注入前缀,用户原文一字不动。
 * 非注入消息(无 marker)恒原样返回;无闭合 marker 保守原样返回。
 */
export function stripRecallContext(text: string): string {
  if (!text.includes(RECALL_CONTEXT_MARKER)) return text;
  const start = text.indexOf(RECALL_CONTEXT_MARKER);
  const tail = text.slice(start + RECALL_CONTEXT_MARKER.length);
  const end = tail.indexOf(RECALL_CONTEXT_MARKER);
  if (end === -1) return text; // 无闭合 marker:不剥,保守原样
  const after = tail.slice(end + RECALL_CONTEXT_MARKER.length);
  return after.replace(/^\s*\n*/, '');
}
