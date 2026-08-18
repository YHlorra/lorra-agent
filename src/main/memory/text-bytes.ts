/**
 * utf8 字节级截断单源(memory 域共用):二分到整字符边界,不劈开多字节字符。
 * 头部截断(保留前缀)与尾部截断(保留后缀)两个变体,按语义各取所需。
 */

/** utf8 字节级截断,不劈开多字节字符(二分到整字符边界)。 */
export function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/** 按 UTF-8 字节从尾部截断字符串(不切断字符,超出部分从头部去掉)。 */
export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  // 二分找最小字符下标使后缀字节 ≤ maxBytes(从尾部截断 = 保留后缀;
  // 单调:lo 越大后缀字节越少)。返回 text.slice(lo)。
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(mid), 'utf8') <= maxBytes) hi = mid;
    else lo = mid + 1;
  }
  return text.slice(lo);
}
