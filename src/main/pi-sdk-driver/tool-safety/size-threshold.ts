export const SIZE_THRESHOLD_BYTES = 256 * 1024;

export type SizeCheckResult =
  | { ok: true }
  | { ok: false; code: 'size-exceeds-threshold'; actual: number };

export function checkWriteSize(payload: { path: string; content?: string }): SizeCheckResult {
  const actual =
    typeof payload.content === 'string' ? Buffer.byteLength(payload.content, 'utf8') : 0;

  if (actual > SIZE_THRESHOLD_BYTES) {
    return { ok: false, code: 'size-exceeds-threshold', actual };
  }

  return { ok: true };
}
