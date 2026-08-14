import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
}));

import { safeSerialize } from '../../src/main/pi-sdk-driver/uncaught-handler';

describe('safeSerialize', () => {
  const secretFields = ['apiKey', 'token', 'secret', 'password', 'authorization'];

  it('replaces secret field values with ***', () => {
    for (const field of secretFields) {
      const obj: Record<string, unknown> = {};
      obj[field] = 'sensitive';
      const result = safeSerialize(obj);
      expect(result).toContain('***');
      expect(result).not.toContain('sensitive');
    }
  });

  it('matches secret field names case-insensitively', () => {
    const cases = [
      { API_KEY: 'secret' },
      { ApiKey: 'secret' },
      { 'my-Token': 'secret' },
      { AUTHORIZATION: 'Bearer x' },
      { PasSwOrD: 'hunter2' },
    ];
    for (const obj of cases) {
      const result = safeSerialize(obj);
      expect(result).toContain('***');
      expect(result).not.toContain('secret');
      expect(result).not.toContain('hunter2');
      expect(result).not.toContain('Bearer x');
    }
  });

  it('redacts nested objects recursively', () => {
    const input = { user: { apiKey: 'x', name: 'lorra' } };
    const result = safeSerialize(input);
    expect(result).toContain('"apiKey":"***"');
    expect(result).toContain('"name":"lorra"');
  });

  it('redacts secrets inside arrays of objects', () => {
    const input = [{ password: 'p' }, { token: 't' }];
    const result = safeSerialize(input);
    expect(result).toContain('"password":"***"');
    expect(result).toContain('"token":"***"');
  });

  it('preserves non-matching keys unchanged', () => {
    const input = { name: 'lorra', count: 42 };
    const result = safeSerialize(input);
    expect(result).toContain('"name":"lorra"');
    expect(result).toContain('"count":42');
  });

  it('preserves non-string values unchanged', () => {
    const input = { count: 42, active: true, nothing: null };
    const result = safeSerialize(input);
    expect(result).toContain('"count":42');
    expect(result).toContain('"active":true');
    expect(result).toContain('"nothing":null');
  });

  it('does not throw on circular references', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => safeSerialize(a)).not.toThrow();
    const result = safeSerialize(a);
    expect(result).toBeDefined();
    expect(result).not.toContain('***'); // self-reference is not a secret field
  });

  it('handles undefined and null without throwing', () => {
    expect(() => safeSerialize(undefined)).not.toThrow();
    expect(() => safeSerialize(null)).not.toThrow();
  });

  it('fast-check: any object with secret keys gets redacted', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...secretFields, 'name', 'count', 'active'),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        ),
        (obj) => {
          const result = safeSerialize(obj);
          const parsed = JSON.parse(result);
          for (const [key, value] of Object.entries(obj)) {
            if (secretFields.some((f) => f.toLowerCase() === key.toLowerCase())) {
              expect(parsed[key]).toBe('***');
            } else {
              expect(parsed[key]).toBe(value);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
