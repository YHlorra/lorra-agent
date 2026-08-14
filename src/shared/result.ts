import type { Result as BRResult } from 'better-result';
import { Result as BR } from 'better-result';

export type LorraError = { code: string; message: string };

// Main-side orchestration chain (better-result instance with `match`/`andThen`).
// Internal to the main process; never crosses the IPC boundary.
export type Result<T = void> = BRResult<T, LorraError>;

// IPC envelope: pure data, no methods, survives contextBridge clone. Main
// handlers return this; preload passes it through to the renderer as-is.
export type SerializedResult<T = void> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: LorraError };

// Renderer/view-side plain shape. Same JSON serialization, but the discriminated
// field is `ok` and the TypeScript narrowing works at the renderer's union call
// sites: `if (res.ok) res.value; else res.error.message`.
export type LorraResult<T = void> =
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
  return result.isOk()
    ? { status: 'ok', value: result.value }
    : { status: 'error', error: result.error };
}

// Inverse: deserialize IPC envelope back to a main-side BR instance.
export function fromSerialized<T>(serialized: SerializedResult<T>): Result<T> {
  return serialized.status === 'ok' ? ok(serialized.value) : err(serialized.error);
}

// Renderer-facing view: collapse IPC envelope into the renderer's `{ok, value,
// error}` discriminated shape. contextBridge already strips methods, so this
// step is purely about renaming the discriminator and dropping `status`.
export function toView<T>(serialized: SerializedResult<T>): LorraResult<T> {
  return serialized.status === 'ok'
    ? { ok: true, value: serialized.value }
    : { ok: false, error: serialized.error };
}
