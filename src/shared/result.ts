import type { Result as BRResult } from 'better-result';
import { Result as BR } from 'better-result';

export type LorraError = { code: string; message: string };

// Main-side orchestration chain (better-result instance with `match`/`andThen`).
// Internal to the main process; never crosses the IPC boundary.
export type Result<T = void> = BRResult<T, LorraError>;

// IPC envelope: pure data, no methods, survives contextBridge clone. Main
// handlers return this; preload passes it through to the renderer as-is.
// Single shape across the boundary: `ok` discriminates, narrowing works at
// every consumer (`if (res.ok) res.value; else res.error.message`).
export type SerializedResult<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LorraError };

export const ok = BR.ok;
export const err = BR.err;

export function toLorraError(cause: unknown, code = 'internal'): LorraError {
  return {
    code,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

// Boundary conversion: main BR instance -> IPC SerializedResult.
export function toSerialized<T>(result: Result<T>): SerializedResult<T> {
  return result.isOk() ? { ok: true, value: result.value } : { ok: false, error: result.error };
}
