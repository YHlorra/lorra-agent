/**
 * Black-box component tests for ProvidersPage (Phases 4-6 of the model-provider
 * config change). These tests verify observable UI behavior against the spec
 * contracts in The UI implementation is NOT modified.
 */
import fc from 'fast-check';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProvidersPage } from '../../src/renderer/providers-page';
import { useAppStore } from '@/lib/app-store';
import type { LorraResult } from '../../src/shared/result';
import {
  ANTHROPIC_CONNECTED,
  OAUTH_ONLY,
  POPULAR_CATALOG,
  collectKeys,
  getFieldInput,
  installLorraMock,
  makeLorraMock,
  makeProviderDto,
  providerNamesInDom,
} from './lorra-test-helpers';

beforeEach(() => {
  installLorraMock();
});

afterEach(() => {
  cleanup();
});

/** Wait for catalog then click "连接" on the named provider's row. */
async function clickProviderConnect(user: UserEvent, name: string): Promise<void> {
  await screen.findByText(name);
  await waitFor(() => {
    const rows = Array.from(document.querySelectorAll('.pc-provider-list > li'));
    expect(rows.find((li) => li.querySelector('.pc-provider-name')?.textContent?.trim() === name)).toBeDefined();
  });
  const target = Array.from(document.querySelectorAll('.pc-provider-list > li')).find(
    (li) => li.querySelector('.pc-provider-name')?.textContent?.trim() === name,
  ) as HTMLElement;
  const btn = within(target).getByRole('button', { name: '连接' });
  await user.click(btn);
  await screen.findByRole('heading', { name });
}

// =========================================================================
// 4.4 — Provider catalog list
// =========================================================================

describe('4.4 供应商目录列表', () => {
  it('catalog 含 popular+all 时渲染两组标题、各供应商名称与 modelCount', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        ...POPULAR_CATALOG,
        makeProviderDto({ id: 'mistral', name: 'Mistral', group: 'all', modelCount: 1 }),
        makeProviderDto({ id: 'bedrock', name: 'Bedrock', group: 'all', modelCount: 7 }),
      ] },
    );
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    render(<ProvidersPage onBack={() => {}} />);

    expect(await screen.findByRole('heading', { name: '常用' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '全部' })).toBeInTheDocument();

    for (const p of [...POPULAR_CATALOG, { id: 'mistral', name: 'Mistral' }, { id: 'bedrock', name: 'Bedrock' }]) {
      expect(screen.getByText(p.name)).toBeInTheDocument();
    }

    expect(screen.getByText('4 个模型')).toBeInTheDocument(); // Anthropic
    expect(screen.getByText('6 个模型')).toBeInTheDocument(); // OpenAI
    expect(screen.getByText('7 个模型')).toBeInTheDocument(); // Bedrock
  });

  it('搜索过滤 fast-check: 可见集 ⊆ 全集；每项 name/id 包含 query；空 query 显示全集', async () => {
    const catalog: ProviderDto[] = [
      makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 4 }),
      makeProviderDto({ id: 'openai', name: 'OpenAI', group: 'popular', modelCount: 6 }),
      makeProviderDto({ id: 'deepseek', name: 'DeepSeek', group: 'popular', modelCount: 2 }),
      makeProviderDto({ id: 'mistral', name: 'Mistral', group: 'all', modelCount: 1 }),
      makeProviderDto({ id: 'bedrock', name: 'Bedrock', group: 'all', modelCount: 7 }),
    ];
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue({ ok: true, value: catalog });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const fullNames = catalog.map((p) => p.name);
    const user = userEvent.setup();
    const { container } = render(<ProvidersPage onBack={() => {}} />);

    await screen.findByText('Anthropic');
    const search = within(container).getByRole('searchbox', { name: '搜索供应商' });

    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 12 }), async (query) => {
        // fireEvent.change avoids user.type's keyboard parser interpretation
        // of '{', '}', '[', etc., which would otherwise throw.
        fireEvent.change(search, { target: { value: query } });

        // The UI trims the query before filtering; a whitespace-only query
        // behaves like an empty query and shows the full catalog.
        const q = query.trim().toLowerCase();

        await waitFor(() => {
          const names = providerNamesInDom(container);
          if (q.length === 0) {
            expect(names.sort()).toEqual([...fullNames].sort());
          } else {
            for (const name of names) {
              const p = catalog.find((c) => c.name === name);
              expect(p).toBeDefined();
              const matches =
                p!.name.toLowerCase().includes(q) || p!.id.toLowerCase().includes(q);
              expect(matches).toBe(true);
            }
            // Subset invariant: every visible name must be a known provider.
            for (const name of names) {
              expect(fullNames).toContain(name);
            }
          }
        }, { timeout: 500 });
      }),
      { numRuns: 20 },
    );
  });

  it('oauth-only 行被置底（DOM 顺序排在 available 之后）并标为不可点击', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 4 }),
        makeProviderDto({ id: 'openai', name: 'OpenAI', group: 'popular', modelCount: 6 }),
        OAUTH_ONLY,
      ] },
    );
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const { container } = render(<ProvidersPage onBack={() => {}} />);
    await screen.findByText('Google');

    const order = providerNamesInDom(container);
    const googleIdx = order.indexOf('Google');
    const anthropicIdx = order.indexOf('Anthropic');
    const openaiIdx = order.indexOf('OpenAI');
    expect(googleIdx).toBeGreaterThan(anthropicIdx);
    expect(googleIdx).toBeGreaterThan(openaiIdx);

    const googleRow = Array.from(container.querySelectorAll('.pc-provider-list > li')).find(
      (li) => li.querySelector('.pc-provider-name')?.textContent?.trim() === 'Google',
    ) as HTMLElement | undefined;
    expect(googleRow).toBeDefined();
    expect(googleRow!.querySelector('.pc-provider-row.is-disabled')).not.toBeNull();

    // The "连接" affordance is replaced by a non-button tag.
    expect(googleRow!.querySelector('.pc-tag-muted')?.textContent).toMatch(/仅 OAuth/);
    expect(googleRow!.querySelector('button.pc-link')).toBeNull();
  });

  it('断开连接 affordance: 已连接行点开后详情页出现「断开连接」按钮，点之直接调 disconnect，无确认弹窗，列表重新拉取', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 4 }),
      ] },
    );
    m.providers.list
      .mockResolvedValueOnce({ ok: true, value: [ANTHROPIC_CONNECTED] })
      .mockResolvedValue({ ok: true, value: [] });
    m.providers.disconnect.mockResolvedValue({ ok: true, value: undefined });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = userEvent.setup();
    render(<ProvidersPage onBack={() => {}} />);

    const connectedRow = await screen.findByRole('button', { name: /Anthropic/ });
    expect(connectedRow).toBeInTheDocument();
    await user.click(connectedRow);

    await screen.findByRole('heading', { name: 'Anthropic' });
    expect(screen.getByText(/已连接 · API Key/)).toBeInTheDocument();

    // Spec Scenario "断开清空其拥有的默认": provider disconnects without
    // confirmation dialog, and the connected list refreshes. The spec
    // REQUIRES this affordance to exist in the UI — see test report.
    const confirmSpy = vi.spyOn(window, 'confirm');
    const disconnectBtn = screen.getByRole('button', { name: '断开连接' });
    await user.click(disconnectBtn);

    expect(m.providers.disconnect).toHaveBeenCalledWith({ providerId: 'anthropic' });
    expect(confirmSpy).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(m.providers.list.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(m.providers.catalog.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(screen.getByText('尚未连接供应商。')).toBeInTheDocument();
    });
  });
});

// =========================================================================
// 5.4 — Connect flow
// =========================================================================

describe('5.4 连接流程', () => {
  /** Open ConnectView for an already-connected provider via the rail row. */
  async function openConnectedDetail(providerName: string): Promise<UserEvent> {
    const m = (window as unknown as { lorra: ReturnType<typeof makeLorraMock> }).lorra;
    const user = userEvent.setup();
    render(<ProvidersPage onBack={() => {}} />);
    const row = await screen.findByRole('button', { name: new RegExp(providerName) });
    await user.click(row);
    await screen.findByRole('heading', { name: providerName });
    await screen.findByText(/已连接 · API Key/);
    void m;
    return user;
  }

  it('testConnection 成功: 先出现「测试连接中…」随后「连接成功」', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 4 }),
      ] },
    );
    m.providers.list.mockResolvedValue({ ok: true, value: [ANTHROPIC_CONNECTED] });
    let resolveTest!: (v: LorraResult<void>) => void;
    m.providers.testConnection.mockImplementation(
      () => new Promise((resolve) => { resolveTest = resolve; }),
    );
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = await openConnectedDetail('Anthropic');
    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await user.click(testBtn);

    // Loading text visible before resolution.
    expect(await screen.findByRole('button', { name: '测试连接中…' })).toBeInTheDocument();

    resolveTest({ ok: true, value: undefined });

    expect(await screen.findByText('连接成功')).toBeInTheDocument();
  });

  it('testConnection 失败: 出现「连接失败」+ message；按钮仍可再点（重试 affordance）', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 4 }),
      ] },
    );
    m.providers.list.mockResolvedValue({ ok: true, value: [ANTHROPIC_CONNECTED] });
    m.providers.testConnection.mockResolvedValue(
      { ok: false, error: { code: 'test-failed', message: 'bad key xyz' } },
    );
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = await openConnectedDetail('Anthropic');
    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await user.click(testBtn);

    expect(await screen.findByText(/连接失败：bad key xyz/)).toBeInTheDocument();

    const testBtnAgain = screen.getByRole('button', { name: '测试连接' });
    expect(testBtnAgain).toBeEnabled();

    await user.click(testBtnAgain);
    expect(m.providers.testConnection).toHaveBeenCalledTimes(2);
  });

  it('已连接详情预填态输入新 key 点「重新连接」: connect 被调且第二参=新 key', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 4 }),
      ] },
    );
    m.providers.list.mockResolvedValue({ ok: true, value: [ANTHROPIC_CONNECTED] });
    m.providers.connect.mockResolvedValue({ ok: true, value: undefined });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = await openConnectedDetail('Anthropic');

    const apiKeyInput = screen.getByLabelText('API Key');
    await user.clear(apiKeyInput);
    await user.type(apiKeyInput, 'sk-replacement-xyz');

    const reconnectBtn = await screen.findByRole('button', { name: '重新连接' });
    await user.click(reconnectBtn);

    await waitFor(() => {
      expect(m.providers.connect).toHaveBeenCalledWith({
        providerId: 'anthropic',
        material: 'sk-replacement-xyz',
      });
    });
  });

  it('D9 星标联动: 启用两个模型但不点★ → 完成时 setDefault 首个启用模型', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 2 }),
      ] },
    );
    m.providers.list.mockResolvedValue({ ok: true, value: [ANTHROPIC_CONNECTED] });
    m.models.list.mockResolvedValue(
      { ok: true, value: [
        { id: 'claude-x', name: 'Claude X', provider: 'anthropic', contextWindow: 8192, maxTokens: 1024, reasoning: false, enabled: true, default: false, available: true },
        { id: 'claude-y', name: 'Claude Y', provider: 'anthropic', contextWindow: 8192, maxTokens: 1024, reasoning: false, enabled: true, default: false, available: true },
      ] },
    );
    m.models.getDefault.mockResolvedValue({ ok: true, value: null });
    m.models.setDefault.mockResolvedValue({ ok: true, value: undefined });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = await openConnectedDetail('Anthropic');
    await screen.findByText('Claude X');
    expect(screen.getByText('Claude Y')).toBeInTheDocument();

    const finishBtn = screen.getByRole('button', { name: '完成' });
    await user.click(finishBtn);

    await waitFor(() => {
      expect(m.models.setDefault).toHaveBeenCalledWith({
        providerId: 'anthropic',
        modelId: 'claude-x',
      });
    });
  });

  it('D9 星标联动: 启用两个并★第二个 → 完成时 setDefault 第二个', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 2 }),
      ] },
    );
    m.providers.list.mockResolvedValue({ ok: true, value: [ANTHROPIC_CONNECTED] });
    m.models.list.mockResolvedValue(
      { ok: true, value: [
        { id: 'claude-x', name: 'Claude X', provider: 'anthropic', contextWindow: 8192, maxTokens: 1024, reasoning: false, enabled: true, default: false, available: true },
        { id: 'claude-y', name: 'Claude Y', provider: 'anthropic', contextWindow: 8192, maxTokens: 1024, reasoning: false, enabled: true, default: false, available: true },
      ] },
    );
    m.models.getDefault.mockResolvedValue({ ok: true, value: null });
    m.models.setDefault.mockResolvedValue({ ok: true, value: undefined });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = await openConnectedDetail('Anthropic');
    await screen.findByText('Claude X');

    const yRow = screen.getByText('Claude Y').closest('.pc-model-row') as HTMLElement;
    const yStar = within(yRow).getByRole('button', { name: '设为默认' });
    await user.click(yStar);

    const finishBtn = screen.getByRole('button', { name: '完成' });
    await user.click(finishBtn);

    await waitFor(() => {
      expect(m.models.setDefault).toHaveBeenCalledWith({
        providerId: 'anthropic',
        modelId: 'claude-y',
      });
    });
  });

  it('目录加载失败: 出现错误文案 + 「重试」按钮，点重试 catalog 再次被调', async () => {
    const m = makeLorraMock();
    m.providers.catalog
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(
        { ok: true, value: [
          makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 1 }),
        ] },
      );
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const user = userEvent.setup();
    render(<ProvidersPage onBack={() => {}} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/目录加载失败/);
    expect(alert.textContent).toMatch(/boom/);

    const retryBtn = screen.getByRole('button', { name: '重试' });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(m.providers.catalog).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('Anthropic')).toBeInTheDocument();
  });
});

// =========================================================================
// 6.3 — Custom provider form
// =========================================================================

describe('6.3 自定义供应商表单', () => {
  async function openCustomForm(): Promise<{ form: HTMLElement; user: UserEvent }> {
    const user = userEvent.setup();
    render(<ProvidersPage onBack={() => {}} />);
    const entry = await screen.findByRole('button', { name: '+ 自定义供应商' });
    await user.click(entry);
    await screen.findByRole('heading', { name: '自定义供应商' });
    const form = document.querySelector('.pc-custom') as HTMLElement;
    return { form, user };
  }

  async function fillCustomForm(
    form: HTMLElement,
    fields: { id?: string; name?: string; baseUrl?: string; apiKey?: string },
    user: UserEvent,
  ): Promise<void> {
    if (fields.id !== undefined) {
      const input = getFieldInput(form, '提供商 ID') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, fields.id);
    }
    if (fields.name !== undefined) {
      const input = getFieldInput(form, '显示名称') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, fields.name);
    }
    if (fields.baseUrl !== undefined) {
      const input = getFieldInput(form, '基础 URL') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, fields.baseUrl);
    }
    if (fields.apiKey !== undefined) {
      const input = getFieldInput(form, 'API Key') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, fields.apiKey);
    }
  }

  it('ID 撞内置 anthropic: 出现冲突红字 + 提交按钮禁用，custom.add 不被调', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue(
      { ok: true, value: [
        makeProviderDto({ id: 'anthropic', name: 'Anthropic', group: 'popular', modelCount: 1 }),
      ] },
    );
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const { form, user } = await openCustomForm();
    await fillCustomForm(
      form,
      {
        id: 'anthropic',
        name: 'Fake Anthropic',
        baseUrl: 'https://example.com',
        apiKey: 'sk-whatever',
      },
      user,
    );

    expect(await screen.findByText(/该 ID 与内置供应商冲突/)).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: '保存并连接' });
    expect(submit).toBeDisabled();

    await user.click(submit);
    expect(m.providers.custom.add).not.toHaveBeenCalled();
  });

  it('ID 字符集 fast-check: 非法字符报错；合法字符不报字符集错', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const idPattern = /^[a-z0-9][a-z0-9-]*$/;
    const validArb = fc.stringMatching(idPattern);
    const invalidArb = fc
      .string({ minLength: 1, maxLength: 12 })
      .filter((s) => !idPattern.test(s));

    const { form, user } = await openCustomForm();
    const idInput = getFieldInput(form, '提供商 ID') as HTMLInputElement;

    await fc.assert(
      fc.asyncProperty(fc.oneof(validArb, invalidArb), async (id) => {
        // fireEvent.change avoids user.type's keyboard parser interpretation
        // of '{', '}', etc., and is also faster than typing char-by-char.
        fireEvent.change(idInput, { target: { value: id } });

        await waitFor(() => {
          const charsetError = screen.queryByText(/ID 须以小写字母或数字开头/);
          const collisionError = screen.queryByText(/该 ID 与内置供应商冲突/);
          const expectedError = !idPattern.test(id);
          expect(!!charsetError).toBe(expectedError);
          expect(collisionError).toBeNull();
        }, { timeout: 2000 });
      }),
      { numRuns: 20 },
    );

    expect(m.providers.custom.add).not.toHaveBeenCalled();
  });

  it('URL 格式 fast-check: 合法 https URL 不因 URL 被拦；非法串应被表单拒绝', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.providers.custom.add.mockResolvedValue({ ok: true, value: undefined });
    m.providers.connect.mockResolvedValue({ ok: true, value: undefined });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    // fireEvent.change is used to set the input value so fast-check can supply
    // arbitrary strings (including '{', '}', etc.) without user.type's keyboard
    // parser interpretation getting in the way.
    const isValidUrl = (s: string): boolean => /^https:\/\/[^\s]+$/i.test(s);
    const validUrlArb = fc
      .tuple(
        fc.stringMatching(/^[a-z0-9-]{1,8}$/),
        fc.stringMatching(/^[a-z]{1,8}$/),
      )
      .map(([host, tld]) => `https://${host}.${tld}/v1`);
    const invalidUrlArb = fc
      .string({ minLength: 1, maxLength: 16 })
      .filter((s) => !isValidUrl(`https://${s}`) && !isValidUrl(s) && s.trim() !== '');

    const { form, user } = await openCustomForm();
    await fillCustomForm(form, { id: 'acme', name: 'Acme', apiKey: 'sk-key' }, user);
    const urlInput = getFieldInput(form, '基础 URL') as HTMLInputElement;

    // First clear via user so React state stays consistent.
    await user.clear(urlInput);

    await fc.assert(
      fc.asyncProperty(fc.oneof(validUrlArb, invalidUrlArb), async (baseUrl) => {
        fireEvent.change(urlInput, { target: { value: baseUrl } });

        await waitFor(() => {
          const submit = screen.getByRole('button', { name: '保存并连接' });
          const urlOk = isValidUrl(baseUrl);
          if (urlOk) {
            expect(submit).toBeEnabled();
          } else {
            // Spec-implied property: non-URL strings block submission. The
            // current UI does not enforce URL format — see test report.
            expect(submit).toBeDisabled();
          }
        }, { timeout: 2000 });
      }),
      { numRuns: 8 },
    );
  });

  it('提交串行: 合法表单点「保存并连接」→ custom.add 先被调（不含 key）+ 然后 connect 被调', async () => {
    const SECRET = 'sk-shhh-secret-value-DO-NOT-LEAK';
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.providers.custom.add.mockResolvedValue({ ok: true, value: undefined });
    m.providers.connect.mockResolvedValue({ ok: true, value: undefined });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const { form, user } = await openCustomForm();
    await fillCustomForm(
      form,
      {
        id: 'acme',
        name: 'Acme',
        baseUrl: 'https://api.acme.test/v1',
        apiKey: SECRET,
      },
      user,
    );

    const submit = screen.getByRole('button', { name: '保存并连接' });
    await user.click(submit);

    await waitFor(() => {
      expect(m.providers.custom.add).toHaveBeenCalled();
    });

    // Credential-zero-transit: input object must not contain the API key
    // value (nor any credential-named field).
    const addArg = m.providers.custom.add.mock.calls[0]?.[0] as Record<string, unknown>;
    const serialized = JSON.stringify(addArg);
    expect(serialized).not.toContain(SECRET);
    const CREDENTIAL_KEY =
      /^(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|bearer[_-]?token|api[_-]?token|token|secret|password|authorization)$/i;
    expect(collectKeys(addArg).some((k) => CREDENTIAL_KEY.test(k))).toBe(false);

    await waitFor(() => {
      expect(m.providers.connect).toHaveBeenCalledWith({
        providerId: 'acme',
        material: SECRET,
      });
    });
  });

  it('custom.add reject → connect 不被调且显示错误', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.providers.custom.add.mockResolvedValue(
      { ok: false, error: { code: 'write-failed', message: '磁盘满，写不进去' } },
    );
    m.providers.connect.mockResolvedValue({ ok: true, value: undefined });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });

    const { form, user } = await openCustomForm();
    await fillCustomForm(
      form,
      {
        id: 'acme',
        name: 'Acme',
        baseUrl: 'https://api.acme.test/v1',
        apiKey: 'sk-x',
      },
      user,
    );

    const submit = screen.getByRole('button', { name: '保存并连接' });
    await user.click(submit);

    expect(await screen.findByText(/磁盘满/)).toBeInTheDocument();
    expect(m.providers.connect).not.toHaveBeenCalled();
  });
});
// =========================================================================
// — 语义清洗模型选择器(compileModel)
// =========================================================================

describe('语义清洗模型选择器（）', () => {
  beforeEach(() => {
    useAppStore.setState({ compileModel: null });
  });

  /** 渲染带 available 模型的 ProvidersPage 并等 compile 选择器就绪。 */
  async function renderWithModels(m: ReturnType<typeof makeLorraMock>): Promise<void> {
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.models.getAvailable.mockResolvedValue({
      ok: true,
      value: [
        { id: 'claude-x', name: 'Claude X', provider: 'anthropic', contextWindow: 8192, maxTokens: 1024, reasoning: false, enabled: true, default: false, available: true },
        { id: 'qwen2.5', name: 'Qwen 2.5', provider: 'ollama', contextWindow: 8192, maxTokens: 1024, reasoning: false, enabled: true, default: false, available: true },
      ],
    });
    m.models.getDefault.mockResolvedValue({ ok: true, value: null });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });
    render(<ProvidersPage onBack={() => {}} />);
    await screen.findByTestId('compile-model-select');
  }

  it('选项 = 跟随默认 + available 列表;默认选中「跟随默认」', async () => {
    const m = makeLorraMock();
    await renderWithModels(m);
    const sel = screen.getByTestId('compile-model-select') as HTMLSelectElement;
    expect(sel.value).toBe('');
    const labels = Array.from(sel.options).map((o) => o.textContent);
    expect(labels[0]).toContain('跟随默认');
    expect(labels).toContain('Claude X');
    expect(labels).toContain('Qwen 2.5');
  });

  it('选择模型 → settings.set 收到 { compileModel: {providerId, modelId} },store 同步', async () => {
    const m = makeLorraMock();
    await renderWithModels(m);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('compile-model-select'), 'ollama::qwen2.5');

    await waitFor(() => {
      expect(m.settings.set).toHaveBeenCalledWith({
        compileModel: { providerId: 'ollama', modelId: 'qwen2.5' },
      });
    });
    expect(useAppStore.getState().compileModel).toEqual({
      providerId: 'ollama',
      modelId: 'qwen2.5',
    });
  });

  it('选回「跟随默认」→ settings.set 收到 compileModel: null(清除)', async () => {
    const m = makeLorraMock();
    await renderWithModels(m);
    useAppStore.setState({ compileModel: { providerId: 'ollama', modelId: 'qwen2.5' } });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('compile-model-select'), '');

    await waitFor(() => {
      expect(m.settings.set).toHaveBeenCalledWith({ compileModel: null });
    });
  });

  it('无可用模型 → 提示文案,不渲染选择器', async () => {
    const m = makeLorraMock();
    m.providers.catalog.mockResolvedValue({ ok: true, value: [] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    m.models.getAvailable.mockResolvedValue({ ok: true, value: [] });
    m.models.getDefault.mockResolvedValue({ ok: true, value: null });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });
    render(<ProvidersPage onBack={() => {}} />);
    await screen.findByText('暂无可用模型,先连接一个供应商。');
    expect(screen.queryByTestId('compile-model-select')).not.toBeInTheDocument();
  });
});
