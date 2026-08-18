/**
 * MemoryPage 黑盒测试(2026-08-10 方向 B 工作台重构,TDD)。
 *
 * 规范真源:
 * - :三栏知识树工作台 —— 左树(八类分组 + 归档折叠 + 最近变更
 * 审计折叠)/ 中流(搜索 + active 条目,分隔线列表)/ 右页(文档 + 标签 +
 * 关系面板 + 编辑/撤销);来源徽标移除,证据徽标保留;kind 可编辑。
 * - 用户三问题:无法编辑(编辑 dialog kind 可改)/ 查看不便(三栏 + 结构化 +
 * 关系面板)/ 已撤销仍显示(中栏只渲染 active,归档折叠进左栏灰态行)。
 * - src/shared/memory-schema.ts(八类/证据标签/MemoryEntry/MemoryEvent)。
 *
 * mock 形状 = preload bridge 产出:window.lorra.memory.* 返回 SerializedResult
 * ({ok,value}/{ok,error}),与 src/preload.ts memory bridge 类型同源。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { MemoryPage } from '../../src/renderer/memory-page';
import type { MemoryEntry, MemoryEvent } from '../../src/shared/memory-schema';
import type { LorraError, SerializedResult } from '../../src/shared/result';
import { installLorraMock, type LorraMock } from './lorra-test-helpers';

// ---------------------------------------------------------------------------
// 造数(与 src/shared/memory-schema.ts MemoryEntry/MemoryEvent 同形)
// ---------------------------------------------------------------------------

let entrySeq = 0;
let eventSeq = 0;

export function makeMemoryEntry(
  over: Partial<MemoryEntry> & { content: string },
): MemoryEntry {
  entrySeq += 1;
  const base: MemoryEntry = {
    entryId: `entry-${String(entrySeq).padStart(3, '0')}`,
    schemaVersion: 1,
    tags: [],
    kind: 'working_context',
    title: `记忆 ${entrySeq}`,
    content: '默认内容',
    producer: 'test-producer',
    source: 'agent-proposal',
    scope: 'user',
    workspace: null,
    evidence: 'inferred',
    basis: '测试依据',
    lifecycle: 'active',
    supersedes: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    confirmedAt: 1_700_000_000_000,
    ofkRef: null,
  };
  return { ...base, ...over };
}

export function makeMemoryEvent(over: Partial<MemoryEvent>): MemoryEvent {
  eventSeq += 1;
  return {
    id: eventSeq,
    ts: 1_700_000_000_000 + eventSeq,
    entryId: `event-entry-${eventSeq}`,
    event: 'recorded' as string,
    detail: null as MemoryEvent['detail'],
    ...over,
  } as MemoryEvent;
}

export const ok = <T,>(value: T): SerializedResult<T> => ({ ok: true, value });
const fail = (code: string, message: string): SerializedResult<never> => ({
  ok: false,
  error: { code, message } satisfies LorraError,
});

// ---------------------------------------------------------------------------
// window.lorra.memory bridge mock
// ---------------------------------------------------------------------------

export interface MemoryLorraMock extends LorraMock {
  memory: {
    listEvents: Mock;
    listActive: Mock;
    listArchived: Mock;
    listLinks: Mock;
    getCoreProjection: Mock;
    getWorkingMemory: Mock;
    getArchivalAudit: Mock;
    okfCheck: Mock;
    edit: Mock;
    retire: Mock;
    search: Mock;
    digestText: Mock;
    digestFile: Mock;
    readDocument: Mock;
  };
}

export function installMemoryLorraMock(): MemoryLorraMock {
  const mock = installLorraMock() as MemoryLorraMock;
  mock.memory = {
    listEvents: vi.fn(),
    listActive: vi.fn(),
    listArchived: vi.fn(),
    listLinks: vi.fn(),
    getCoreProjection: vi.fn(),
    getWorkingMemory: vi.fn(),
    getArchivalAudit: vi.fn(),
    okfCheck: vi.fn(),
    edit: vi.fn(),
    retire: vi.fn(),
    search: vi.fn(),
    digestText: vi.fn(),
    digestFile: vi.fn(),
    readDocument: vi.fn(),
  };
  return mock;
}

/** 默认数据源:审计事件 ×4 / 生效 ×3 类 / 归档 ×2(含 superseded 覆盖链)。 */
export interface MemoryFixture {
  events: MemoryEvent[];
  active: MemoryEntry[];
  archived: MemoryEntry[];
  links?: Array<{ fromId: string; toId: string }>;
}

export function makeFixture(): MemoryFixture {
  // 归档先行:active[0] 的 supersedes 链指向归档里的「契约铁律(旧)」。
  const archived = [
    makeMemoryEntry({ lifecycle: 'superseded', supersedes: null, content: '旧版契约铁律', title: '契约铁律(旧)', source: 'user-crystallization' }),
    makeMemoryEntry({ lifecycle: 'retired', content: '已撤销:旧习惯', title: '旧习惯(已撤销)' }),
  ];
  const active = [
    makeMemoryEntry({ kind: 'hard_policy', lifecycle: 'active', confirmedAt: 1, supersedes: archived[0].entryId, content: '硬规则:禁改共享契约', title: '契约铁律' }),
    makeMemoryEntry({ kind: 'soft_preference', lifecycle: 'active', confirmedAt: 2, content: '偏好:代码用中文注释', title: '注释语言' }),
    makeMemoryEntry({ kind: 'knowledge', lifecycle: 'active', confirmedAt: 3, content: '知识:IPC 契约单一事实源', title: 'PROB-012' }),
  ];
  const events = [
    makeMemoryEvent({ id: 4, ts: 4_000, entryId: active[1].entryId, event: 'edited' }),
    makeMemoryEvent({ id: 3, ts: 3_000, entryId: archived[0].entryId, event: 'superseded' }),
    makeMemoryEvent({ id: 2, ts: 2_000, entryId: active[0].entryId, event: 'recorded' }),
    makeMemoryEvent({ id: 1, ts: 1_000, entryId: archived[1].entryId, event: 'retired' }),
  ];
  return { events, active, archived };
}

function seedMock(mock: MemoryLorraMock, fx: MemoryFixture): void {
  mock.memory.listEvents.mockResolvedValue(ok(fx.events));
  mock.memory.listActive.mockResolvedValue(ok(fx.active));
  mock.memory.listArchived.mockResolvedValue(ok(fx.archived));
  mock.memory.listLinks.mockResolvedValue(ok(fx.links ?? []));
  mock.memory.getCoreProjection.mockResolvedValue(
    ok({
      text: '- [workspace_identity] 当前工作区：test',
      workspaceIdentity: 'test',
      entryIds: ['core-1'],
    }),
  );
  mock.memory.getWorkingMemory.mockResolvedValue(
    ok({
      goal: '完成分层记忆',
      constraints: ['最小 diff'],
      openLoops: [],
      recentCorrections: [],
      recentDecisions: [],
      pendingFacts: [],
      updatedAt: 1,
    }),
  );
  mock.memory.getArchivalAudit.mockResolvedValue(
    ok({
      reason: '用户在追问历史决策或既有事实',
      triggeredBy: 'history',
      sources: ['memory'],
      query: '之前怎么定的',
      memoryEntryIds: ['mem-1'],
      ofkPaths: ['memory/mem-1.md'],
      text: '- [working_context] 历史决定：xxx',
      updatedAt: 1,
    }),
  );
  mock.memory.okfCheck.mockResolvedValue(
    ok({
      path: 'memory/demo.md',
      type: 'Note',
      generated: false,
      verified: false,
      issues: [{ level: 'warn', code: 'missing-type', message: '缺少 type' }],
    }),
  );
  mock.memory.retire.mockResolvedValue(ok(makeMemoryEntry({ lifecycle: 'retired', content: 'x' })));
  mock.memory.edit.mockResolvedValue(ok(makeMemoryEntry({ lifecycle: 'active', confirmedAt: 9, content: 'x' })));
  mock.memory.search.mockResolvedValue(ok([]));
  mock.session.list.mockResolvedValue(
    ok([{ id: 'sess-1', cwd: '/test/workspace', path: '/tmp/sess.jsonl', created: new Date(), modified: new Date(), messageCount: 1, firstMessage: 'hi' }]),
  );
}

let mock: MemoryLorraMock;

beforeEach(() => {
  entrySeq = 0;
  eventSeq = 0;
  mock = installMemoryLorraMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// DOM 读取助手
// ---------------------------------------------------------------------------

function zone(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

function entryCards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid="memory-entry"]'));
}

/** 等待数据加载完成。 */
async function waitLoaded(): Promise<void> {
  await waitFor(() => expect(mock.memory.listEvents).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('memory-workspace')).toBeInTheDocument());
}

/** 展开左栏「最近变更」审计折叠。 */
async function expandEvents(): Promise<void> {
  await userEvent.setup().click(screen.getByText('最近变更'));
}

/** 展开某 kind 组尾的归档折叠(点「归档 N」)。 */
async function expandArchived(kindLabel: string): Promise<void> {
  const toggle = screen.getByRole('button', { name: new RegExp(`归档`) });
  await userEvent.setup().click(toggle);
  void kindLabel;
}

// ---------------------------------------------------------------------------

describe('MemoryPage(三栏工作台 + 操作)', () => {
  it('三栏渲染:知识树 / 条目流 / 条目页面各自承载对应数据;审计默认折叠', async () => {
    const fx = makeFixture();
    seedMock(mock, fx);
    render(<MemoryPage />);

    await waitLoaded();
    // 左栏知识树:三组 kind(硬性规则/软性偏好/知识页)。
    const tree = zone('memory-tree');
    expect(within(tree).getByText('硬性规则')).toBeInTheDocument();
    expect(within(tree).getByText('软性偏好')).toBeInTheDocument();
    expect(within(tree).getByText('知识页')).toBeInTheDocument();
    // 树含归档折叠行(2 条归档)。
    expect(within(tree).getByText(/归档 2/)).toBeInTheDocument();
    // 中栏条目流:3 条 active。
    const activeZone = zone('memory-zone-active');
    expect(entryCards(activeZone)).toHaveLength(3);
    // 右栏默认选中第一条(契约铁律)。
    expect(zone('memory-doc')).toBeInTheDocument();
    expect(within(zone('memory-doc')).getByRole('heading', { name: '契约铁律' })).toBeInTheDocument();
    // 审计默认折叠:不渲染事件列表;展开后 4 条。
    expect(screen.queryByTestId('memory-audit-list')).not.toBeInTheDocument();
    await expandEvents();
    expect(screen.getAllByTestId('memory-audit-item')).toHaveLength(4);
  });

  it('审计视图(左栏折叠):事件倒序 + 四态中文徽标 + 关联条目标题,只读', async () => {
    const fx = makeFixture();
    seedMock(mock, fx);
    render(<MemoryPage />);

    await waitLoaded();
    await expandEvents();
    const items = screen.getAllByTestId('memory-audit-item');
    expect(items.map((el) => el.getAttribute('data-event-kind'))).toEqual([
      'edited',
      'superseded',
      'recorded',
      'retired',
    ]);
    expect(screen.getByText('已编辑')).toBeInTheDocument();
    expect(screen.getByText('已取代')).toBeInTheDocument();
    expect(screen.getByText('已记录')).toBeInTheDocument();
    expect(screen.getByText('已撤销')).toBeInTheDocument();
    // 关联条目标题(审计列表内;「注释语言」同时是树/中栏条目,限定审计区)。
    const auditList = screen.getByTestId('memory-audit-list');
    expect(within(auditList).getByText('注释语言')).toBeInTheDocument();
    expect(within(auditList).getByText('契约铁律(旧)')).toBeInTheDocument();
    expect(within(auditList).getByText('契约铁律')).toBeInTheDocument();
    // 审计区只读:事件列表内无任何操作按钮。
    expect(within(auditList).queryAllByRole('button')).toHaveLength(0);
  });

  it('知识树:按 kind 分组(顺序照 MEMORY_KINDS),组头含类别标签;点击组过滤中栏', async () => {
    const fx = makeFixture();
    seedMock(mock, fx);
    render(<MemoryPage />);

    await waitLoaded();
    const tree = zone('memory-tree');
    // 有数据的组渲染组头(空组不占位),顺序 = 树内 DOM 顺序;
    // 「工作上下文」组来自归档条目的默认 kind(仅归档行)。
    const labels = Array.from(tree.querySelectorAll('.memory-tree-label')).map((el) => el.textContent);
    expect(labels).toEqual(['全部', '硬性规则', '软性偏好', '工作上下文', '知识页', '最近变更']);
    // 点「知识页」组 → 中栏只剩 knowledge 类 1 条。
    await userEvent.setup().click(within(tree).getByText('知识页'));
    const activeZone = zone('memory-zone-active');
    expect(entryCards(activeZone)).toHaveLength(1);
    expect(within(activeZone).getByText('PROB-012')).toBeInTheDocument();
  });

  it('编辑 dialog:改 title/content/类别(kind 可改)→ 保存调 edit 带 kind;撤销调 retire', async () => {
    const fx = makeFixture();
    seedMock(mock, fx);
    render(<MemoryPage />);

    await waitLoaded();
    const user = userEvent.setup();
    // 右栏操作条编辑按钮(生效条目)。
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByTestId('memory-edit-dialog');
    await user.clear(within(dialog).getByLabelText('标题'));
    await user.type(within(dialog).getByLabelText('标题'), '契约铁律 v2');
    // 类别从 hard_policy 改为知识页。
    await user.selectOptions(within(dialog).getByLabelText('类别'), 'knowledge');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mock.memory.edit).toHaveBeenCalledWith(
        expect.objectContaining({
          entryId: fx.active[0].entryId,
          title: '契约铁律 v2',
          kind: 'knowledge',
        }),
      ),
    );

    // 撤销走 retire(右栏操作条)。
    mock.memory.retire.mockClear();
    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(mock.memory.retire).toHaveBeenCalledWith({ entryId: fx.active[0].entryId }));
  });

  it('搜索:提交后走 search 通道,中栏展示结果区', async () => {
    const fx = makeFixture();
    seedMock(mock, fx);
    const hit = makeMemoryEntry({ kind: 'knowledge', content: '命中:搜索框中文子串', title: '搜索结果条目' });
    mock.memory.search.mockResolvedValue(ok([hit]));
    render(<MemoryPage />);

    await waitLoaded();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('memory-search-input'), '中文子串');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mock.memory.search).toHaveBeenCalledWith({ query: '中文子串' }));
    const activeZone = zone('memory-zone-active');
    await waitFor(() => expect(entryCards(activeZone)).toHaveLength(1));
    expect(within(activeZone).getByText('搜索结果条目')).toBeInTheDocument();
  });

  it('右栏显示 core / working / archival 审计，并对 OFK 文档展示 OKF 提示', async () => {
    const fx = makeFixture();
    fx.active[0] = { ...fx.active[0], ofkRef: 'memory/demo.md' };
    seedMock(mock, fx);
    render(<MemoryPage />);

    await waitLoaded();
    expect(screen.getByTestId('memory-core-audit').textContent).toContain('来源 1 条');
    expect(screen.getByTestId('memory-core-audit').textContent).toContain('test');
    expect(screen.getByTestId('memory-session-audit').textContent).toContain('完成分层记忆');
    expect(screen.getByTestId('memory-session-audit').textContent).toContain('history');
    await waitFor(() => expect(mock.memory.okfCheck).toHaveBeenCalledWith('memory/demo.md'));
    expect(screen.getByTestId('memory-okf-audit').textContent).toContain('缺少 type');
  });

  it('中栏只渲染生效条目;归档折叠进左栏灰态行,展开可见且只读', async () => {
    const fx = makeFixture();
    seedMock(mock, fx);
    render(<MemoryPage />);

    await waitLoaded();
    // 中栏 3 条 active,无归档条目。
    const activeZone = zone('memory-zone-active');
    expect(entryCards(activeZone)).toHaveLength(3);
    expect(within(activeZone).queryByText('旧习惯(已撤销)')).not.toBeInTheDocument();
    // 展开归档 → 树里出现 retired 行(标题 + 「已撤销」徽标 + 删除线类)。
    await expandArchived('硬性规则');
    const tree = zone('memory-tree');
    const retiredRow = within(tree).getByText('旧习惯(已撤销)').closest('button');
    expect(retiredRow).not.toBeNull();
    expect(retiredRow?.className).toContain('retired');
    expect(within(tree).getByText('已撤销')).toBeInTheDocument();
    // 归档行只读:点击只在右栏查看,无编辑/撤销按钮。
    await userEvent.setup().click(retiredRow!);
    expect(zone('memory-doc')).toBeInTheDocument();
    expect(within(zone('memory-doc')).getByText('已撤销')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
  });

  it('标签:条目带标准化标签 → 中栏与右栏展示标签 chips;来源徽标不出现', async () => {
    const fx = makeFixture();
    fx.active[0] = {
      ...fx.active[0],
      tags: ['规定', '项目: 量化回测', 'Rust'],
      content: '硬规则:禁改共享契约',
    };
    seedMock(mock, fx);
    render(<MemoryPage />);

    await waitLoaded();
    // 中栏条目行内标签 chips(「#」是 CSS 伪元素,断言纯文本)。
    const activeZone = zone('memory-zone-active');
    expect(within(activeZone).getByText('规定')).toBeInTheDocument();
    expect(within(activeZone).getByText('Rust')).toBeInTheDocument();
    // 右栏文档标签区。
    const doc = zone('memory-doc');
    expect(within(doc).getByText('项目: 量化回测')).toBeInTheDocument();
    // 来源徽标移除(会话自动提取/素材消化不出现在右栏徽标区)。
    expect(within(doc).queryByText('agent 提议')).not.toBeInTheDocument();
  });

  it('关系面板:反向链接 / 出站链接来自 list-links 数据,点击切换右栏条目', async () => {
    const fx = makeFixture();
    const target = fx.active[2]; // 
    const source = fx.active[1]; // 注释语言
    seedMock(mock, { ...fx, links: [{ fromId: source.entryId, toId: target.entryId }] });
    render(<MemoryPage />);

    await waitLoaded();
    // 选中 (点中栏条目)。
    await userEvent.setup().click(within(zone('memory-zone-active')).getByText('PROB-012'));
    const doc = zone('memory-doc');
    const relations = within(doc).getByTestId('memory-relations');
    expect(within(relations).getByText('← 注释语言')).toBeInTheDocument();
    // 点击反向链接 → 右栏切换到来源条目。
    await userEvent.setup().click(within(relations).getByText('← 注释语言'));
    await waitFor(() =>
      expect(within(zone('memory-doc')).getByRole('heading', { name: '注释语言' })).toBeInTheDocument(),
    );
  });

  it('空态:三区全空渲染空态文案', async () => {
    seedMock(mock, { events: [], active: [], archived: [] });
    render(<MemoryPage />);

    await waitFor(() => expect(screen.getByTestId('memory-empty')).toBeInTheDocument());
    expect(screen.getByText('还没有记忆')).toBeInTheDocument();
  });

  it('错误态:任一列表失败展示 LorraError message,重试按钮重新拉取', async () => {
    const fx = makeFixture();
    seedMock(mock, fx);
    mock.memory.listActive.mockResolvedValue(fail('memory-store-list-failed', '读取生效记忆失败'));
    render(<MemoryPage />);

    await waitFor(() => expect(screen.getByTestId('memory-error')).toBeInTheDocument());
    expect(screen.getByText('读取生效记忆失败')).toBeInTheDocument();

    mock.memory.listActive.mockResolvedValue(ok(fx.active));
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByTestId('memory-workspace')).toBeInTheDocument());
  });

  it('加载态:首次拉取未返回前显示 loading', () => {
    seedMock(mock, makeFixture());
    let resolveActive: (v: SerializedResult<MemoryEntry[]>) => void = () => {};
    mock.memory.listActive.mockImplementation(
      () =>
        new Promise<SerializedResult<MemoryEntry[]>>((resolve) => {
          resolveActive = resolve;
        }),
    );
    render(<MemoryPage />);

    expect(screen.getByTestId('memory-loading')).toBeInTheDocument();
    resolveActive(ok([]));
  });
});

// ---------------------------------------------------------------------------
// 6.12 knowledge wikilink:断链标记 + 跨页导航(右栏文档切换,不再用详情弹层)
// ---------------------------------------------------------------------------

describe('MemoryPage(6.12 knowledge 链接)', () => {
  /**
 * 链接夹具:active knowledge ×2(引用者 → 目标页/不存在/已归档)
 * + 归档 knowledge(「已归档」retired,供 archived 断链态)。
 */
  function makeLinkFixture(): MemoryFixture {
    const archived = [
      makeMemoryEntry({
        kind: 'knowledge',
        lifecycle: 'retired',
        confirmedAt: null,
        title: '已归档',
        content: '已归档内容',
      }),
    ];
    const active = [
      makeMemoryEntry({
        kind: 'knowledge',
        lifecycle: 'active',
        confirmedAt: 1,
        title: '目标页',
        content: '目标页内容正文',
      }),
      makeMemoryEntry({
        kind: 'knowledge',
        lifecycle: 'active',
        confirmedAt: 2,
        title: '引用者',
        content: '引用者内容,见 [[目标页]];再看 [[不存在]] 与 [[已归档]]',
      }),
    ];
    return { events: [], active, archived };
  }

  async function renderLinkFixture(): Promise<void> {
    const fx = makeLinkFixture();
    seedMock(mock, fx);
    render(<MemoryPage />);
    await waitLoaded();
    // 中栏点「引用者」→ 右栏展示其内容。
    await userEvent.setup().click(within(zone('memory-zone-active')).getByText('引用者'));
  }

  function doc(): HTMLElement {
    return zone('memory-doc');
  }

  it('knowledge 条目含 [[存在]] → 点击在右栏导航到目标条目文档', async () => {
    await renderLinkFixture();
    const user = userEvent.setup();
    const link = within(doc()).getByText('目标页');
    await user.click(link);
    await waitFor(() =>
      expect(within(doc()).getByRole('heading', { name: '目标页' })).toBeInTheDocument(),
    );
    expect(within(doc()).getByText('目标页内容正文')).toBeInTheDocument();
  });

  it('knowledge 条目含 [[不存在]] → knowledge-link-broken 标记 + 「目标不存在」提示,点击不导航', async () => {
    await renderLinkFixture();
    const user = userEvent.setup();
    const broken = within(doc()).getByText('不存在');
    expect(broken.className).toContain('knowledge-link-broken');
    expect(broken).toHaveAttribute('data-broken', 'missing');
    expect(broken).toHaveAttribute('data-hint', '目标不存在');
    await user.click(broken);
    expect(within(doc()).getByRole('heading', { name: '引用者' })).toBeInTheDocument();
  });

  it('knowledge 条目含 [[已归档]] → data-broken=archived + 「目标已归档」提示', async () => {
    await renderLinkFixture();
    const broken = within(doc()).getByText('已归档');
    expect(broken.className).toContain('knowledge-link-broken');
    expect(broken).toHaveAttribute('data-broken', 'archived');
    expect(broken).toHaveAttribute('data-hint', '目标已归档');
  });
});

// ---------------------------------------------------------------------------
// 素材消化(6.13):记忆页入口已移除(2026-08-10)——记忆是对话 loop 的产物,
// 不在记忆页提供显式「喂素材」入口;digest IPC 能力保留在对话侧/未来入口。
// ---------------------------------------------------------------------------

describe('查看文档（ofkRef）', () => {
  it('带 ofkRef 的条目显示「查看文档」;点击后渲染文档视图,返回条切回', async () => {
    const fx = makeFixture();
    fx.active[0].ofkRef = '/memory/e1.md';
    mock.memory.readDocument.mockResolvedValue(ok({ content: '# 完整文档\n\n长内容正文' }));
    seedMock(mock, fx);
    render(<MemoryPage />);
    await waitLoaded();

    // 选中第一条(默认选中)
    const link = await screen.findByTestId('memory-doc-link');
    expect(link).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(link);
    expect(mock.memory.readDocument).toHaveBeenCalledWith('/memory/e1.md');
    const view = await screen.findByTestId('memory-doc-view');
    expect(view.textContent).toContain('完整文档');
    expect(view.textContent).toContain('长内容正文');

    await user.click(screen.getByTestId('memory-doc-back'));
    expect(screen.queryByTestId('memory-doc-view')).not.toBeInTheDocument();
  });

  it('无 ofkRef 的条目不显示「查看文档」', async () => {
    const fx = makeFixture();
    seedMock(mock, fx); // 默认 fixture 无 ofkRef
    render(<MemoryPage />);
    await waitLoaded();
    expect(screen.queryByTestId('memory-doc-link')).not.toBeInTheDocument();
  });

  it('文档加载失败 → 内联错误文案,不崩溃', async () => {
    const fx = makeFixture();
    fx.active[0].ofkRef = '/memory/e1.md';
    mock.memory.readDocument.mockResolvedValue({
      ok: false,
      error: { code: 'ofk-read-failed', message: '读取失败' },
    });
    seedMock(mock, fx);
    render(<MemoryPage />);
    await waitLoaded();

    await userEvent.setup().click(screen.getByTestId('memory-doc-link'));
    const err = await screen.findByTestId('memory-doc-error');
    expect(err.textContent).toContain('读取失败');
  });
});
