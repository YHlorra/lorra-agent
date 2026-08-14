import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Implementation module does not exist yet (TDD red). Import failing here is
// the expected current state; a correct implementation will make it pass.
import { ModelConfigAdapter } from '../../src/main/pi-sdk-driver/model-config';

// ---------------------------------------------------------------------------
// Local port shapes (mirror the authoritative contract). The adapter is
// constructed with injected fakes satisfying these shapes — NOT the concrete
// SDK classes (design D6 / task 2.1 test seam).
// ---------------------------------------------------------------------------

type Provider = {
  id: string;
  name: string;
  auth?: { apiKey?: unknown; oauth?: unknown };
};

type Model = {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  api?: string;
  baseUrl?: string;
};

type AuthStatus = {
  configured: boolean;
  source?:
    | 'stored'
    | 'runtime'
    | 'environment'
    | 'fallback'
    | 'models_json_key'
    | 'models_json_command';
  label?: string;
};

// Popular prefix — exact order pinned by spec scenario "Popular group ordering".
const POPULAR = ['anthropic', 'openai', 'deepseek', 'zai', 'minimax-cn'] as const;

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

interface FakeRuntime {
  calls: {
    login: Array<{ providerId: string; type: string; promptResult: unknown }>;
    logout: string[];
    complete: Array<{ model: Model; context: unknown; options: unknown }>;
    refresh: number;
  };
  state: {
    providers: Provider[];
    models: Model[];
    authStatus: Record<string, AuthStatus>;
    available: Record<string, Model[]>;
  };
  getProviders: ReturnType<typeof vi.fn>;
  getProvider: ReturnType<typeof vi.fn>;
  getModels: ReturnType<typeof vi.fn>;
  checkAuth: ReturnType<typeof vi.fn>;
  getAvailable: ReturnType<typeof vi.fn>;
  getAvailableSnapshot: ReturnType<typeof vi.fn>;
  getProviderAuthStatus: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}

function makeFakeRuntime(
  opts: {
    providers?: Provider[];
    models?: Model[];
    authStatus?: Record<string, AuthStatus>;
    available?: Record<string, Model[]>;
    // What source login confers on the provider (models SDK behaviour: 'stored'
    // for pasted key, 'environment' when SDK detects env creds despite no paste).
    loginSource?: AuthStatus['source'];
    completeImpl?: (model: Model) => Promise<unknown>;
    // Override login to simulate slow/hanging network calls (regression test
    // for connect lacking a client-side timeout).
    loginImpl?: (
      providerId: string,
      type: string,
      interaction: {
        prompt: (req: { type: string; message?: string }) => Promise<string>;
      },
    ) => Promise<unknown>;
  } = {},
): FakeRuntime {
  const providers = opts.providers ?? [];
  const models = opts.models ?? [];
  const authStatus: Record<string, AuthStatus> = { ...opts.authStatus };
  const available: Record<string, Model[]> = { ...opts.available };
  const loginSource = opts.loginSource ?? 'stored';
  const completeImpl = opts.completeImpl ?? (() => Promise.resolve('ok'));
  const loginImpl = opts.loginImpl;

  const calls = {
    login: [] as FakeRuntime['calls']['login'],
    logout: [] as string[],
    complete: [] as FakeRuntime['calls']['complete'],
    refresh: 0,
  };

  return {
    calls,
    state: { providers, models, authStatus, available },
    getProviders: vi.fn(() => providers as readonly Provider[]),
    getProvider: vi.fn((id: string) => providers.find((p) => p.id === id)),
    getModels: vi.fn(
      (providerId?: string) =>
        (providerId ? models.filter((m) => m.provider === providerId) : models) as readonly Model[],
    ),
    checkAuth: vi.fn((providerId: string) => {
      const s = authStatus[providerId];
      if (!s?.configured) return Promise.resolve(undefined);
      return Promise.resolve({ source: s.source, type: 'api_key' as const });
    }),
    getAvailable: vi.fn((providerId?: string) => {
      if (providerId) return (available[providerId] ?? []) as readonly Model[];
      return Object.values(available).flat() as readonly Model[];
    }),
    getAvailableSnapshot: vi.fn((providerId?: string) => {
      if (providerId) return (available[providerId] ?? []) as readonly Model[];
      return Object.values(available).flat() as readonly Model[];
    }),
    getProviderAuthStatus: vi.fn(
      (providerId: string) => (authStatus[providerId] ?? { configured: false }) as AuthStatus,
    ),
    login: vi.fn(
      (
        providerId: string,
        type: string,
        interaction: {
          prompt: (req: { type: string; message?: string }) => Promise<string>;
        },
      ) => {
        if (loginImpl) return loginImpl(providerId, type, interaction);
        return interaction
          .prompt({ type: 'api_key', message: 'Enter API key' })
          .then((result: string) => {
            calls.login.push({ providerId, type, promptResult: result });
            authStatus[providerId] = { configured: true, source: loginSource };
            return { ok: true };
          });
      },
    ),
    logout: vi.fn((providerId: string) => {
      calls.logout.push(providerId);
      delete authStatus[providerId];
      return Promise.resolve();
    }),
    complete: vi.fn((model: Model, context: unknown, options: unknown) => {
      calls.complete.push({ model, context, options });
      return completeImpl(model);
    }),
    refresh: vi.fn(() => {
      calls.refresh++;
      return Promise.resolve();
    }),
  };
}

interface FakeSettings {
  calls: {
    setDefaultModelAndProvider: Array<{ provider: string; modelId: string }>;
    setEnabledModels: Array<string[] | undefined>;
  };
  state: {
    defaultProvider: string | undefined;
    defaultModel: string | undefined;
    enabledModels: string[] | undefined;
  };
  getDefaultProvider: ReturnType<typeof vi.fn>;
  getDefaultModel: ReturnType<typeof vi.fn>;
  setDefaultModelAndProvider: ReturnType<typeof vi.fn>;
  getEnabledModels: ReturnType<typeof vi.fn>;
  setEnabledModels: ReturnType<typeof vi.fn>;
}

function makeFakeSettings(
  initial: { defaultProvider?: string; defaultModel?: string; enabledModels?: string[] } = {},
): FakeSettings {
  const state = {
    defaultProvider: initial.defaultProvider,
    defaultModel: initial.defaultModel,
    // undefined = "all enabled" per OQ-3
    enabledModels: initial.enabledModels as string[] | undefined,
  };
  const calls = {
    setDefaultModelAndProvider: [] as Array<{
      provider: string;
      modelId: string;
    }>,
    setEnabledModels: [] as Array<string[] | undefined>,
  };
  return {
    calls,
    state,
    getDefaultProvider: vi.fn(() => state.defaultProvider),
    getDefaultModel: vi.fn(() => state.defaultModel),
    setDefaultModelAndProvider: vi.fn((provider: string, modelId: string) => {
      calls.setDefaultModelAndProvider.push({ provider, modelId });
      state.defaultProvider = provider;
      state.defaultModel = modelId;
    }),
    getEnabledModels: vi.fn(() => state.enabledModels),
    setEnabledModels: vi.fn((patterns: string[] | undefined) => {
      calls.setEnabledModels.push(patterns);
      state.enabledModels = patterns;
    }),
  };
}

// Real temp configDir per test; cleaned up in afterEach.
let tmpDir = '';

function makeAdapter(
  runtime: FakeRuntime,
  settings: FakeSettings,
  configDir: string = tmpDir,
  testTimeoutMs?: number,
): ModelConfigAdapter {
  // Cast fakes to the adapter's port types (structural compatibility).
  return new ModelConfigAdapter({
    runtime: runtime as unknown as ConstructorParameters<typeof ModelConfigAdapter>[0]['runtime'],
    settings: settings as unknown as ConstructorParameters<
      typeof ModelConfigAdapter
    >[0]['settings'],
    configDir,
    ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
  });
}

// Recursively collect all object keys to assert credential-zero-transit.
function collectKeys(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.flatMap((v) => collectKeys(v));
  const entries = Object.entries(obj as Record<string, unknown>);
  return entries.flatMap(([k, v]) => [k, ...collectKeys(v)]);
}

// Credential field names forbidden in models.json (/D3). Anchored
// whole-key so it matches credential-semantic names (apiKey, accessToken,
// clientSecret, token, …) but NOT model-parameter keys that merely contain the
// substring "token" (maxTokens) — the spec intent is credential semantics, and
// dynamic provider-id keys like "acme" are also not matched. The earlier
// unanchored /token/i false-positived on maxTokens; anchoring fixes that.
const CREDENTIAL_KEY =
  /^(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|bearer[_-]?token|api[_-]?token|token|secret|password|authorization)$/i;

// True iff any key in the object is a credential field name.
function hasCredentialKey(obj: unknown): boolean {
  return collectKeys(obj).some((k) => CREDENTIAL_KEY.test(k));
}

function readModelsJson(dir: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(dir, 'models.json'), 'utf8');
  return JSON.parse(raw);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfg-test-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

describe('catalog', () => {
  it('popular group ordered first as anthropic,openai,deepseek,zai,minimax-cn, rest alphabetical', () => {
    const providers: Provider[] = [
      { id: 'zai', name: 'Z.ai', auth: { apiKey: {} } },
      { id: 'openai', name: 'OpenAI', auth: { apiKey: {} } },
      { id: 'mistral', name: 'Mistral', auth: { apiKey: {} } },
      { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } },
      { id: 'deepseek', name: 'DeepSeek', auth: { apiKey: {} } },
      { id: 'minimax-cn', name: 'MiniMax CN', auth: { apiKey: {} } },
      { id: 'bedrock', name: 'Bedrock', auth: { apiKey: {} } },
    ];
    const runtime = makeFakeRuntime({
      providers,
      models: providers.flatMap((p) => [
        {
          id: `${p.id}-m1`,
          name: 'M1',
          provider: p.id,
          contextWindow: 8192,
          maxTokens: 1024,
          reasoning: false,
        },
      ]),
    });
    const settings = makeFakeSettings();
    const adapter = makeAdapter(runtime, settings);

    const cat = adapter.catalog();

    expect(cat.map((c) => c.id)).toEqual([
      'anthropic',
      'openai',
      'deepseek',
      'zai',
      'minimax-cn',
      'bedrock',
      'mistral',
    ]);
    cat.forEach((c) => {
      expect(c.group).toBe((POPULAR as readonly string[]).includes(c.id) ? 'popular' : 'all');
    });
  });

  it('oauth-only provider marked available:false with reason oauth-only', () => {
    const providers: Provider[] = [
      { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } },
      { id: 'google', name: 'Google', auth: { oauth: {} } }, // oauth only, no apiKey
    ];
    const runtime = makeFakeRuntime({
      providers,
      models: [
        {
          id: 'claude',
          name: 'Claude',
          provider: 'anthropic',
          contextWindow: 8192,
          maxTokens: 1024,
          reasoning: false,
        },
      ],
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const cat = adapter.catalog();
    const google = cat.find((c) => c.id === 'google');
    expect(google).toBeDefined();
    expect(google?.available).toBe(false);
    expect(google?.reason).toBe('oauth-only');
    expect(google?.auth.oauth).toBe(true);
    expect(google?.auth.apiKey).toBe(false);

    const anthropic = cat.find((c) => c.id === 'anthropic');
    expect(anthropic?.available).toBe(true);
    expect(anthropic?.auth.apiKey).toBe(true);
    expect(anthropic?.reason).toBeUndefined();
  });

  it('new provider after SDK upgrade appears without code change (non-popular in tail)', () => {
    const providers: Provider[] = [
      { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } },
      { id: 'newco', name: 'NewCo', auth: { apiKey: {} } }, // unknown before upgrade
    ];
    const runtime = makeFakeRuntime({
      providers,
      models: [],
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const cat = adapter.catalog();
    const newco = cat.find((c) => c.id === 'newco');
    expect(newco).toBeDefined();
    expect(newco?.group).toBe('all');
  });

  it('modelCount reflects getModels(id).length; auth booleans reflect Provider.auth', () => {
    const providers: Provider[] = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        auth: { apiKey: {}, oauth: {} },
      },
    ];
    const runtime = makeFakeRuntime({
      providers,
      models: [
        {
          id: 'm1',
          name: 'M1',
          provider: 'anthropic',
          contextWindow: 1,
          maxTokens: 1,
          reasoning: false,
        },
        {
          id: 'm2',
          name: 'M2',
          provider: 'anthropic',
          contextWindow: 1,
          maxTokens: 1,
          reasoning: false,
        },
      ],
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const cat = adapter.catalog();
    expect(cat[0].modelCount).toBe(2);
    expect(cat[0].auth.apiKey).toBe(true);
    expect(cat[0].auth.oauth).toBe(true);
  });

  it('fast-check: popular prefix always precedes alphabetical tail for arbitrary id sets', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 12 })
            .map((s) => s.toLowerCase().replace(/[^a-z0-9-]/g, 'x')),
          { minLength: 1, maxLength: 25 },
        ),
        (rawIds) => {
          const uniqueIds = [...new Set(rawIds)];
          const providers: Provider[] = uniqueIds.map((id) => ({
            id,
            name: id,
            auth: { apiKey: {} },
          }));
          const runtime = makeFakeRuntime({ providers, models: [] });
          const adapter = makeAdapter(runtime, makeFakeSettings());
          const cat = adapter.catalog();

          const popularPresent = POPULAR.filter((p) => uniqueIds.includes(p));
          const rest = uniqueIds
            .filter((id) => !(POPULAR as readonly string[]).includes(id))
            .sort();
          const expectedOrder = [...popularPresent, ...rest];

          expect(cat.map((c) => c.id)).toEqual(expectedOrder);
          for (const c of cat) {
            expect(c.group).toBe((POPULAR as readonly string[]).includes(c.id) ? 'popular' : 'all');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('connect', () => {
  it('connect with pasted key calls login(providerId,"api_key",interaction) whose prompt yields the material; listConnected includes it', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
    });
    const settings = makeFakeSettings();
    const adapter = makeAdapter(runtime, settings);

    const result = await adapter.connect('anthropic', 'sk-test-12345');

    expect(result.isOk()).toBe(true);
    expect(runtime.calls.login).toHaveLength(1);
    expect(runtime.calls.login[0].providerId).toBe('anthropic');
    expect(runtime.calls.login[0].type).toBe('api_key');
    // The adapter's interaction.prompt resolved to the pasted material.
    expect(runtime.calls.login[0].promptResult).toBe('sk-test-12345');

    const connected = adapter.listConnected();
    expect(connected.map((c) => c.id)).toContain('anthropic');
  });

  it('connect with no material still calls login; no pasted secret (prompt resolves empty)', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
      // SDK detects env creds despite empty prompt → source 'environment'.
      loginSource: 'environment',
    });
    const settings = makeFakeSettings();
    const adapter = makeAdapter(runtime, settings);

    const result = await adapter.connect('anthropic');

    expect(result.isOk()).toBe(true);
    expect(runtime.calls.login).toHaveLength(1);
    expect(runtime.calls.login[0].type).toBe('api_key');
    // No secret was pasted.
    expect(
      runtime.calls.login[0].promptResult === undefined ||
        runtime.calls.login[0].promptResult === '',
    ).toBe(true);

    // : env-detected providers are NOT in listConnected until the user
    // explicitly calls connect (which writes auth.json → source becomes
    // 'stored'). The env-var-paste hint is rendered from getAuthStatus, not
    // from listConnected.
    const connected = adapter.listConnected();
    const entry = connected.find((c) => c.id === 'anthropic');
    expect(entry).toBeUndefined();
    const status = adapter.getAuthStatus('anthropic');
    expect(status.source).toBe('environment');
  });

  // Regression guard: connect must bound the SDK login wait with a client
  // timeout. Otherwise a slow/unreachable provider base URL (e.g. dev-time
  // ANTHROPIC_BASE_URL pointing at a flaky proxy) makes the UI "连接中…"
  // button hang until TCP timeout. Pair of (a) proves the timeout fires, and
  // (b) proves a successful connect still resolves.
  it('regression: SDK login hangs → connect() returns timeout error within bound', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
      loginImpl: () => new Promise(() => {}), // never resolves
    });
    const settings = makeFakeSettings();
    const adapter = makeAdapter(runtime, settings, tmpDir, 50);

    const start = Date.now();
    const result = await adapter.connect('anthropic', 'sk-test');
    const elapsed = Date.now() - start;

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error('unreachable');
    expect(result.error.code).toBe('connect-failed');
    expect(result.error.message).toContain('timeout');
    // Sanity bound: timed out within ~50ms (plus event-loop slack) — NOT the
    // full TCP default of ~75s.
    expect(elapsed).toBeLessThan(2000);
  });

  it('regression: successful connect within the timeout bound still returns ok', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
    });
    const settings = makeFakeSettings();
    const adapter = makeAdapter(runtime, settings, tmpDir, 1000);

    const result = await adapter.connect('anthropic', 'sk-test');

    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listConnected
// ---------------------------------------------------------------------------

describe('listConnected', () => {
  it('maps source "stored" → connectionMethod "apiKey"; excludes unconfigured providers', () => {
    const runtime = makeFakeRuntime({
      providers: [
        { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } },
        { id: 'openai', name: 'OpenAI', auth: { apiKey: {} } },
      ],
      models: [],
      authStatus: {
        anthropic: { configured: true, source: 'stored' },
        // openai NOT configured
      },
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const connected = adapter.listConnected();
    expect(connected.map((c) => c.id)).toEqual(['anthropic']);
    expect(connected[0].connectionMethod).toBe('apiKey');
  });

  it(': env-var-detected providers are NOT in listConnected; getAuthStatus still reports source=environment', () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'openai', name: 'OpenAI', auth: { apiKey: {} } }],
      models: [],
      authStatus: {
        openai: { configured: true, source: 'environment', label: 'OPENAI_API_KEY' },
      },
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    // Sidebar/listConnected must NOT surface env-detected providers — otherwise
    // a developer's `ANTHROPIC_AUTH_TOKEN` (set for Claude Code) would appear
    // as if the user had connected Anthropic in lorra.
    expect(adapter.listConnected().map((c) => c.id)).not.toContain('openai');

    // getAuthStatus still exposes the env-var hint so the ConnectView can
    // offer "免粘贴直连".
    const status = adapter.getAuthStatus('openai');
    expect(status.source).toBe('environment');
    expect(status.configured).toBe(true);
  });

  it('maps a provider defined in models.json (custom) → connectionMethod "custom"', () => {
    // Pre-write a custom provider into models.json to mark it custom.
    fs.writeFileSync(
      path.join(tmpDir, 'models.json'),
      JSON.stringify({
        providers: {
          acme: {
            name: 'Acme',
            baseUrl: 'https://api.acme.test',
            api: 'openai-completions',
            models: [],
          },
        },
      }),
    );
    const runtime = makeFakeRuntime({
      providers: [{ id: 'acme', name: 'Acme', auth: { apiKey: {} } }],
      models: [],
      authStatus: { acme: { configured: true, source: 'stored' } },
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const connected = adapter.listConnected();
    expect(connected[0].id).toBe('acme');
    expect(connected[0].connectionMethod).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  it('calls runtime.logout(providerId)', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
      authStatus: { anthropic: { configured: true, source: 'stored' } },
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.disconnect('anthropic');
    expect(result.isOk()).toBe(true);
    expect(runtime.calls.logout).toEqual(['anthropic']);
  });

  it('clears the default when the disconnected provider owns it', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
      authStatus: { anthropic: { configured: true, source: 'stored' } },
    });
    const settings = makeFakeSettings({
      defaultProvider: 'anthropic',
      defaultModel: 'claude',
    });
    const adapter = makeAdapter(runtime, settings);

    expect(adapter.getDefault()).toEqual({
      providerId: 'anthropic',
      modelId: 'claude',
    });

    await adapter.disconnect('anthropic');

    // Adapter cleared the default via settings.
    expect(settings.calls.setDefaultModelAndProvider.length).toBeGreaterThanOrEqual(1);
    expect(adapter.getDefault()).toBeNull();
  });

  it('does NOT clear the default when it belongs to a different provider', async () => {
    const runtime = makeFakeRuntime({
      providers: [
        { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } },
        { id: 'openai', name: 'OpenAI', auth: { apiKey: {} } },
      ],
      models: [],
      authStatus: {
        anthropic: { configured: true, source: 'stored' },
        openai: { configured: true, source: 'stored' },
      },
    });
    const settings = makeFakeSettings({
      defaultProvider: 'openai',
      defaultModel: 'gpt-x',
    });
    const adapter = makeAdapter(runtime, settings);

    await adapter.disconnect('anthropic');

    // Default still belongs to openai.
    expect(adapter.getDefault()).toEqual({
      providerId: 'openai',
      modelId: 'gpt-x',
    });
    // Adapter must not have rewritten the default for an unrelated disconnect.
    expect(settings.calls.setDefaultModelAndProvider).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('testConnection', () => {
  it('complete resolves → ok:true (uses first available model, calls complete with maxTokens)', async () => {
    const first: Model = {
      id: 'claude-x',
      name: 'Claude X',
      provider: 'anthropic',
      contextWindow: 8192,
      maxTokens: 1024,
      reasoning: false,
    };
    const second: Model = {
      id: 'claude-y',
      name: 'Claude Y',
      provider: 'anthropic',
      contextWindow: 8192,
      maxTokens: 1024,
      reasoning: false,
    };
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [first, second],
      available: { anthropic: [first, second] },
      completeImpl: () => Promise.resolve('done'),
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.testConnection('anthropic');

    expect(result.isOk()).toBe(true);
    // Took the FIRST available model.
    expect(runtime.calls.complete).toHaveLength(1);
    expect(runtime.calls.complete[0].model.id).toBe('claude-x');
    // Called with a maxTokens option (small).
    const opts = runtime.calls.complete[0].options as { maxTokens?: number } | undefined;
    expect(opts && typeof opts.maxTokens === 'number' && opts.maxTokens > 0).toBe(true);
  });

  it('complete rejects → ok:false with the error message', async () => {
    const first: Model = {
      id: 'claude-x',
      name: 'Claude X',
      provider: 'anthropic',
      contextWindow: 8,
      maxTokens: 1,
      reasoning: false,
    };
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [first],
      available: { anthropic: [first] },
      completeImpl: () => Promise.reject(new Error('invalid api key boom')),
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.testConnection('anthropic');

    expect(result.isErr()).toBe(true);
    expect(typeof (result as { error?: { message?: string } }).error?.message === 'string').toBe(
      true,
    );
    expect((result as { error?: { message?: string } }).error?.message).toMatch(/boom/);
  });

  it('no available models → ok:false with a definite message (never hangs)', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
      available: { anthropic: [] },
      // If the adapter wrongly awaits complete, this never resolves → test hangs & fails.
      completeImpl: () => new Promise(() => {}),
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.testConnection('anthropic');

    expect(result.isErr()).toBe(true);
    const message = (result as { error?: { message?: string } }).error?.message;
    expect(typeof message === 'string').toBe(true);
    expect((message ?? '').length).toBeGreaterThan(0);
  });

  it('slow complete exceeding timeout → ok:false definite, not indefinite', async () => {
    const first: Model = {
      id: 'claude-x',
      name: 'Claude X',
      provider: 'anthropic',
      contextWindow: 8,
      maxTokens: 1,
      reasoning: false,
    };
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [first],
      available: { anthropic: [first] },
      // Never resolves; adapter must time out.
      completeImpl: () => new Promise(() => {}),
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.testConnection('anthropic');

    expect(result.isErr()).toBe(true);
  }, 15000);
});

// ---------------------------------------------------------------------------
// customAdd
// ---------------------------------------------------------------------------

describe('customAdd', () => {
  it('valid input writes models.json in schema (input defaults, cost zeros), calls refresh, returns ok', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.customAdd({
      id: 'acme',
      name: 'Acme',
      baseUrl: 'https://api.acme.test',
      api: 'openai-completions',
      models: [
        {
          id: 'acme-1',
          name: 'Acme One',
          contextWindow: 32768,
          maxTokens: 4096,
          reasoning: true,
        },
      ],
      headers: { 'X-Custom': '1' },
    });

    expect(result.isOk()).toBe(true);
    expect(runtime.calls.refresh).toBeGreaterThanOrEqual(1);

    const parsed = readModelsJson(tmpDir);
    const providers = (parsed as { providers: Record<string, unknown> }).providers;
    const acme = providers.acme as Record<string, unknown>;
    expect(acme).toBeDefined();
    expect(acme.name).toBe('Acme');
    expect(acme.baseUrl).toBe('https://api.acme.test');
    expect(acme.api).toBe('openai-completions');

    const models = acme.models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('acme-1');
    expect(models[0].name).toBe('Acme One');
    expect(models[0].reasoning).toBe(true);
    expect(models[0].contextWindow).toBe(32768);
    expect(models[0].maxTokens).toBe(4096);
    // input defaults to ['text'] when not provided by the caller.
    expect(models[0].input).toEqual(['text']);
    // cost four numeric fields, zeros ok.
    const cost = models[0].cost as Record<string, number>;
    expect(cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('written models.json contains NO apiKey/secret/credential field or value', async () => {
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    await adapter.customAdd({
      id: 'acme',
      name: 'Acme',
      baseUrl: 'https://api.acme.test',
      api: 'openai-completions',
      models: [
        {
          id: 'acme-1',
          name: 'Acme One',
          contextWindow: 32768,
          maxTokens: 4096,
          reasoning: false,
        },
      ],
    });

    const raw = fs.readFileSync(path.join(tmpDir, 'models.json'), 'utf8');
    // No forbidden key name anywhere in the structure.
    const parsed = JSON.parse(raw) as unknown;
    // Credential-zero-transit: no credential field name appears anywhere in
    // the written models.json. Anchored detector targets credential semantics
    // precisely — apiKey/accessToken/clientSecret/token are caught, while
    // model-parameter keys maxTokens/contextWindow (which contain "token"/no
    // credential meaning) are NOT flagged.
    expect(hasCredentialKey(parsed)).toBe(false);
    // Positive control — prove the detector still has teeth: real credential
    // fields ARE caught, so an impl that wrote one would fail here. Also
    // assert model-parameter keys are NOT flagged (regression guard for the
    // exact maxTokens false positive this test had before the fix).
    expect(hasCredentialKey({ apiKey: 'sk-x' })).toBe(true);
    expect(hasCredentialKey({ api_key: 'k' })).toBe(true);
    expect(hasCredentialKey({ accessToken: 't' })).toBe(true);
    expect(hasCredentialKey({ clientSecret: 's' })).toBe(true);
    expect(hasCredentialKey({ token: 'tk' })).toBe(true);
    expect(hasCredentialKey({ password: 'p' })).toBe(true);
    expect(hasCredentialKey({ authorization: 'Bearer x' })).toBe(true);
    expect(hasCredentialKey({ maxTokens: 4096 })).toBe(false);
    expect(hasCredentialKey({ contextWindow: 8192 })).toBe(false);
    // Raw text must not carry the canonical secret-prefixed value either.
    expect(raw).not.toMatch(/sk-[a-zA-Z0-9]/);
    // The documented schema keys are the only provider-level fields carrying
    // no credential material — assert explicitly no apiKey/api_key key.
    expect(raw).not.toMatch(/api[_-]?key/i);
  });

  it('rejects collision with a built-in id (code builtin-id-conflict) and does NOT write', async () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models: [],
    });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.customAdd({
      id: 'anthropic', // built-in collision
      name: 'Fake Anthropic',
      baseUrl: 'https://x.test',
      api: 'openai-completions',
      models: [],
    });

    expect(result.isErr()).toBe(true);
    expect((result as { error?: { code?: string } }).error?.code).toBe('builtin-id-conflict');
    expect(fs.existsSync(path.join(tmpDir, 'models.json'))).toBe(false);
    // Must not have refreshed a write that never happened.
    expect(runtime.calls.refresh).toBe(0);
  });

  it('rejects non-lowercase / invalid id and does NOT write', async () => {
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.customAdd({
      id: 'Acme', // uppercase
      name: 'Acme',
      baseUrl: 'https://x.test',
      api: 'openai-completions',
      models: [],
    });

    expect(result.isErr()).toBe(true);
    expect((result as { error?: { code?: string } }).error?.code).toBeTruthy();
    expect(fs.existsSync(path.join(tmpDir, 'models.json'))).toBe(false);
    expect(runtime.calls.refresh).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// customRemove
// ---------------------------------------------------------------------------

describe('customRemove', () => {
  it('removes the provider entry from models.json, calls refresh, ok', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'models.json'),
      JSON.stringify({
        providers: {
          acme: {
            name: 'Acme',
            baseUrl: 'https://api.acme.test',
            api: 'openai-completions',
            models: [],
          },
          other: {
            name: 'Other',
            baseUrl: 'https://other.test',
            api: 'openai-completions',
            models: [],
          },
        },
      }),
    );
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    const result = await adapter.customRemove('acme');

    expect(result.isOk()).toBe(true);
    expect(runtime.calls.refresh).toBeGreaterThanOrEqual(1);
    const parsed = readModelsJson(tmpDir) as {
      providers: Record<string, unknown>;
    };
    expect(parsed.providers.acme).toBeUndefined();
    expect(parsed.providers.other).toBeDefined();
  });

  it('clears the default when the removed provider owned it', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'models.json'),
      JSON.stringify({
        providers: {
          acme: {
            name: 'Acme',
            baseUrl: 'https://api.acme.test',
            api: 'openai-completions',
            models: [],
          },
        },
      }),
    );
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const settings = makeFakeSettings({
      defaultProvider: 'acme',
      defaultModel: 'acme-1',
    });
    const adapter = makeAdapter(runtime, settings);

    expect(adapter.getDefault()).toEqual({
      providerId: 'acme',
      modelId: 'acme-1',
    });

    await adapter.customRemove('acme');

    expect(adapter.getDefault()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe('listModels', () => {
  const models: Model[] = [
    {
      id: 'm1',
      name: 'M1',
      provider: 'anthropic',
      contextWindow: 8192,
      maxTokens: 1024,
      reasoning: false,
    },
    {
      id: 'm2',
      name: 'M2',
      provider: 'anthropic',
      contextWindow: 8192,
      maxTokens: 1024,
      reasoning: true,
    },
  ];

  it('enabled = bare id in settings.getEnabledModels(); default flag on the default', () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models,
      // m1 available, m2 not in available snapshot
      available: { anthropic: [models[0]] },
    });
    const settings = makeFakeSettings({
      defaultProvider: 'anthropic',
      defaultModel: 'm1',
      enabledModels: ['m1'],
    });
    const adapter = makeAdapter(runtime, settings);

    const list = adapter.listModels('anthropic');
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2']);
    // bare id, not provider/model
    expect(list[0].id).toBe('m1');
    const m1 = list.find((m) => m.id === 'm1');
    const m2 = list.find((m) => m.id === 'm2');
    expect(m1?.enabled).toBe(true);
    expect(m2?.enabled).toBe(false);
    expect(m1?.default).toBe(true);
    expect(m2?.default).toBe(false);
    expect(m1?.available).toBe(true); // in getAvailable snapshot
    expect(m2?.available).toBe(false); // not in snapshot
  });

  it('undefined getEnabledModels means ALL enabled', () => {
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models,
      available: { anthropic: [...models] },
    });
    const settings = makeFakeSettings({
      // enabledModels undefined → all enabled
    });
    const adapter = makeAdapter(runtime, settings);

    const list = adapter.listModels('anthropic');
    expect(list.every((m) => m.enabled === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDefault
// ---------------------------------------------------------------------------

describe('getDefault', () => {
  it('returns providerId/modelId from settings', () => {
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const adapter = makeAdapter(
      runtime,
      makeFakeSettings({ defaultProvider: 'openai', defaultModel: 'gpt-x' }),
    );

    expect(adapter.getDefault()).toEqual({
      providerId: 'openai',
      modelId: 'gpt-x',
    });
  });

  it('returns null when no default is set (getDefaultProvider falsy)', () => {
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const adapter = makeAdapter(runtime, makeFakeSettings());

    expect(adapter.getDefault()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setDefault
// ---------------------------------------------------------------------------

describe('setDefault', () => {
  it('calls settings.setDefaultModelAndProvider and returns ok', () => {
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const settings = makeFakeSettings();
    const adapter = makeAdapter(runtime, settings);

    const result = adapter.setDefault('openai', 'gpt-x');

    expect(result.isOk()).toBe(true);
    expect(settings.calls.setDefaultModelAndProvider).toEqual([
      { provider: 'openai', modelId: 'gpt-x' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// toggleModel
// ---------------------------------------------------------------------------

describe('toggleModel', () => {
  it('enabled=true adds the BARE model id to the enabled list', () => {
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const settings = makeFakeSettings({ enabledModels: ['m1'] });
    const adapter = makeAdapter(runtime, settings);

    const result = adapter.toggleModel('anthropic', 'm2', true);

    expect(result.isOk()).toBe(true);
    expect(settings.calls.setEnabledModels).toEqual([['m1', 'm2']]);
  });

  it('enabled=false removes the BARE model id from the enabled list', () => {
    const runtime = makeFakeRuntime({ providers: [], models: [] });
    const settings = makeFakeSettings({ enabledModels: ['m1', 'm2'] });
    const adapter = makeAdapter(runtime, settings);

    const result = adapter.toggleModel('anthropic', 'm2', false);

    expect(result.isOk()).toBe(true);
    expect(settings.calls.setEnabledModels).toEqual([['m1']]);
  });

  it('enabled=false when current list undefined (all enabled) → writes a list excluding the target', () => {
    // Interpretation (contract invites assertion of expected array):
    // undefined = "all enabled"; toggling one OFF yields every bare model id
    // from runtime.getModels EXCEPT the target.
    const models: Model[] = [
      {
        id: 'm1',
        name: 'M1',
        provider: 'anthropic',
        contextWindow: 1,
        maxTokens: 1,
        reasoning: false,
      },
      {
        id: 'm2',
        name: 'M2',
        provider: 'anthropic',
        contextWindow: 1,
        maxTokens: 1,
        reasoning: false,
      },
      {
        id: 'm3',
        name: 'M3',
        provider: 'anthropic',
        contextWindow: 1,
        maxTokens: 1,
        reasoning: false,
      },
    ];
    const runtime = makeFakeRuntime({
      providers: [{ id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } }],
      models,
      // enabledModels undefined → all enabled
    });
    const settings = makeFakeSettings();
    const adapter = makeAdapter(runtime, settings);

    adapter.toggleModel('anthropic', 'm2', false);

    expect(settings.calls.setEnabledModels).toHaveLength(1);
    const written = settings.calls.setEnabledModels[0];
    // A defined array (not undefined) that excludes m2.
    expect(Array.isArray(written)).toBe(true);
    expect(written).not.toContain('m2');
    expect(written).toEqual(['m1', 'm3']);
  });
});

// ---------------------------------------------------------------------------
// getAvailable
// ---------------------------------------------------------------------------

describe('getAvailable', () => {
  it('maps runtime.getAvailable() to ModelDto[] (auth-driven), with enabled/default flags from settings', () => {
    const available: Model[] = [
      {
        id: 'claude-x',
        name: 'Claude X',
        provider: 'anthropic',
        contextWindow: 8192,
        maxTokens: 1024,
        reasoning: false,
      },
      {
        id: 'gpt-x',
        name: 'GPT X',
        provider: 'openai',
        contextWindow: 8192,
        maxTokens: 1024,
        reasoning: true,
      },
    ];
    const runtime = makeFakeRuntime({
      providers: [
        { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } },
        { id: 'openai', name: 'OpenAI', auth: { apiKey: {} } },
      ],
      models: available,
      available: { anthropic: [available[0]], openai: [available[1]] },
    });
    const settings = makeFakeSettings({
      defaultProvider: 'openai',
      defaultModel: 'gpt-x',
      enabledModels: ['claude-x'],
    });
    const adapter = makeAdapter(runtime, settings);

    const list = adapter.getAvailable();
    expect(list.map((m) => m.id).sort()).toEqual(['claude-x', 'gpt-x']);
    // All entries come from getAvailable → available:true
    expect(list.every((m) => m.available === true)).toBe(true);
    const gpt = list.find((m) => m.id === 'gpt-x');
    const claude = list.find((m) => m.id === 'claude-x');
    expect(gpt?.default).toBe(true);
    expect(claude?.default).toBe(false);
    expect(claude?.enabled).toBe(true);
    expect(gpt?.enabled).toBe(false); // not in enabledModels list
  });
});
