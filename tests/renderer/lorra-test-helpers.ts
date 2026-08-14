// Shared mocks + fixtures for ProvidersPage / App renderer tests.
// Sets `window.lorra` to a fully-vi.fn-backed stub; each test seeds the
// individual methods it exercises. Tests do NOT rely on the default stub
// in src/renderer/test-setup.ts — we replace it here so every method is
// observable through vi.fn and no method ever throws "undefined".

import type { Mock } from 'vitest';
import { vi } from 'vitest';

export interface LorraMock {
  app: { info: Mock; licenses: Mock };
  window: { minimize: Mock; toggleMaximize: Mock; close: Mock };
  providers: {
    catalog: Mock;
    list: Mock;
    connect: Mock;
    disconnect: Mock;
    getAuthStatus: Mock;
    testConnection: Mock;
    custom: { add: Mock; remove: Mock };
  };
  models: {
    list: Mock;
    getDefault: Mock;
    setDefault: Mock;
    toggle: Mock;
    getAvailable: Mock;
  };
  workspace: { pick: Mock; switch: Mock; get: Mock; activate: Mock; list: Mock; remove: Mock };
  session: {
    list: Mock;
    open: Mock;
    continueRecent: Mock;
    create: Mock;
    send: Mock;
    abort: Mock;
    compact: Mock;
    respondApproval: Mock;
  };
  fs: { tree: Mock; open: Mock; search: Mock; pickFile: Mock };
  events: { subscribe: Mock };
  settings: { get: Mock; set: Mock };
  review: { generate: Mock };
  skills: {
    xray: Mock;
    setEnabled: Mock;
    cleanDangling: Mock;
    collect: Mock;
    checkUpdates: Mock;
    updateAll: Mock;
    setWsEnabled: Mock;
  };
}

export function makeLorraMock(): LorraMock {
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  const fail = (code: string, message: string) =>
    Promise.resolve({ ok: false as const, error: { code, message } });
  return {
    app: {
      info: vi.fn(() => Promise.resolve({ version: '0.0.0-test', name: 'lorra' })),
      licenses: vi.fn(() => Promise.resolve([])),
    },
    window: {
      minimize: vi.fn(() => Promise.resolve(true)),
      toggleMaximize: vi.fn(() => Promise.resolve(true)),
      close: vi.fn(() => Promise.resolve(true)),
    },
    providers: {
      catalog: vi.fn(() => ok([] as ProviderDto[])),
      list: vi.fn(() => ok([] as ConnectedProviderDto[])),
      connect: vi.fn(() => ok(undefined)),
      disconnect: vi.fn(() => ok(undefined)),
      getAuthStatus: vi.fn(() => ok({ configured: false })),
      testConnection: vi.fn(() => ok(undefined)),
      custom: {
        add: vi.fn(() => ok(undefined)),
        remove: vi.fn(() => ok(undefined)),
      },
    },
    models: {
      list: vi.fn(() => ok([] as ModelDto[])),
      getDefault: vi.fn(() => ok(null)),
      setDefault: vi.fn(() => ok(undefined)),
      toggle: vi.fn(() => ok(undefined)),
      getAvailable: vi.fn(() => ok([] as ModelDto[])),
    },
    workspace: {
      pick: vi.fn(() => Promise.resolve({ path: null })),
      switch: vi.fn(() => Promise.resolve({ path: null })),
      get: vi.fn(() => Promise.resolve({ path: '/test/workspace' })),
      activate: vi.fn((path: string) => Promise.resolve({ path })),
      list: vi.fn(() => Promise.resolve({ workspaces: ['/test/workspace'] })),
      remove: vi.fn(() => Promise.resolve({ workspaces: ['/test/workspace'] })),
    },
    session: {
      list: vi.fn(() => ok([])),
      open: vi.fn(() => ok({ sessionId: 'sess-test' })),
      continueRecent: vi.fn(() => ok({ sessionId: 'sess-test' })),
      create: vi.fn(() => ok({ sessionId: 'sess-test' })),
      send: vi.fn(() => ok({ accepted: true })),
      abort: vi.fn(() => ok(true)),
      compact: vi.fn(() => ok({ accepted: true })),
      respondApproval: vi.fn(() => ok(true)),
    },
    fs: {
      tree: vi.fn(() => ok([])),
      open: vi.fn(() => fail('not-implemented', 'no fs stub')),
      search: vi.fn(() => ok([])),
      pickFile: vi.fn(() => ok(null)),
    },
    events: {
      subscribe: vi.fn(() => () => {}),
    },
    settings: {
      get: vi.fn(() => ok({ showHiddenFiles: false, language: 'zh', defaultHideThinking: false })),
      set: vi.fn(() => ok(undefined)),
    },
    review: {
      generate: vi.fn(() => ok({ id: 'rev-test' })),
    },
    // 技能管理页(skill-manager V1):信封 = 生产 SerializedResult(与 preload
    // 直透同款 {status:'ok'}),页面测试据此判别;默认空 xray。
    skills: {
      xray: vi.fn(() =>
        Promise.resolve({
          status: 'ok' as const,
          value: {
            skills: [],
            stats: {},
            budget: {
              estimatedTokens: 0,
              goodLine: 2000,
              warnLine: 4000,
              status: 'good' as const,
              enabledCount: 0,
              charSum: 0,
            },
            dangling: [],
            gitStatus: {},
            collectionRoot: '/test/collection',
            workspacePath: '/test/workspace',
          },
        }),
      ),
      setEnabled: vi.fn(() => Promise.resolve({ status: 'ok' as const, value: undefined })),
      cleanDangling: vi.fn(() => Promise.resolve({ status: 'ok' as const, value: { cleaned: 0 } })),
      collect: vi.fn(() =>
        Promise.resolve({
          status: 'ok' as const,
          value: { moved: 0, linked: 0, conflicts: [], notes: [] },
        }),
      ),
      checkUpdates: vi.fn(() => Promise.resolve({ status: 'ok' as const, value: {} })),
      updateAll: vi.fn(() =>
        Promise.resolve({ status: 'ok' as const, value: { updated: [], skipped: [] } }),
      ),
      setWsEnabled: vi.fn(() => Promise.resolve({ status: 'ok' as const, value: undefined })),
    },
  };
}

export function installLorraMock(): LorraMock {
  const mock = makeLorraMock();
  Object.defineProperty(window, 'lorra', {
    value: mock,
    writable: true,
    configurable: true,
  });
  return mock;
}

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

export function makeProviderDto(
  over: Partial<ProviderDto> & { id: string; name: string },
): ProviderDto {
  return {
    group: 'all',
    modelCount: 1,
    auth: { apiKey: true, oauth: false },
    available: true,
    ...over,
  } as ProviderDto;
}

export const POPULAR_CATALOG: ProviderDto[] = [
  makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 4 }),
  makeProviderDto({ id: 'openai', name: 'OpenAI', group: 'popular', modelCount: 6 }),
  makeProviderDto({ id: 'deepseek', name: 'DeepSeek', group: 'popular', modelCount: 2 }),
];

export const OAUTH_ONLY: ProviderDto = makeProviderDto({
  id: 'google',
  name: 'Google',
  group: 'popular',
  modelCount: 3,
  auth: { apiKey: false, oauth: true },
  available: false,
  reason: 'oauth-only',
});

export const ANTHROPIC_CONNECTED: ConnectedProviderDto = {
  id: 'anthropic',
  name: 'Anthropic',
  connectionMethod: 'apiKey',
  modelCount: 4,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** Find an input/select whose sibling <span> label matches `labelText`. */
export function getFieldInput(
  container: HTMLElement,
  labelText: string,
): HTMLInputElement | HTMLSelectElement {
  const fields = Array.from(container.querySelectorAll('.pc-field'));
  for (const f of fields) {
    const span = f.querySelector(':scope > span');
    if (span?.textContent === labelText) {
      const input = f.querySelector('input, select, textarea');
      if (input) return input as HTMLInputElement | HTMLSelectElement;
      throw new Error(`Field "${labelText}" has no input child`);
    }
  }
  throw new Error(`No field with label "${labelText}"`);
}

/** Provider-row names in DOM document order across all groups. */
export function providerNamesInDom(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.pc-provider-name')).map((el) =>
    (el.textContent ?? '').trim(),
  );
}

/** Recursively collect keys for credential-field detector. */
export function collectKeys(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.flatMap((v) => collectKeys(v));
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => [k, ...collectKeys(v)]);
}
