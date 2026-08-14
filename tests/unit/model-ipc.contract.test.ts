/**
 * IPC contract — credential zero-transit (static / compile-time assertion).
 *
 * Spec: 
 * → Requirement "凭证零穿越" → Scenario "IPC 签名中无凭证字段名"
 * ADR: adr/.md D2/D3
 *
 * Mechanism: a recursive type-level walker (`Walk<T>`) descends into any
 * type T — Promise (unwrap), function (decompose args tuple + return),
 * array (recurse into element), object (walk every key). Whenever a key
 * name matches the forbidden credential pattern, it yields the marker
 * type `ForbiddenFieldMarker`. `CheckNamespace<T>` applies the walker to
 * every method's Parameters and ReturnType, then `expectTypeOf<…>.to
 * EqualTypeOf<true>` enforces equality at compile time. If a forbidden
 * field slips into any channel's signature, `npm run typecheck` fails.
 *
 * TDD state (red): src/preload.ts does not yet expose the `providers` or
 * `models` namespaces. The expected compile error is
 * "Property 'providers' does not exist on type 'LorraApi'"
 * pointing at the `LorraApi['providers']` access below. Once 
 * adds the namespaces correctly, the contract assertions below become
 * the live guard.
 *
 * Whole-key match (case- and separator-insensitive): `maxTokens`,
 * `contextWindow`, `material`, `providerId`, `connectionMethod`, etc.
 * must NOT be flagged. The anchored match mirrors the runtime
 * CREDENTIAL_KEY regex in tests/unit/model-config.test.ts so the static
 * and runtime detectors agree.
 *
 * Strict-boolean exemption (ambiguity 6): when a forbidden key carries
 * a value whose type is strictly `boolean` (bidirectional
 * `V extends boolean ? boolean extends V ? true : …`), it is exempt.
 * Rationale (intent): credential material is physically
 * always a string, so a pure-boolean field cannot be a credential —
 * it is a capability flag (e.g. `ProviderDto.auth.apiKey: boolean`
 * means "this provider supports apiKey auth"). Anything that could
 * carry a string — `string`, `unknown`, unions including `string`,
 * object/array — is still conservatively flagged. Teeth preserved:
 * `apiKey: string` remains a violation.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { LorraApi } from '../../src/preload';
import type { Result, SerializedResult } from '../../src/shared/result';

// ---------------------------------------------------------------------------
// Forbidden-key catalogue (whole-key, case-insensitive, separator-insensitive)
// ---------------------------------------------------------------------------

type ForbiddenFieldMarker = '🚫 credential field name forbidden in IPC type';

type ForbiddenKey =
  // api + key (with hyphen / underscore / none)
  | 'apikey'
  | 'api_key'
  | 'api-key'
  // access + token
  | 'accesstoken'
  | 'access_token'
  | 'access-token'
  // refresh + token
  | 'refreshtoken'
  | 'refresh_token'
  | 'refresh-token'
  // client + secret
  | 'clientsecret'
  | 'client_secret'
  | 'client-secret'
  // auth + token
  | 'authtoken'
  | 'auth_token'
  | 'auth-token'
  // bearer + token
  | 'bearertoken'
  | 'bearer_token'
  | 'bearer-token'
  // api + token
  | 'apitoken'
  | 'api_token'
  | 'api-token'
  // base forms
  | 'token'
  | 'secret'
  | 'password'
  | 'authorization';

type IsForbiddenKey<K extends string> = Lowercase<K> extends ForbiddenKey ? true : false;

// ---------------------------------------------------------------------------
// Type walker — descends into Promise, function, array, object keys.
// Returns `true` if no forbidden key exists anywhere in T; else the
// marker (possibly unioned with `true` from clean sub-trees).
// ---------------------------------------------------------------------------

type WalkTuple<T extends readonly unknown[]> = T extends readonly [infer Head, ...infer Tail]
  ? Walk<Head> | WalkTuple<Tail>
  : true;

type Walk<T> =
  // 1) Promise — unwrap to inner type
  T extends Promise<infer P>
    ? Walk<P>
    : // 2) Function — decompose args tuple + return
      T extends (...args: infer A) => infer R
      ? WalkTuple<A> | Walk<R>
      : // 3) ReadonlyArray — recurse into element type
        T extends readonly (infer U)[]
        ? Walk<U>
        : // 4) Built-in object — bypass (its keys are not user IPC surface)
          T extends Date | RegExp | Error
          ? true
          : // 5) better-result Result — inspect its serialized wire shape, not
            // its class methods (isOk/map/andThen are recursive generics
            // that blow up Walk's mapped-type instantiation).
            T extends Result<infer V>
            ? Walk<SerializedResult<V>>
            : // 6) Plain object — walk every key, flag matches
              T extends object
              ? {
                  // Exemption (ambiguity 6, ): 凭据材料物理必为字符串,
                  // 严格 boolean 不承载密钥 → 是能力标志非凭据,精确实现 D3 意图、
                  // 不降牙齿(apiKey: string 仍红)。联合含 string / unknown / 对象
                  // 一律保守命中。
                  [K in keyof T]: IsForbiddenKey<K & string> extends true
                    ? T[K] extends boolean
                      ? boolean extends T[K]
                        ? true
                        : ForbiddenFieldMarker
                      : ForbiddenFieldMarker
                    : Walk<T[K]>;
                }[keyof T]
              : // 7) Primitive — clean
                true;

type HasForbidden<T> = ForbiddenFieldMarker extends T ? true : false;

// ---------------------------------------------------------------------------
// Contract check on a method namespace (object whose values are methods).
// Returns `true` if every method's Parameters + ReturnType (deeply) is
// free of forbidden keys; else the marker.
// ---------------------------------------------------------------------------

type CheckMethod<T> = T extends (...args: infer A) => infer R
  ? HasForbidden<WalkTuple<A> | Walk<R>> extends true
    ? ForbiddenFieldMarker
    : true
  : // Non-method values (shouldn't appear in our namespaces, but be safe):
    HasForbidden<Walk<T>> extends true
    ? ForbiddenFieldMarker
    : true;

type CheckNamespace<T> =
  Exclude<{ [K in keyof T]: CheckMethod<T[K]> }[keyof T], true> extends never
    ? true
    : ForbiddenFieldMarker;

// ---------------------------------------------------------------------------
// Vitest harness — actual enforcement is compile-time (expectTypeOf's
// toEqualTypeOf requires a Mismatch arg when types differ, so tsc fails).
// The runtime checks below are just organizational placeholders.
// ---------------------------------------------------------------------------

describe('IPC contract — credential zero-transit (/D3, spec 凭证零穿越)', () => {
  // -----------------------------------------------------------------
  // Positive controls — the detector has teeth. Each `expectTypeOf`
  // calls Walk<…> on a synthetic shape and asserts the walker
  // correctly identifies the marker (or absence thereof). These are
  // independent of LorraApi so they prove the walker's logic
  // regardless of whether providers/models are implemented yet.
  // -----------------------------------------------------------------
  it('detector flags apiKey / token / secret / password / authorization (and variants + nested)', () => {
    // Base forms — case- and separator-insensitive.
    expectTypeOf<HasForbidden<Walk<{ apiKey: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ API_KEY: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ 'api-key': string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ token: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ secret: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ password: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ authorization: string }>>>().toEqualTypeOf<true>();
    // Compounds — the "及其复合" required by the spec.
    expectTypeOf<HasForbidden<Walk<{ accessToken: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ refreshToken: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ clientSecret: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ bearerToken: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ authToken: string }>>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbidden<Walk<{ apiToken: string }>>>().toEqualTypeOf<true>();
    // Nested inside an envelope data shape.
    expectTypeOf<
      HasForbidden<Walk<{ ok: true; data: { apiKey: string } }>>
    >().toEqualTypeOf<true>();
    // Inside array elements.
    expectTypeOf<HasForbidden<Walk<Array<{ password: string }>>>>().toEqualTypeOf<true>();
    // Inside Promise-wrapped shapes.
    expectTypeOf<HasForbidden<Walk<Promise<{ token: string }>>>>().toEqualTypeOf<true>();
    // Nested deep — function returning envelope-of-array-of-DTO-with-bad-key.
    expectTypeOf<
      HasForbidden<Walk<() => Promise<{ ok: true; data: Array<{ secret: string }> }>>>
    >().toEqualTypeOf<true>();
  });

  // -----------------------------------------------------------------
  // Negative controls — legitimate fields must NOT be flagged.
  // Proves the anchored match is precise: substrings containing
  // 'token' but not equal to 'token' (e.g. maxTokens) are NOT
  // false-positives; the connect-payload's neutral `material` field
  // is clean; the canonical ModelDto shape is clean.
  // -----------------------------------------------------------------
  it('detector ignores legitimate field names (providerId, material, maxTokens, …)', () => {
    expectTypeOf<HasForbidden<Walk<{ providerId: string }>>>().toEqualTypeOf<false>();
    // The exact `lorra.providers.connect` payload (/ spec).
    expectTypeOf<
      HasForbidden<Walk<{ providerId: string; material?: string }>>
    >().toEqualTypeOf<false>();
    // Substring "token" but NOT equal to "token" — must not false-positive.
    expectTypeOf<HasForbidden<Walk<{ maxTokens: number }>>>().toEqualTypeOf<false>();
    expectTypeOf<HasForbidden<Walk<{ contextWindow: number }>>>().toEqualTypeOf<false>();
    // Canonical DTO shape — every field is a legitimate non-credential
    // name. Note: 'apiKey' appears as a *string-literal value* in the
    // connectionMethod union, but the walker inspects KEY names only.
    expectTypeOf<
      HasForbidden<
        Walk<{
          id: string;
          name: string;
          modelCount: number;
          connectionMethod: 'apiKey' | 'environment' | 'custom';
        }>
      >
    >().toEqualTypeOf<false>();
    // Whole ModelDto shape (mirrors src/main/pi-sdk-driver/model-config.ts).
    expectTypeOf<
      HasForbidden<
        Walk<{
          id: string;
          name: string;
          provider: string;
          contextWindow: number;
          maxTokens: number;
          reasoning: boolean;
          enabled: boolean;
          default: boolean;
          available: boolean;
        }>
      >
    >().toEqualTypeOf<false>();
    // Function returning a clean Promise — must not false-positive.
    expectTypeOf<
      HasForbidden<Walk<() => Promise<{ providerId: string; material?: string }>>>
    >().toEqualTypeOf<false>();
  });

  // -----------------------------------------------------------------
  // Ambiguity 6 — strict-boolean exemption on forbidden-named keys.
  // Rationale : 凭据材料物理必为字符串,严格 boolean
  // 是能力标志非凭据材料 → 豁免。联合含 string / unknown / 对象
  // 一律保守命中,牙齿不降。
  // -----------------------------------------------------------------
  it('detector exempts strict-boolean forbidden-named fields (capability flags, not credentials)', () => {
    // Top level: pure boolean under a forbidden key — exempt.
    expectTypeOf<HasForbidden<Walk<{ apiKey: boolean }>>>().toEqualTypeOf<false>();

    // ProviderDto.auth shape: 'auth' key recurses (not forbidden),
    // then 'apiKey'/'oauth' under it are forbidden-named but pure boolean → exempt.
    expectTypeOf<
      HasForbidden<Walk<{ auth: { apiKey: boolean; oauth: boolean } }>>
    >().toEqualTypeOf<false>();

    // Real credential material is still flagged — teeth preserved.
    expectTypeOf<HasForbidden<Walk<{ apiKey: string }>>>().toEqualTypeOf<true>();

    // 'unknown' cannot be statically proven to be a non-string → conservative hit.
    expectTypeOf<HasForbidden<Walk<{ apiKey: unknown }>>>().toEqualTypeOf<true>();

    // Union with string: bidirectional check fails → not exempt.
    expectTypeOf<HasForbidden<Walk<{ apiKey: boolean | string }>>>().toEqualTypeOf<true>();

    // Deep: forbidden-named key inside a clean envelope, value boolean — exempt.
    expectTypeOf<HasForbidden<Walk<{ data: { token: boolean } }>>>().toEqualTypeOf<false>();

    // Deep: forbidden-named key inside a clean envelope, value string — still flagged.
    expectTypeOf<HasForbidden<Walk<{ data: { token: string } }>>>().toEqualTypeOf<true>();
  });

  // -----------------------------------------------------------------
  // The actual contract: LorraApi['providers'] and LorraApi['models'].
  // Every method's Parameters AND ReturnType (through Promise →
  // RpcEnvelope → data → DTOs, recursively) must be free of
  // credential-named fields. Violations surface as a typecheck
  // failure.
  //
  // TDD state: src/preload.ts has not yet added `providers` /
  // `models`. The expected compile error is
  // "Property 'providers' does not exist on type 'LorraApi'"
  // pointing at the `LorraApi['providers']` access below. Once
  // adds the namespaces correctly, these assertions
  // become the live guard.
  // -----------------------------------------------------------------
  it('LorraApi[providers] declares no credential-named fields (Parameters + ReturnType, deeply)', () => {
    type Providers = LorraApi['providers'];
    expectTypeOf<CheckNamespace<Providers>>().toEqualTypeOf<true>();
  });

  it('LorraApi[models] declares no credential-named fields (Parameters + ReturnType, deeply)', () => {
    type Models = LorraApi['models'];
    expectTypeOf<CheckNamespace<Models>>().toEqualTypeOf<true>();
  });
});
