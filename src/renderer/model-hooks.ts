import { useCallback, useEffect, useState } from 'react';
import type { SerializedResult } from '../shared/result';

function unwrap<T>(res: SerializedResult<T>, fallback: T): T {
  return res.ok ? res.value : fallback;
}

function errOf<T>(res: SerializedResult<T>): string {
  return !res.ok ? res.error.message || res.error.code : '';
}

export interface ProvidersState {
  catalog: ProviderDto[];
  connected: ConnectedProviderDto[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  connect: (providerId: string, material?: string) => Promise<{ ok: boolean; message?: string }>;
  disconnect: (providerId: string) => Promise<{ ok: boolean; message?: string }>;
  testConnection: (providerId: string) => Promise<{ ok: boolean; message?: string }>;
  customAdd: (input: CustomProviderInput) => Promise<{ ok: boolean; message?: string }>;
  customRemove: (providerId: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Encapsulates all `window.lorra.providers.*` reads + mutations for the
 * providers config page. Config page and chat area do NOT share state (D6);
 * chat area uses `useChatModelState` instead.
 */
export function useProviders(): ProvidersState {
  const [catalog, setCatalog] = useState<ProviderDto[]>([]);
  const [connected, setConnected] = useState<ConnectedProviderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cat, con] = await Promise.all([
        window.lorra.providers.catalog(),
        window.lorra.providers.list(),
      ]);
      if (!cat.ok) {
        setError(errOf(cat));
        return;
      }
      if (!con.ok) {
        setError(errOf(con));
        return;
      }
      setCatalog(cat.value);
      setConnected(con.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    async (providerId: string, material?: string) => {
      const res = await window.lorra.providers.connect({ providerId, material });
      if (!res.ok) return { ok: false, message: errOf(res) };
      await refresh();
      return { ok: true };
    },
    [refresh],
  );

  const disconnect = useCallback(
    async (providerId: string) => {
      const res = await window.lorra.providers.disconnect({ providerId });
      if (!res.ok) return { ok: false, message: errOf(res) };
      await refresh();
      return { ok: true };
    },
    [refresh],
  );

  const testConnection = useCallback(async (providerId: string) => {
    const res = await window.lorra.providers.testConnection({ providerId });
    return res.ok ? { ok: true } : { ok: false, message: errOf(res) };
  }, []);

  const customAdd = useCallback(
    async (input: CustomProviderInput) => {
      const res = await window.lorra.providers.custom.add(input);
      if (!res.ok) return { ok: false, message: errOf(res) };
      await refresh();
      return { ok: true };
    },
    [refresh],
  );

  const customRemove = useCallback(
    async (providerId: string) => {
      const res = await window.lorra.providers.custom.remove({ providerId });
      if (!res.ok) return { ok: false, message: errOf(res) };
      await refresh();
      return { ok: true };
    },
    [refresh],
  );

  return {
    catalog,
    connected,
    loading,
    error,
    refresh,
    connect,
    disconnect,
    testConnection,
    customAdd,
    customRemove,
  };
}

export interface ModelsState {
  models: ModelDto[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  toggle: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<{ ok: boolean; message?: string }>;
  setDefault: (providerId: string, modelId: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Loads models for a provider (or all when providerId is undefined). Mutations
 * reload the list so the UI reflects the persisted SDK state immediately.
 */
export function useModels(providerId: string | undefined): ModelsState {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (providerId === undefined) {
      setModels([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await window.lorra.models.list({ providerId });
      setModels(unwrap(res, []));
      if (!res.ok) setError(errOf(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = useCallback(
    async (pId: string, modelId: string, enabled: boolean) => {
      const res = await window.lorra.models.toggle({ providerId: pId, modelId, enabled });
      if (!res.ok) return { ok: false, message: errOf(res) };
      await reload();
      return { ok: true };
    },
    [reload],
  );

  const setDefault = useCallback(
    async (pId: string, modelId: string) => {
      const res = await window.lorra.models.setDefault({ providerId: pId, modelId });
      if (!res.ok) return { ok: false, message: errOf(res) };
      await reload();
      return { ok: true };
    },
    [reload],
  );

  return { models, loading, error, reload, toggle, setDefault };
}

export interface ChatModelState {
  modelAvailable: boolean;
  defaultModelName: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Chat-area-only hook (D6): reads `models.getAvailable` + `models.getDefault`
 * independently of the config page. `modelAvailable` = getAvailable non-empty.
 */
export function useChatModelState(): ChatModelState {
  const [modelAvailable, setModelAvailable] = useState(false);
  const [defaultModelName, setDefaultModelName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [avail, def] = await Promise.all([
        window.lorra.models.getAvailable(),
        window.lorra.models.getDefault(),
      ]);
      const availableModels = avail.ok ? avail.value : [];
      setModelAvailable(availableModels.length > 0);
      if (def.ok && def.value) {
        const match = availableModels.find((m) => m.id === def.value?.modelId);
        setDefaultModelName(match?.name ?? def.value.modelId);
      } else {
        setDefaultModelName(null);
      }
    } catch {
      setModelAvailable(false);
      setDefaultModelName(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { modelAvailable, defaultModelName, loading, refresh };
}

/** Loads the default model + all available models for the default-model selector. */
export function useDefaultModelSelector() {
  const [available, setAvailable] = useState<ModelDto[]>([]);
  const [current, setCurrent] = useState<{ providerId: string; modelId: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [avail, def] = await Promise.all([
        window.lorra.models.getAvailable(),
        window.lorra.models.getDefault(),
      ]);
      setAvailable(avail.ok ? avail.value : []);
      setCurrent(def.ok ? def.value : null);
    } catch {
      setAvailable([]);
      setCurrent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setDefault = useCallback(
    async (providerId: string, modelId: string) => {
      const res = await window.lorra.models.setDefault({ providerId, modelId });
      if (res.ok) await refresh();
      return res.ok;
    },
    [refresh],
  );

  return { available, current, loading, setDefault, refresh };
}
