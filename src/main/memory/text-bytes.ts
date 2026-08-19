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
  // 码点边界调整:二分边界可能落在 astral 字符(代理对)中间。low-1 为孤高代理
  // 时,整对 = text[low-1..low] —— 完整包含(到 low+1)若仍 ≤ maxBytes 则取整对,
  // 否则整体丢弃(2026-08-18 修复,text-bytes.test.ts 回归;只可能少截 0/1 个码元,
  // 容量不变量保持)。
  if (low > 0) {
    const c = text.charCodeAt(low - 1);
    if (c >= 0xd800 && c <= 0xdbff) {
      low = Buffer.byteLength(text.slice(0, low + 1), 'utf8') <= maxBytes ? low + 1 : low - 1;
    }
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
  // 码点边界调整:lo 落在代理对中间时 slice(lo) 开头是孤低代理(对偶高代理在
  // lo-1 被截掉)→ 编码成 U+FFFD。整对 = text[lo-1..lo]:从 lo-1 起完整包含若仍
  // ≤ maxBytes 则取整对,否则前移到 lo+1 丢弃孤儿码元(字节只减不增)。
  if (lo < text.length) {
    const c = text.charCodeAt(lo);
    if (c >= 0xdc00 && c <= 0xdfff) {
      lo = Buffer.byteLength(text.slice(lo - 1), 'utf8') <= maxBytes ? lo - 1 : lo + 1;
    }
  }
  return text.slice(lo);
}
