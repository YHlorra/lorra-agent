import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Api, Context, Model, Provider } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { err, ok, type Result, toLorraError } from '../../shared/result';
import { lorraConfigDir } from './lorra-config-dir';

export type { Result } from '../../shared/result';

// ===== Public contract surface =====

export type ProviderGroup = 'popular' | 'all';

export interface ProviderDto {
  id: string;
  name: string;
  group: ProviderGroup;
  modelCount: number;
  auth: { apiKey: boolean; oauth: boolean };
  available: boolean;
  reason?: 'oauth-only';
}

export type ConnectionMethod = 'apiKey' | 'environment' | 'custom';

export interface ConnectedProviderDto {
  id: string;
  name: string;
  connectionMethod: ConnectionMethod;
  modelCount: number;
}

export interface ModelDto {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  enabled: boolean;
  default: boolean;
  available: boolean;
}

export interface CustomProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
  }>;
  headers?: Record<string, string>;
}

// ===== Internal constants & helpers =====

const POPULAR_PROVIDER_IDS = ['anthropic', 'openai', 'deepseek', 'zai', 'minimax-cn'] as const;
const CUSTOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_TEST_TIMEOUT_MS = 8000;

/** Sync read of custom provider ids from models.json (for the sync listConnected). */
function readCustomProviderIdsSync(configDir: string): Set<string> {
  try {
    const raw = readFileSync(path.join(configDir, 'models.json'), 'utf8');
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> } | null;
    return new Set(Object.keys(parsed?.providers ?? {}));
  } catch {
    return new Set();
  }
}

/** Async read of the full models.json document (defensive; absent/invalid -> empty). */
async function readModelsJson(modelsPath: string): Promise<{ providers: Record<string, unknown> }> {
  try {
    const raw = await readFile(modelsPath, 'utf8');
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> } | null;
    return { providers: parsed?.providers ?? {} };
  } catch {
    return { providers: {} };
  }
}

// ===== Adapter =====

export class ModelConfigAdapter {
  private readonly runtime: ModelRuntime;
  private readonly settings: SettingsManager;
  private readonly configDir: string;
  private readonly testTimeoutMs: number;

  constructor(deps: {
    runtime: ModelRuntime;
    settings: SettingsManager;
    configDir: string;
    testTimeoutMs?: number;
  }) {
    this.runtime = deps.runtime;
    this.settings = deps.settings;
    this.configDir = deps.configDir;
    this.testTimeoutMs = deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  static async create(opts: {
    workspaceCwd: string;
    homeDir?: string;
  }): Promise<ModelConfigAdapter> {
    const configDir = opts.homeDir ? path.join(opts.homeDir, '.lorra') : lorraConfigDir();
    // Create the config dir first so the SDK's authPath/modelsPath parents exist.
    await mkdir(configDir, { recursive: true });
    const runtime = await ModelRuntime.create({
      modelsPath: path.join(configDir, 'models.json'),
      authPath: path.join(configDir, 'auth.json'),
      modelsStorePath: path.join(configDir, 'cache'),
    });
    const settings = SettingsManager.create(opts.workspaceCwd, configDir);
    return new ModelConfigAdapter({ runtime, settings, configDir });
  }

  catalog(): ProviderDto[] {
    const providers = this.runtime.getProviders();
    const popularOrdered = POPULAR_PROVIDER_IDS.flatMap((pid) => {
      const found = providers.find((p) => p.id === pid);
      return found ? [found] : [];
    });
    const rest = providers
      .filter((p) => !(POPULAR_PROVIDER_IDS as readonly string[]).includes(p.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    return [
      ...popularOrdered.map((p) => this.toProviderDto(p, 'popular')),
      ...rest.map((p) => this.toProviderDto(p, 'all')),
    ];
  }

  private toProviderDto(p: Provider, group: ProviderGroup): ProviderDto {
    const hasApiKey = !!p.auth?.apiKey;
    const hasOauth = !!p.auth?.oauth;
    const oauthOnly = hasOauth && !hasApiKey;
    const dto: ProviderDto = {
      id: p.id,
      name: p.name,
      group,
      modelCount: this.runtime.getModels(p.id).length,
      auth: { apiKey: hasApiKey, oauth: hasOauth },
      available: !oauthOnly,
    };
    if (oauthOnly) dto.reason = 'oauth-only';
    return dto;
  }

  listConnected(): ConnectedProviderDto[] {
    const providers = this.runtime.getProviders();
    const customIds = readCustomProviderIdsSync(this.configDir);
    const result: ConnectedProviderDto[] = [];
    for (const p of providers) {
      const status = this.runtime.getProviderAuthStatus(p.id);
      // : env-var-detected credentials do NOT count as user
      // configuration. A developer running `npm start` with `ANTHROPIC_AUTH_TOKEN`
      // (set for Claude Code) would otherwise see Anthropic appear as "已连接"
      // even though the lorra user never connected anything. The user must
      // explicitly call connect — paste a key, or use the env-var-paste hint
      // — for the provider to land here.
      if (status.source === 'environment') continue;
      if (!status.configured) continue;
      const connectionMethod: ConnectionMethod = customIds.has(p.id) ? 'custom' : 'apiKey';
      result.push({
        id: p.id,
        name: p.name,
        connectionMethod,
        modelCount: this.runtime.getModels(p.id).length,
      });
    }
    return result;
  }

  /** Per-provider auth status (configured/source). Used by the ConnectView to
 * detect env-var presence without putting env-detected providers into the
 * "已连接" sidebar. */
  getAuthStatus(providerId: string): {
    configured: boolean;
    source?:
      | 'stored'
      | 'runtime'
      | 'environment'
      | 'fallback'
      | 'models_json_key'
      | 'models_json_command';
    label?: string;
  } {
    return this.runtime.getProviderAuthStatus(providerId);
  }

  async connect(providerId: string, material?: string): Promise<Result> {
    // Credential zero-transit (/D3): `material` is handed ONLY to the
    // SDK credential entry via interaction.prompt — never logged, never persisted
    // to models.json, never echoed in Result messages.
    //
    // The SDK's login performs a network round-trip to validate the key
    // against the provider's API. With slow proxies / unreachable base URLs
    // (e.g. dev-time `ANTHROPIC_BASE_URL` pointing at a flaky gateway) the
    // request can stall for the full TCP timeout — the user sees the
    // "连接中…" button indefinitely. Race login against a hard timeout that
    // matches testConnection so the UI gets fast feedback.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.runtime.login(providerId, 'api_key', {
          prompt: async () => material ?? '',
          notify: () => {},
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('connect-timeout')), this.testTimeoutMs);
        }),
      ]);
      return ok();
    } catch (e) {
      return err(toLorraError(e, 'connect-failed'));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async disconnect(providerId: string): Promise<Result> {
    try {
      const defaultProvider = this.settings.getDefaultProvider();
      await this.runtime.logout(providerId);
      if (defaultProvider === providerId) {
        // Clear the default so getDefault observes null. SettingsManager stores
        // '' (falsy) for defaultProvider/defaultModel; my getDefault returns
        // null for any falsy provider/model pair.
        this.settings.setDefaultModelAndProvider('', '');
      }
      return ok();
    } catch (e) {
      return err(toLorraError(e, 'disconnect-failed'));
    }
  }

  async testConnection(providerId: string): Promise<Result> {
    try {
      const all = this.runtime.getAvailableSnapshot();
      const available = providerId ? all.filter((m) => m.provider === providerId) : all;
      const model = available[0];
      if (!model) {
        return err({
          code: 'no-available-model',
          message: `no available model for provider: ${providerId}`,
        });
      }
      // Minimal valid pi-ai Context: a single short user message.
      const context: Context = {
        messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
      };
      // Race the real completion against a hard timeout so the test always settles
      // (spec: "never an indefinite loading state").
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.runtime.complete(model, context, { maxTokens: 8 }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), this.testTimeoutMs);
          }),
        ]);
        return ok();
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (e) {
      return err(toLorraError(e, 'test-failed'));
    }
  }

  async customAdd(input: CustomProviderInput): Promise<Result> {
    // Validate FIRST — no write or refresh on validation failure.
    if (!CUSTOM_ID_PATTERN.test(input.id)) {
      return err({ code: 'invalid-id', message: `invalid provider id: ${input.id}` });
    }
    try {
      const modelsPath = path.join(this.configDir, 'models.json');
      const doc = await readModelsJson(modelsPath);
      const customIds = new Set(Object.keys(doc.providers));
      const builtin = this.runtime.getProvider(input.id);
      if (builtin && !customIds.has(input.id)) {
        return err({
          code: 'builtin-id-conflict',
          message: `id collides with built-in provider: ${input.id}`,
        });
      }
      // CRITICAL : no apiKey/credential field — models.json is config
      // only. Credentials flow through connect -> login -> SDK-managed auth.json.
      const providerEntry: Record<string, unknown> = {
        name: input.name,
        baseUrl: input.baseUrl,
        api: input.api,
        models: input.models.map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        })),
      };
      if (input.headers) providerEntry.headers = input.headers;
      doc.providers[input.id] = providerEntry;
      await writeFile(modelsPath, JSON.stringify(doc, null, 2), 'utf8');
      await this.runtime.refresh();
      return ok();
    } catch (e) {
      return err(toLorraError(e, 'custom-add-failed'));
    }
  }

  async customRemove(providerId: string): Promise<Result> {
    try {
      const modelsPath = path.join(this.configDir, 'models.json');
      const doc = await readModelsJson(modelsPath);
      delete doc.providers[providerId];
      await writeFile(modelsPath, JSON.stringify(doc, null, 2), 'utf8');
      await this.runtime.refresh();
      const defaultProvider = this.settings.getDefaultProvider();
      if (defaultProvider === providerId) {
        this.settings.setDefaultModelAndProvider('', '');
      }
      return ok();
    } catch (e) {
      return err(toLorraError(e, 'custom-remove-failed'));
    }
  }

  listModels(providerId?: string): ModelDto[] {
    const all = this.runtime.getAvailableSnapshot();
    const availableIds = new Set(
      (providerId ? all.filter((m) => m.provider === providerId) : all).map((m) => m.id),
    );
    return this.mapModelDtos(this.runtime.getModels(providerId), availableIds);
  }

  // ponytail: O(n) getAvailable + getModels per call; fine at <100 models/catalog.
  // Hoist to a single snapshot read if provider counts grow past hundreds.
  private mapModelDtos(models: readonly Model<Api>[], availableIds: Set<string>): ModelDto[] {
    const enabledModels = this.settings.getEnabledModels();
    // undefined enabledModels => ALL models enabled (OQ-3). Use the listed set as
    // the fallback so each listed model reports enabled=true when undefined.
    const enabledSet = enabledModels ? new Set(enabledModels) : new Set(models.map((m) => m.id));
    const defaultProvider = this.settings.getDefaultProvider();
    const defaultModel = this.settings.getDefaultModel();
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      enabled: enabledSet.has(model.id),
      default: defaultProvider === model.provider && defaultModel === model.id,
      // available = membership in runtime.getAvailable snapshot (auth-gated).
      // See design D12 / OQ-3 (getAvailable is auth-driven).
      available: availableIds.has(model.id),
    }));
  }

  getDefault(): { providerId: string; modelId: string } | null {
    const p = this.settings.getDefaultProvider();
    const m = this.settings.getDefaultModel();
    return p && m ? { providerId: p, modelId: m } : null;
  }

  setDefault(providerId: string, modelId: string): Result {
    this.settings.setDefaultModelAndProvider(providerId, modelId);
    return ok();
  }

  toggleModel(providerId: string, modelId: string, enabled: boolean): Result {
    // enabledModels is a global bare-ID list (OQ-3): undefined = all enabled,
    // a concrete list = exact IDs enabled. providerId is part of the signature
    // for UI context but the SDK stores bare IDs, so the toggle keys on modelId.
    void providerId;
    const current = this.settings.getEnabledModels();
    if (enabled) {
      if (current === undefined) {
        // All already enabled; enabling one more is a no-op.
        this.settings.setEnabledModels(undefined);
      } else {
        this.settings.setEnabledModels([...new Set([...current, modelId])]);
      }
    } else if (current === undefined) {
      // OFF-with-undefined: materialize all bare IDs then drop the target.
      const allIds = this.runtime
        .getModels()
        .map((m) => m.id)
        .filter((id) => id !== modelId);
      this.settings.setEnabledModels(allIds);
    } else {
      this.settings.setEnabledModels(current.filter((id) => id !== modelId));
    }
    return ok();
  }

  getAvailable(): ModelDto[] {
    // getAvailableSnapshot is the sync view; the async getAvailable returns
    // the same auth-gated set but resolves after a refresh. Sync is what the
    // contract expects. Every returned model is by definition available ->
    // available:true.
    //
    // : drop models whose provider is configured ONLY via env vars. The
    // chat-pane model state and Composer default name must not surface Claude
    // (or any other env-detected) models in a developer's local run.
    const all = this.runtime.getAvailableSnapshot();
    const filtered = all.filter((m) => {
      const status = this.runtime.getProviderAuthStatus(m.provider);
      return status.source !== 'environment';
    });
    return this.mapModelDtos(filtered, new Set(filtered.map((m) => m.id)));
  }
}
