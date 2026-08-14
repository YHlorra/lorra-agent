import { app } from 'electron';

/**
 * Serialize any value to a debuggable string while redacting known credential
 * fields. JSON.stringify + a replacer alone returns `'{}'` for Error objects
 * because `name`/`message`/`stack` are non-enumerable own properties — we
 * pre-flatten Errors to enumerable keys so the replacer can walk them.
 *
 * Also avoids throwing on cycles / non-JSON-safe values.
 */
export function safeSerialize(value: unknown): string {
  const flat = flatten(value);
  try {
    return JSON.stringify(flat, (_key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const redacted: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
          if (/(api[_-]?key|token|secret|password|authorization)/i.test(k)) {
            redacted[k] = '***';
          } else {
            redacted[k] = v;
          }
        }
        return redacted;
      }
      return val;
    });
  } catch {
    return `[unserializable: ${String(flat)}]`;
  }
}

function flatten(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      __type: 'Error',
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const [k, v] of Object.entries(value)) {
      out[k] = flatten(v, seen);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => flatten(v, seen));
  if (value instanceof Map) {
    return { __type: 'Map', entries: [...value.entries()].map(([k, v]) => [k, flatten(v, seen)]) };
  }
  if (value instanceof Set) {
    return { __type: 'Set', values: [...value].map((v) => flatten(v, seen)) };
  }
  if (
    typeof (value as { constructor?: { name?: string } }).constructor?.name === 'string' &&
    (value as { constructor?: { name?: string } }).constructor?.name !== 'Object'
  ) {
    const out: Record<string, unknown> = {
      __type: (value as { constructor: { name: string } }).constructor.name,
    };
    for (const [k, v] of Object.entries(value)) {
      out[k] = flatten(v, seen);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = flatten(v, seen);
  }
  return out;
}

export function installUncaughtHandlers(): void {
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', safeSerialize(err));
  });

  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', safeSerialize(reason));
  });

  app.on('render-process-gone', (_event, _webContents, details) => {
    console.error('render-process-gone:', safeSerialize(details));
  });
}
