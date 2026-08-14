import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CustomProviderInput,
  ModelConfigAdapter,
} from '../../src/main/pi-sdk-driver/model-config';

// --- Credential-field anchored detector (mirrors the unit-test helper) ---
// Anchored whole-key: matches credential-semantic names (apiKey, accessToken,
// clientSecret, token, …) but NOT model-parameter keys that merely contain
// the substring "token" (maxTokens / contextWindow).
const CREDENTIAL_KEY =
  /^(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|bearer[_-]?token|api[_-]?token|token|secret|password|authorization)$/i;

function collectKeys(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.flatMap((v) => collectKeys(v));
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => [k, ...collectKeys(v)]);
}

function hasCredentialKey(obj: unknown): boolean {
  return collectKeys(obj).some((k) => CREDENTIAL_KEY.test(k));
}

// Unique, scannable fake credential. The `sk-int-` prefix is recognisable in
// any raw-file scan; the UUID makes it unique across runs.
const FAKE = `sk-int-${randomUUID()}`;

// Standard custom-provider input (no credential field by contract —
// credentials flow through connect -> login -> SDK-managed auth.json).
function customInput(): CustomProviderInput {
  return {
    id: 'acme-int',
    name: 'Acme',
    baseUrl: 'https://api.acme.test',
    api: 'openai-completions',
    models: [{ id: 'm1', name: 'M1', contextWindow: 8192, maxTokens: 1024, reasoning: false }],
  };
}

function toText(x: unknown): string {
  return typeof x === 'string' ? x : JSON.stringify(x);
}

describe('凭证零穿越（集成：真适配器 + 临时 home + 真 SDK）', () => {
  let tmpHome = '';
  let tmpUserData = '';
  let tmpE2eUserData = '';
  let sentinelPath = '';
  let adapter: ModelConfigAdapter;
  // SDK's ModelRuntime reads `process.env.PI_OFFLINE` at construction to gate
  // network model-catalog refresh. In vitest's jsdom the fetch path hangs
  // (pure-node fails fast on DNS), and login/customAdd both call refresh
  // after their write. PI_OFFLINE is the SDK's public offline switch — setting
  // it isolates the credential-transit path under test from network jitter.
  // It does NOT change where credentials land (auth.json is a local write,
  // proven by smoke / OQ-2). Restore is per-test to avoid cross-test bleed.
  let prevOffline: string | undefined;

  beforeEach(async () => {
    prevOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfg-int-home-'));
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfg-int-ud-'));
    tmpE2eUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfg-int-e2e-'));
    // Sentinel settings.json in a separate dir that stands in for Electron's
    // userData dir. The adapter must never touch it.
    sentinelPath = path.join(tmpUserData, 'settings.json');
    fs.writeFileSync(sentinelPath, JSON.stringify({ recentWorkspaces: [] }));

    adapter = await ModelConfigAdapter.create({
      workspaceCwd: path.join(tmpHome, 'ws'),
      homeDir: tmpHome,
    });
  });

  afterEach(() => {
    if (prevOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = prevOffline;

    for (const dir of [tmpHome, tmpUserData, tmpE2eUserData]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a. 配置目录 ~/.lorra 被创建（mkdir -p 生效）', () => {
    expect(fs.existsSync(path.join(tmpHome, '.lorra'))).toBe(true);
  });

  it('默认目录使用 e2e userData 下的 .lorra', async () => {
    const prior = process.env.LORRA_E2E_USERDATA;
    process.env.LORRA_E2E_USERDATA = tmpE2eUserData;

    try {
      const e2eAdapter = await ModelConfigAdapter.create({
        workspaceCwd: path.join(tmpHome, 'ws'),
      });
      expect(fs.existsSync(path.join(tmpE2eUserData, '.lorra'))).toBe(true);
      expect(e2eAdapter.getDefault()).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.LORRA_E2E_USERDATA;
      else process.env.LORRA_E2E_USERDATA = prior;
    }
  });

  it('b. connect 后凭证只落 SDK auth.json，且供应商出现在 listConnected', async () => {
    const res = await adapter.connect('anthropic', FAKE);
    expect(res.isOk()).toBe(true);

    const authPath = path.join(tmpHome, '.lorra', 'auth.json');
    expect(fs.existsSync(authPath)).toBe(true);
    const authRaw = fs.readFileSync(authPath, 'utf8');
    // SDK stored the fake key — positive control proving the credential
    // actually transited the SDK entry (otherwise the no-leak assertions
    // below would be vacuous).
    expect(authRaw).toContain(FAKE);

    expect(adapter.listConnected().map((c) => c.id)).toContain('anthropic');
  });

  it('c. customAdd 后 models.json 无凭证字段名、无 FAKE、无 api[_-]?key 字面', async () => {
    const res = await adapter.customAdd(customInput());
    expect(res.isOk()).toBe(true);

    const modelsPath = path.join(tmpHome, '.lorra', 'models.json');
    expect(fs.existsSync(modelsPath)).toBe(true);
    const raw = fs.readFileSync(modelsPath, 'utf8');
    const parsed = JSON.parse(raw);

    // No credential-semantic key name anywhere in the structure.
    expect(hasCredentialKey(parsed)).toBe(false);
    // Positive control — detector still has teeth.
    expect(hasCredentialKey({ apiKey: 'sk-x' })).toBe(true);
    expect(hasCredentialKey({ maxTokens: 4096 })).toBe(false);

    // Raw text carries neither the fake value nor the canonical key pattern.
    expect(raw).not.toContain(FAKE);
    expect(raw).not.toMatch(/api[_-]?key/i);
  });

  it('d. 与 userData settings.json 分离：哨兵不变且不含凭证', async () => {
    await adapter.connect('anthropic', FAKE);
    await adapter.customAdd(customInput());

    const sentinelAfter = fs.readFileSync(sentinelPath, 'utf8');
    // Content unchanged — adapter only ever writes under tmpHome/.lorra.
    expect(sentinelAfter).toBe(JSON.stringify({ recentWorkspaces: [] }));
    expect(sentinelAfter).not.toContain(FAKE);
  });

  it('e. 日志不泄露凭证：connect + customAdd 期间 console.* 输出无 FAKE', async () => {
    const spies = (['log', 'error', 'warn'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      await adapter.connect('anthropic', FAKE);
      await adapter.customAdd(customInput());

      const allOutput = spies.flatMap((s) => s.mock.calls.flat());
      expect(allOutput.some((x) => toText(x).includes(FAKE))).toBe(false);
    } finally {
      for (const s of spies) {
        s.mockRestore();
      }
    }
  });

  it('f. 返回载荷不含凭证：connect/customAdd 的 Result 无 FAKE', async () => {
    const connectRes = await adapter.connect('anthropic', FAKE);
    const customRes = await adapter.customAdd(customInput());

    expect(JSON.stringify(connectRes)).not.toContain(FAKE);
    expect(JSON.stringify(customRes)).not.toContain(FAKE);
  });
});
