import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/lib/app-store';
import type { MessageKey } from '../shared/i18n-core';
import { useT } from './lib/i18n';
import { useDefaultModelSelector, useModels, useProviders } from './model-hooks';

/** 词条取值函数形状(纯格式化模块函数经此参数注入,组件内传 useT 结果)。 */
type Tr = (key: MessageKey, params?: Record<string, string | number>) => string;

// 10 KnownApi values from @earendil-works/pi-ai (types.d.ts KnownApi).
const API_TYPES = [
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'mistral-conversations',
  'pi-messages',
] as const;

type Focus = { kind: 'connect'; providerId: string } | { kind: 'custom' } | null;

interface ProvidersPageProps {
  onBack: () => void;
}

export function ProvidersPage({ onBack }: ProvidersPageProps): JSX.Element {
  const providers = useProviders();
  const t = useT();
  const [focus, setFocus] = useState<Focus>(null);

  return (
    <div className="pc-page">
      <aside className="pc-rail" aria-label={t('providers.rail.navLabel')}>
        <DefaultModelSelector />
        <CompileModelSelector />
        <ConnectedRail providers={providers} onFocus={setFocus} />
        <button
          type="button"
          className="pc-custom-entry"
          onClick={() => setFocus({ kind: 'custom' })}
        >
          {t('providers.rail.customAdd')}
        </button>
      </aside>

      <section className="pc-content" aria-label={t('providers.catalog.regionLabel')}>
        {focus === null ? (
          <CatalogList providers={providers} onFocus={setFocus} />
        ) : focus.kind === 'connect' ? (
          <ConnectView
            key={focus.providerId}
            providerId={focus.providerId}
            providers={providers}
            onBack={() => setFocus(null)}
          />
        ) : (
          <CustomForm
            providers={providers}
            onDone={(id) => setFocus({ kind: 'connect', providerId: id })}
            onCancel={() => setFocus(null)}
          />
        )}
      </section>

      <button type="button" className="pc-back" onClick={onBack}>
        {t('providers.backToWorkspace')}
      </button>
    </div>
  );
}

// ── Left rail: default model selector ─────────────────────────────────────

function DefaultModelSelector(): JSX.Element {
  const sel = useDefaultModelSelector();
  const t = useT();

  return (
    <div className="pc-default">
      <p className="pc-rail-heading">{t('providers.default.heading')}</p>
      {sel.loading ? (
        <p className="pc-muted">{t('providers.loading')}</p>
      ) : sel.available.length === 0 ? (
        <p className="pc-muted">{t('providers.default.noModels')}</p>
      ) : (
        <select
          className="pc-select"
          value={sel.current ? `${sel.current.providerId}::${sel.current.modelId}` : ''}
          onChange={(e) => {
            const [providerId, modelId] = e.target.value.split('::');
            if (providerId && modelId) void sel.setDefault(providerId, modelId);
          }}
        >
          <option value="" disabled>
            {t('providers.default.selectPlaceholder')}
          </option>
          {sel.available.map((m) => (
            <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
              {m.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ── Left rail: semantic cleaning model selector ────────────────
// 语义清洗专用模型(每日摘要/分类编译):null = 跟随默认。读写 app-store →
// settings.json(compileModel),与 DefaultModelSelector 共用 available 列表。

function CompileModelSelector(): JSX.Element {
  const sel = useDefaultModelSelector();
  const t = useT();
  const compileModel = useAppStore((s) => s.compileModel);
  const setCompileModel = useAppStore((s) => s.setCompileModel);

  return (
    <div className="pc-default">
      <p className="pc-rail-heading">{t('providers.compile.heading')}</p>
      <p className="pc-muted">{t('providers.compile.desc')}</p>
      {sel.loading ? (
        <p className="pc-muted">{t('providers.loading')}</p>
      ) : sel.available.length === 0 ? (
        <p className="pc-muted">{t('providers.compile.noModels')}</p>
      ) : (
        <select
          className="pc-select"
          data-testid="compile-model-select"
          value={compileModel ? `${compileModel.providerId}::${compileModel.modelId}` : ''}
          onChange={(e) => {
            const [providerId, modelId] = e.target.value.split('::');
            if (providerId && modelId) setCompileModel({ providerId, modelId });
            else setCompileModel(null);
          }}
        >
          <option value="">{t('providers.compile.followDefault')}</option>
          {sel.available.map((m) => (
            <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
              {m.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ── Left rail: connected providers ───────────────────────────────────────

function ConnectedRail({
  providers,
  onFocus,
}: {
  providers: ReturnType<typeof useProviders>;
  onFocus: (f: Focus) => void;
}): JSX.Element {
  const t = useT();
  return (
    <div className="pc-connected">
      <p className="pc-rail-heading">{t('providers.connected.heading')}</p>
      {providers.loading && providers.connected.length === 0 ? (
        <p className="pc-muted">{t('providers.loading')}</p>
      ) : providers.connected.length === 0 ? (
        <p className="pc-muted">{t('providers.connected.empty')}</p>
      ) : (
        <ul className="pc-connected-list">
          {providers.connected.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="pc-connected-row"
                onClick={() => onFocus({ kind: 'connect', providerId: c.id })}
              >
                <span className="pc-avatar" aria-hidden="true">
                  {c.name.slice(0, 1)}
                </span>
                <span className="pc-connected-name">{c.name}</span>
                <span className="pc-tag">{methodLabel(c.connectionMethod, t)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function methodLabel(m: ConnectionMethod, tr: Tr): string {
  if (m === 'apiKey') return tr('providers.method.apiKey');
  return m === 'environment' ? tr('providers.method.environment') : tr('providers.method.custom');
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Right content: catalog list ───────────────────────────────────────────

function CatalogList({
  providers,
  onFocus,
}: {
  providers: ReturnType<typeof useProviders>;
  onFocus: (f: Focus) => void;
}): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return providers.catalog;
    return providers.catalog.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    );
  }, [providers.catalog, q]);

  const popular = filtered.filter((p) => p.group === 'popular');
  const all = filtered.filter((p) => p.group === 'all');
  // oauth-only providers go to the bottom of their group.
  const sortOauthLast = (a: ProviderDto, b: ProviderDto) =>
    Number(a.available === false) - Number(b.available === false);

  return (
    <div className="pc-catalog">
      <header className="pc-content-head">
        <h1>{t('providers.connect.title')}</h1>
        <div className="pc-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder={t('providers.catalog.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('providers.catalog.search')}
          />
        </div>
      </header>

      {providers.error ? (
        <div className="pc-error" role="alert">
          <p>{t('providers.catalog.loadFailed', { error: providers.error })}</p>
          <button type="button" onClick={() => void providers.refresh()}>
            {t('providers.retry')}
          </button>
        </div>
      ) : providers.loading && providers.catalog.length === 0 ? (
        <p className="pc-muted">{t('providers.loading')}</p>
      ) : (
        <div className="pc-catalog-body">
          {popular.length > 0 && (
            <ProviderGroup
              title={t('providers.catalog.popular')}
              items={[...popular].sort(sortOauthLast)}
              connected={providers.connected}
              onFocus={onFocus}
            />
          )}
          {all.length > 0 && (
            <ProviderGroup
              title={t('providers.catalog.all')}
              items={[...all].sort(sortOauthLast)}
              connected={providers.connected}
              onFocus={onFocus}
            />
          )}
          {filtered.length === 0 && <p className="pc-muted">{t('providers.catalog.noMatch')}</p>}
        </div>
      )}
    </div>
  );
}

function ProviderGroup({
  title,
  items,
  connected,
  onFocus,
}: {
  title: string;
  items: ProviderDto[];
  connected: ConnectedProviderDto[];
  onFocus: (f: Focus) => void;
}): JSX.Element {
  const t = useT();
  return (
    <section className="pc-group">
      <h2 className="pc-group-head">{title}</h2>
      <ul className="pc-provider-list">
        {items.map((p) => {
          const con = connected.find((c) => c.id === p.id);
          const oauthOnly = p.available === false;
          return (
            <li key={p.id}>
              <div className={`pc-provider-row${oauthOnly ? ' is-disabled' : ''}`}>
                <span className="pc-avatar" aria-hidden="true">
                  {p.name.slice(0, 1)}
                </span>
                <div className="pc-provider-meta">
                  <p className="pc-provider-name">{p.name}</p>
                  <p className="pc-provider-sub">
                    {oauthOnly
                      ? t('providers.catalog.oauthOnly')
                      : t('providers.catalog.modelCount', { count: p.modelCount })}
                    {con ? ` · ${methodLabel(con.connectionMethod, t)}` : ''}
                  </p>
                </div>
                {oauthOnly ? (
                  <span className="pc-tag pc-tag-muted">{t('providers.catalog.oauthOnly')}</span>
                ) : con ? (
                  <button
                    type="button"
                    className="pc-link"
                    onClick={() => onFocus({ kind: 'connect', providerId: p.id })}
                  >
                    {t('providers.catalog.manage')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="pc-link"
                    onClick={() => onFocus({ kind: 'connect', providerId: p.id })}
                  >
                    {t('providers.catalog.connect')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Right content: connect / detail view ───────────────────────────────────

function ConnectView({
  providerId,
  providers,
  onBack,
}: {
  providerId: string;
  providers: ReturnType<typeof useProviders>;
  onBack: () => void;
}): JSX.Element {
  const t = useT();
  const provider = providers.catalog.find((p) => p.id === providerId);
  const connected = providers.connected.find((c) => c.id === providerId);
  const models = useModels(connected || provider ? providerId : undefined);

  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectedNow, setConnectedNow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [finishing, setFinishing] = useState(false);

  const envDetected = connected?.connectionMethod === 'environment';
  // : listConnected now filters env-var-detected providers out, so
  // for the "未连接 + 有环境变量" case we have to query auth status directly to
  // keep the "已从环境变量检测到" hint accurate.
  const [envFromStatus, setEnvFromStatus] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (connected || connectedNow) {
      setEnvFromStatus(false);
      return;
    }
    void window.lorra.providers
      .getAuthStatus({ providerId })
      .then((res) => {
        if (cancelled) return;
        setEnvFromStatus(res.ok && res.value?.source === 'environment');
      })
      .catch(() => {
        if (cancelled) return;
        setEnvFromStatus(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, connectedNow, providerId]);
  const showEnvHint = envDetected || envFromStatus;
  const showModels = connected || connectedNow;

  useEffect(() => {
    setTestResult(null);
  }, [providerId]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    const res = await providers.connect(providerId, apiKey.trim() || undefined);
    setConnecting(false);
    if (res.ok) {
      setConnectedNow(true);
      setApiKey('');
      void models.reload();
    } else {
      setConnectError(res.message ?? t('providers.connect.failedFallback'));
    }
  }, [apiKey, models, providerId, providers, t]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const res = await providers.testConnection(providerId);
    setTesting(false);
    setTestResult(res);
  }, [providerId, providers]);

  const handleDisconnect = useCallback(async () => {
    const res = await providers.disconnect(providerId);
    if (res.ok) onBack();
    else setConnectError(res.message ?? t('providers.connect.disconnectFailed'));
  }, [onBack, providerId, providers, t]);

  const handleFinish = useCallback(async () => {
    setFinishing(true);
    // D9: if no default set, auto-pick first enabled model for this provider.
    const def = await window.lorra.models.getDefault();
    if (def.ok && !def.value) {
      const firstEnabled = models.models.find((m) => m.enabled);
      if (firstEnabled) {
        await window.lorra.models.setDefault({
          providerId: firstEnabled.provider,
          modelId: firstEnabled.id,
        });
        await models.reload();
      }
    }
    setFinishing(false);
    onBack();
  }, [models, onBack]);

  if (!provider && !connected) {
    return (
      <div className="pc-connect">
        <p className="pc-muted">{t('providers.connect.notFound')}</p>
        <button type="button" className="pc-link" onClick={onBack}>
          {t('providers.connect.backToList')}
        </button>
      </div>
    );
  }

  const name = provider?.name ?? connected?.name ?? providerId;

  return (
    <div className="pc-connect">
      <header className="pc-content-head">
        <button type="button" className="pc-link" onClick={onBack}>
          ← {t('providers.connect.backToList')}
        </button>
        <h1>{name}</h1>
        {connected && (
          <span className="pc-tag pc-tag-ok">
            {t('providers.connect.connectedTag', {
              method: methodLabel(connected.connectionMethod, t),
            })}
          </span>
        )}
      </header>

      <div className="pc-connect-body">
        <section className="pc-card">
          <p className="pc-card-title">{t('providers.connect.apiKeyTitle')}</p>
          {showEnvHint && (
            <p className="pc-env-note" role="status">
              {t('providers.connect.envDetected')}
            </p>
          )}
          <input
            type="password"
            className="pc-input"
            placeholder={
              showEnvHint
                ? t('providers.connect.envPlaceholder')
                : t('providers.connect.apiKeyPlaceholder')
            }
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            aria-label={t('providers.connect.apiKeyTitle')}
          />
          <div className="pc-actions">
            <button
              type="button"
              className="pc-btn pc-btn-primary"
              disabled={connecting}
              onClick={handleConnect}
            >
              {connecting
                ? t('providers.connect.connecting')
                : connected
                  ? t('providers.connect.reconnect')
                  : t('providers.catalog.connect')}
            </button>
            <button
              type="button"
              className="pc-btn"
              disabled={testing || (!connected && !connectedNow)}
              onClick={handleTest}
            >
              {testing ? t('providers.connect.testing') : t('providers.connect.test')}
            </button>
            {connected && (
              <button type="button" className="pc-link pc-link-danger" onClick={handleDisconnect}>
                {t('providers.connect.disconnect')}
              </button>
            )}
          </div>
          {connectError && (
            <p className="pc-error-text" role="alert">
              {t('providers.connect.failed', { message: connectError })}
            </p>
          )}
          {testResult && (
            <p className={testResult.ok ? 'pc-ok-text' : 'pc-error-text'} role="status">
              {testResult.ok
                ? t('providers.connect.success')
                : t('providers.connect.failed', { message: testResult.message ?? '' })}
            </p>
          )}
        </section>

        {showModels ? (
          <section className="pc-card">
            <p className="pc-card-title">{t('providers.models.heading')}</p>
            {models.loading && models.models.length === 0 ? (
              <p className="pc-muted">{t('providers.models.loading')}</p>
            ) : models.models.length === 0 ? (
              <p className="pc-muted">{t('providers.models.empty')}</p>
            ) : (
              <ul className="pc-model-list">
                {models.models.map((m) => (
                  <li key={m.id} className="pc-model-row">
                    <label className="pc-model-check">
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        onChange={(e) => void models.toggle(m.provider, m.id, e.target.checked)}
                      />
                      <span className="pc-model-name">{m.name}</span>
                    </label>
                    <span className="pc-model-meta">
                      {m.reasoning ? t('providers.models.reasoning') : ''}
                      {m.contextWindow ? ` · ${formatCtx(m.contextWindow)}` : ''}
                    </span>
                    <button
                      type="button"
                      className={`pc-star${m.default ? ' is-on' : ''}`}
                      onClick={() => void models.setDefault(m.provider, m.id)}
                      aria-label={
                        m.default
                          ? t('providers.models.isDefault')
                          : t('providers.models.setDefault')
                      }
                      disabled={!m.enabled}
                    >
                      {m.default ? '★' : '☆'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <p className="pc-muted">{t('providers.models.hint')}</p>
        )}
      </div>

      <footer className="pc-connect-foot">
        <button
          type="button"
          className="pc-btn pc-btn-primary"
          disabled={finishing}
          onClick={handleFinish}
        >
          {finishing ? t('providers.connect.saving') : t('providers.connect.finish')}
        </button>
      </footer>
    </div>
  );
}

function formatCtx(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// ── Right content: custom provider form ────────────────────────────────────

interface CustomModelRow {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}
interface CustomHeaderRow {
  key: string;
  value: string;
}

function CustomForm({
  providers,
  onDone,
  onCancel,
}: {
  providers: ReturnType<typeof useProviders>;
  onDone: (id: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState<string>('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [modelRows, setModelRows] = useState<CustomModelRow[]>([
    { id: '', name: '', contextWindow: 8192, maxTokens: 4096, reasoning: false },
  ]);
  const [headerRows, setHeaderRows] = useState<CustomHeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const builtinIds = useMemo(
    () => new Set(providers.catalog.map((p) => p.id)),
    [providers.catalog],
  );
  const idPattern = /^[a-z0-9][a-z0-9-]*$/;
  const idTrim = id.trim();
  const idCollision = builtinIds.has(idTrim);
  const idValid = idPattern.test(idTrim) && !idCollision;
  const idTouched = idTrim.length > 0;

  const baseUrlValid = isHttpsUrl(baseUrl.trim());
  const canSubmit =
    idValid && name.trim() !== '' && baseUrlValid && apiKey.trim() !== '' && !submitting;

  function updateModel(idx: number, patch: Partial<CustomModelRow>) {
    setModelRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addModel() {
    setModelRows((rows) => [
      ...rows,
      { id: '', name: '', contextWindow: 8192, maxTokens: 4096, reasoning: false },
    ]);
  }
  function removeModel(idx: number) {
    setModelRows((rows) => rows.filter((_, i) => i !== idx));
  }
  function updateHeader(idx: number, patch: Partial<CustomHeaderRow>) {
    setHeaderRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addHeader() {
    setHeaderRows((rows) => [...rows, { key: '', value: '' }]);
  }
  function removeHeader(idx: number) {
    setHeaderRows((rows) => rows.filter((_, i) => i !== idx));
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    const headers: Record<string, string> = {};
    for (const h of headerRows) {
      const k = h.key.trim();
      if (k) headers[k] = h.value;
    }
    const input: CustomProviderInput = {
      id: idTrim,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      api,
      models: modelRows
        .filter((r) => r.id.trim() !== '')
        .map((r) => ({
          id: r.id.trim(),
          name: r.name.trim() || r.id.trim(),
          contextWindow: Number(r.contextWindow) || 0,
          maxTokens: Number(r.maxTokens) || 0,
          reasoning: r.reasoning,
        })),
      headers: Object.keys(headers).length ? headers : undefined,
    };
    const addRes = await providers.customAdd(input);
    if (!addRes.ok) {
      setSubmitting(false);
      setSubmitError(addRes.message ?? t('providers.custom.addFailed'));
      return;
    }
    const connectRes = await providers.connect(idTrim, apiKey.trim());
    if (!connectRes.ok) {
      setSubmitting(false);
      setSubmitError(connectRes.message ?? t('providers.connect.failedFallback'));
      return;
    }
    setSubmitting(false);
    onDone(idTrim);
  }

  return (
    <div className="pc-custom">
      <header className="pc-content-head">
        <button type="button" className="pc-link" onClick={onCancel}>
          ← {t('providers.connect.backToList')}
        </button>
        <h1>{t('providers.custom.title')}</h1>
      </header>

      <div className="pc-custom-body">
        <section className="pc-card">
          <p className="pc-card-title">{t('providers.custom.basicInfo')}</p>
          <label className="pc-field">
            <span>{t('providers.custom.providerIdField')}</span>
            <input
              className="pc-input"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder={t('providers.custom.idPlaceholder')}
              aria-describedby="pc-id-help"
            />
          </label>
          {idTouched && !idValid && (
            <p className="pc-error-text" role="alert">
              {idCollision ? t('providers.custom.idCollision') : t('providers.custom.idPattern')}
            </p>
          )}
          <label className="pc-field">
            <span>{t('providers.custom.nameField')}</span>
            <input className="pc-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="pc-field">
            <span>{t('providers.custom.baseUrlField')}</span>
            <input
              className="pc-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="pc-field">
            <span>{t('providers.custom.apiTypeField')}</span>
            <select className="pc-select" value={api} onChange={(e) => setApi(e.target.value)}>
              {API_TYPES.map((apiType) => (
                <option key={apiType} value={apiType}>
                  {apiType}
                </option>
              ))}
            </select>
          </label>
          <label className="pc-field">
            <span>{t('providers.connect.apiKeyTitle')}</span>
            <input
              type="password"
              className="pc-input"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </label>
        </section>

        <section className="pc-card">
          <div className="pc-card-head">
            <p className="pc-card-title">{t('providers.models.heading')}</p>
            <button type="button" className="pc-link" onClick={addModel}>
              {t('providers.custom.addModel')}
            </button>
          </div>
          {modelRows.map((row, idx) => (
            <div className="pc-model-form-row" key={idx}>
              <input
                className="pc-input"
                placeholder={t('providers.custom.modelIdPlaceholder')}
                value={row.id}
                onChange={(e) => updateModel(idx, { id: e.target.value })}
              />
              <input
                className="pc-input"
                placeholder={t('providers.custom.namePlaceholder')}
                value={row.name}
                onChange={(e) => updateModel(idx, { name: e.target.value })}
              />
              <input
                className="pc-input pc-input-num"
                placeholder={t('providers.custom.contextWindow')}
                type="number"
                value={row.contextWindow}
                onChange={(e) => updateModel(idx, { contextWindow: Number(e.target.value) })}
              />
              <input
                className="pc-input pc-input-num"
                placeholder={t('providers.custom.maxTokens')}
                type="number"
                value={row.maxTokens}
                onChange={(e) => updateModel(idx, { maxTokens: Number(e.target.value) })}
              />
              <label className="pc-inline-check">
                <input
                  type="checkbox"
                  checked={row.reasoning}
                  onChange={(e) => updateModel(idx, { reasoning: e.target.checked })}
                />
                {t('providers.models.reasoning')}
              </label>
              {modelRows.length > 1 && (
                <button
                  type="button"
                  className="pc-link pc-link-danger"
                  onClick={() => removeModel(idx)}
                >
                  {t('providers.custom.remove')}
                </button>
              )}
            </div>
          ))}
        </section>

        <section className="pc-card">
          <div className="pc-card-head">
            <p className="pc-card-title">{t('providers.custom.headersTitle')}</p>
            <button type="button" className="pc-link" onClick={addHeader}>
              {t('providers.custom.addHeader')}
            </button>
          </div>
          {headerRows.length === 0 ? (
            <p className="pc-muted">{t('providers.custom.headersEmpty')}</p>
          ) : (
            headerRows.map((row, idx) => (
              <div className="pc-header-form-row" key={idx}>
                <input
                  className="pc-input"
                  placeholder={t('providers.custom.headerNamePlaceholder')}
                  value={row.key}
                  onChange={(e) => updateHeader(idx, { key: e.target.value })}
                />
                <input
                  className="pc-input"
                  placeholder={t('providers.custom.headerValuePlaceholder')}
                  value={row.value}
                  onChange={(e) => updateHeader(idx, { value: e.target.value })}
                />
                <button
                  type="button"
                  className="pc-link pc-link-danger"
                  onClick={() => removeHeader(idx)}
                >
                  {t('providers.custom.remove')}
                </button>
              </div>
            ))
          )}
        </section>

        {submitError && (
          <p className="pc-error-text" role="alert">
            {submitError}
          </p>
        )}
      </div>

      <footer className="pc-connect-foot">
        <button type="button" className="pc-btn" onClick={onCancel} disabled={submitting}>
          {t('providers.custom.cancel')}
        </button>
        <button
          type="button"
          className="pc-btn pc-btn-primary"
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {submitting ? t('providers.custom.submitting') : t('providers.custom.saveAndConnect')}
        </button>
      </footer>
    </div>
  );
}
