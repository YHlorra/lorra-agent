import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Mock electron at module level so model-ipc.ts and this test share the same
// ipcMain.handle spy (vitest module mock is a singleton).
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { ipcMain } from 'electron';
import { registerModelHandlers } from '../../src/main/ipc/model-ipc';
import { err, ok } from '../../src/shared/result';

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;

function registeredHandlers(): Map<string, Handler> {
  const map = new Map<string, Handler>();
  for (const [channel, fn] of (ipcMain.handle as Mock).mock.calls as [string, Handler][]) {
    map.set(channel, fn);
  }
  return map;
}

function makeAdapter() {
  return {
    catalog: vi.fn(),
    listConnected: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    customAdd: vi.fn(),
    customRemove: vi.fn(),
    listModels: vi.fn(),
    getDefault: vi.fn(),
    setDefault: vi.fn(),
    toggleModel: vi.fn(),
    getAvailable: vi.fn(),
  };
}

// Black-box runtime verification of the IPC boundary redact behaviour.
// The compile-time contract test (model-ipc.contract.test.ts) only proves the
// *types* carry no string credential fields; this file proves redactString
// actually scrubs credential material out of *runtime* messages.
describe('model-ipc redact (runtime)', () => {
  let adapter: ReturnType<typeof makeAdapter>;
  let call: (channel: string, payload?: unknown) => Promise<unknown>;

  beforeEach(() => {
    (ipcMain.handle as Mock).mockClear();
    adapter = makeAdapter();
    registerModelHandlers(adapter as never);
    const hs = registeredHandlers();
    call = (channel, payload) => (hs.get(channel) as Handler)({}, payload);
  });

  afterEach(() => vi.clearAllMocks());

  it('redacts sk- tokens in a failure Result message', async () => {
    adapter.connect.mockResolvedValue(
      err({ code: 'connect-failed', message: 'invalid sk-abc123 key' }),
    );
    const res = (await call('lorra.providers.connect', {
      providerId: 'anthropic',
      material: 'sk-abc123',
    })) as { status: string; error: { message: string } };
    expect(res.status).toBe('error');
    expect(res.error.message).toContain('sk-***');
    expect(res.error.message).not.toContain('sk-abc123');
  });

  it('redacts Bearer tokens in a thrown error message', async () => {
    adapter.connect.mockRejectedValue(new Error('auth Bearer eyJhbGci failed'));
    const res = (await call('lorra.providers.connect', {
      providerId: 'anthropic',
      material: 'x',
    })) as { status: string; error: { message: string } };
    expect(res.status).toBe('error');
    expect(res.error.message).toContain('Bearer ***');
    expect(res.error.message).not.toContain('eyJhbGci');
  });

  it('redacts key=value credential fragments (apiKey=...)', async () => {
    // Value deliberately has NO sk- prefix so only the key=value rule can scrub it.
    adapter.connect.mockResolvedValue(
      err({ code: 'x', message: 'rejected apiKey=INVALIDKEY123 please retry' }),
    );
    const res = (await call('lorra.providers.connect', {
      providerId: 'anthropic',
      material: 'x',
    })) as { status: string; error: { message: string } };
    expect(res.error.message).not.toContain('INVALIDKEY123');
    expect(res.error.message).toContain('apiKey=***');
  });

  it('redacts key: value credential fragments (token: ...)', async () => {
    adapter.disconnect.mockResolvedValue(
      err({ code: 'x', message: 'header token: mytoken123 expired' }),
    );
    const res = (await call('lorra.providers.disconnect', {
      providerId: 'anthropic',
    })) as { status: string; error: { message: string } };
    expect(res.error.message).not.toContain('mytoken123');
    expect(res.error.message).toContain('token: ***');
  });

  it('passes ok data through untouched (no data scanning)', async () => {
    const data = [
      {
        id: 'anthropic',
        name: 'A',
        group: 'popular',
        modelCount: 1,
        auth: { apiKey: true, oauth: false },
        available: true,
      },
    ];
    adapter.catalog.mockReturnValue(data);
    const res = (await call('lorra.providers.catalog')) as {
      status: string;
      value: unknown;
    };
    expect(res.status).toBe('ok');
    expect(res.value).toEqual(data);
  });

  it('redacts sk- in a caught exception message', async () => {
    adapter.customAdd.mockRejectedValue(new Error('boom sk-secret999'));
    const res = (await call('lorra.providers.custom.add', {
      id: 'acme',
      name: 'A',
      baseUrl: 'u',
      api: 'openai-completions',
      models: [],
    })) as { status: string; error: { message: string } };
    expect(res.status).toBe('error');
    expect(res.error.message).not.toContain('sk-secret999');
  });

  it('forwards only providerId + material to adapter.connect', async () => {
    adapter.connect.mockResolvedValue(ok());
    await call('lorra.providers.connect', {
      providerId: 'anthropic',
      material: 'sk-x',
      extra: 'leak',
    });
    expect(adapter.connect).toHaveBeenCalledWith('anthropic', 'sk-x');
  });
});
