/**
 * ModelCapsule(内联模型切换胶囊仓)行为测试:
 * - 按已配置供应商分组渲染全量可用模型 + 供应商显示名
 * - 最近使用(最多 3,localStorage)单独成组
 * - 搜索按模型名/供应商名过滤(cmkd keywords)
 * - 选中即 setDefault + pushRecent + onClose
 * - 当前模型高亮勾选
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelCapsule } from '../../src/renderer/model-capsule';
import { pushRecentModel } from '../../src/renderer/recent-models';
import { makeLorraMock } from './lorra-test-helpers';

const A_MODEL = {
  id: 'a1',
  name: 'Alpha 1',
  provider: 'prov-a',
  contextWindow: 8192,
  maxTokens: 1024,
  reasoning: false,
  enabled: true,
  default: false,
  available: true,
};
const B_MODEL = {
  id: 'b1',
  name: 'Bravo 1',
  provider: 'prov-b',
  contextWindow: 8192,
  maxTokens: 1024,
  reasoning: false,
  enabled: true,
  default: false,
  available: true,
};

function setup(onModelChanged?: (p: string, m: string) => Promise<void>) {
  const m = makeLorraMock();
  m.models.getAvailable.mockResolvedValue({ ok: true, value: [A_MODEL, B_MODEL] });
  m.providers.list.mockResolvedValue({
    ok: true,
    value: [
      { id: 'prov-a', name: 'Provider A', connectionMethod: 'apiKey', modelCount: 1 },
      { id: 'prov-b', name: 'Provider B', connectionMethod: 'apiKey', modelCount: 1 },
    ],
  });
  Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });
  const changed = onModelChanged ?? vi.fn(async () => {});
  const close = vi.fn();
  render(
    <ModelCapsule current={null} onModelChanged={changed} onClose={close} />,
  );
  return { changed, close };
}

afterEach(() => {
  cleanup();
});

describe('ModelCapsule 内联模型切换胶囊仓', () => {
  it('按已配置供应商分组渲染全量可用模型 + 供应商显示名', async () => {
    setup();
    // 分组依据 = cmdk group heading = 供应商显示名;无最近使用 → 不渲染「最近使用」组。
    await waitFor(() => expect(document.querySelectorAll('[cmdk-group-heading]')).toHaveLength(2));
    const headings = Array.from(document.querySelectorAll('[cmdk-group-heading]')).map(
      (n) => n.textContent,
    );
    expect(headings).toEqual(['Provider A', 'Provider B']);
    expect(screen.getByText('Alpha 1')).toBeInTheDocument();
    expect(screen.getByText('Bravo 1')).toBeInTheDocument();
    expect(screen.queryByText('最近使用')).toBeNull();
  });

  it('最近使用模型单独成组(过滤掉已不在可用清单的)', async () => {
    pushRecentModel({ providerId: 'prov-b', modelId: 'b1' });
    pushRecentModel({ providerId: 'prov-gone', modelId: 'ghost' });
    setup();
    expect(await screen.findByText('最近使用')).toBeInTheDocument();
    // 失效供应商的最近项被过滤,不出现。
    expect(screen.queryByText('ghost')).toBeNull();
  });

  it('当前模型高亮勾选', async () => {
    const m = makeLorraMock();
    m.models.getAvailable.mockResolvedValue({ ok: true, value: [A_MODEL, B_MODEL] });
    m.providers.list.mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });
    render(
      <ModelCapsule
        current={{ providerId: 'prov-a', modelId: 'a1' }}
        onModelChanged={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('Alpha 1')).toBeInTheDocument());
    const current = document.querySelector('.model-capsule-item-current');
    expect(current?.textContent).toContain('Alpha 1');
  });

  it('选中模型 → onModelChanged(providerId,modelId) + onClose', async () => {
    const { changed, close } = setup();
    await waitFor(() => expect(screen.getByText('Alpha 1')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByText('Alpha 1'));
    expect(changed).toHaveBeenCalledWith('prov-a', 'a1');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('搜索按模型名过滤:命中项保留,其余消失', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('Alpha 1')).toBeInTheDocument());
    const input = await screen.findByPlaceholderText('搜索模型…');
    await userEvent.setup().type(input, 'Bravo');
    await waitFor(() => expect(screen.getByText('Bravo 1')).toBeInTheDocument());
    expect(screen.queryByText('Alpha 1')).toBeNull();
  });
});