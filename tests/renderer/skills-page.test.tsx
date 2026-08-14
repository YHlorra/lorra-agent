/**
 * 技能管理页黑盒测试(2026-08-12-skill-manager V1-11,TDD)。
 *
 * 规范真源:
 * - 
 * Requirement「技能管理页」(页头/5 统计卡/单表格/编辑=仅工作区源/三态)
 * + Scenario「页面数据流」(xray 一次拉全量;开关/清理悬空 IPC + 状态更新)
 * + Requirement「常驻上下文预算」(三级分级:≤2000 良好 / 2,000–4,000 警告 /
 * >4,000 超限;token 唯一单位 Σ字符÷3.5)
 * - /D14(5 卡并排、
 * 预算第 5 卡 mini 条 0–4,000 满刻 + 2,000/4,000 双刻度、三级填充色与文案、
 * 表格语言、徽章、手写 toggle、编辑=仅工作区源、渲染纪律)
 * - (视觉唯一事实源)+ design-previews/2026-08-12-skill-manager/
 * index.html .dir-b 最终稿(示例 2,937 tokens = 警告档:填充 73.4%、
 * warm-brown #8A4A33、2,000 刻度 50% 淡、4,000 刻度 100% 右对齐)
 * - src/shared/skills-api.ts(类型/常量单一事实源)
 *
 * IPC 信封 = 生产 SerializedResult {status:'ok',value}/{status:'error',error}
 * (preload 对 skills 面直接透传,与 today 同款;{ok:true} 视图形状是死分支,不喂)。
 * 编辑链路:App 传 onOpenFile(= openFileFromTool,现有 fs-ipc 打开链路),点击 →
 * onOpenFile(skill.filePath) + 切回工作台;非工作区源置灰 + tooltip。
 *
 * 测试钩子契约(实现方按此暴露可观测面):
 * data-testid="skills-page" 整页根
 * data-testid="skills-loading" 加载态(hero 骨架 + 表格骨架)
 * data-testid="skills-error" 错误态(role=alert,含重试按钮)
 * data-testid="skills-empty" 空态(无技能)
 * data-testid="skills-hero-card" 统计卡,data-metric=total|recent|idle|issues|budget
 * data-testid="skills-budget-value" 预算卡 token 主数字
 * data-testid="skills-budget-fill" mini 条填充,data-status=good|warn|over,class budget-*
 * data-testid="skills-budget-tick" 刻度线,data-token=2000|4000,style.left=50%|100%
 * data-testid="skills-budget-cap" 分级 cap 文案
 * data-testid="skills-table" 单表格
 * data-testid="skills-row" 数据行,data-name=技能名(DOM 序 = 排序序)
 * data-testid="skills-toggle" checkbox,data-name=技能名
 * data-testid="skills-edit" 编辑按钮,data-name=技能名
 * data-testid="skills-frow" 表尾合计行
 * data-testid="skills-clean-dangling" 清理悬空按钮(仅 dangling 非空时渲染)
 * data-testid="skills-action-error" 行内动作错误横幅(开关/清理失败)
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '@/lib/app-store';
import { SkillsPage } from '../../src/renderer/skills-page';
import type {
  SkillBudget,
  SkillInfo,
  SkillStats,
  SkillXray,
} from '../../src/shared/skills-api';
import { makeLorraMock, type LorraMock } from './lorra-test-helpers';

// ---------------------------------------------------------------------------
// 生产形状 IPC 信封(SerializedResult,与 preload 透传同款)。
// ---------------------------------------------------------------------------

function okSkills(data: SkillXray): { status: 'ok'; value: SkillXray } {
  return { status: 'ok', value: data };
}

function errSkills(
  code: string,
  message: string,
): { status: 'error'; error: { code: string; message: string } } {
  return { status: 'error', error: { code, message } };
}

// ---------------------------------------------------------------------------
// Fixtures:钉 src/shared/skills-api.ts 生产类型形状。
// ---------------------------------------------------------------------------

function makeSkill(over: Partial<SkillInfo> & { name: string }): SkillInfo {
  // 生产语义(SkillInfo.enabled 文档):系统种子恒不注入 → enabled=false。
  const systemManaged = over.systemManaged ?? false;
  const source = over.source ?? 'workspace';
  return {
    source,
    scope:
      over.scope ?? (source === 'workspace' || source === 'ancestor' ? 'project' : 'global'),
    filePath: `E:/ws/.lorra/skills/${over.name}/SKILL.md`,
    realPath: `E:/ws/.lorra/skills/${over.name}/SKILL.md`,
    rootDir: `E:/ws/.lorra/skills/${over.name}`,
    description: `${over.name} 技能描述`,
    descriptionChars: 20,
    estimatedTokens: 6,
    enabled: over.enabled ?? !systemManaged,
    disabledInWs: over.disabledInWs ?? false,
    globallyHidden: over.globallyHidden ?? false,
    systemManaged,
    disableModelInvocation: false,
    isDuplicate: false,
    issues: [],
    ...over,
  };
}

function makeStats(over: Partial<SkillStats> = {}): SkillStats {
  return { totalCount: 0, recentCount: 0, lastUsedAt: null, byWorkspace: {}, ...over };
}

/** 标准 warn 态预算:2,937 tokens = 设计稿示例(条 73.4%、warm-brown)。 */
function makeBudget(over: Partial<SkillBudget> = {}): SkillBudget {
  return {
    estimatedTokens: 2937,
    goodLine: 2000,
    warnLine: 4000,
    status: 'warn',
    enabledCount: 3,
    charSum: 10278,
    ...over,
  };
}

function makeXray(over: Partial<SkillXray> = {}): SkillXray {
  return {
    skills: [],
    stats: {},
    budget: makeBudget(),
    dangling: [],
    gitStatus: {},
    collectionRoot: 'E:/collection',
    workspacePath: 'E:/ws',
    ...over,
  };
}

/** 时间戳快捷造数(相对 now 的分钟偏移,保证相对时间文案稳定)。 */
function ago(min: number): number {
  return Date.now() - min * 60_000;
}

interface SkillsLorraMock extends LorraMock {
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

function installSkillsLorraMock(): SkillsLorraMock {
  const m = makeLorraMock() as SkillsLorraMock;
  m.skills = {
    xray: vi.fn().mockResolvedValue(okSkills(makeXray())),
    setEnabled: vi.fn().mockResolvedValue({ status: 'ok', value: undefined }),
    cleanDangling: vi.fn().mockResolvedValue({ status: 'ok', value: { cleaned: 1 } }),
    collect: vi.fn().mockResolvedValue({
      status: 'ok',
      value: { moved: 0, linked: 0, conflicts: [], notes: [] },
    }),
    checkUpdates: vi.fn().mockResolvedValue({ status: 'ok', value: {} }),
    updateAll: vi.fn().mockResolvedValue({ status: 'ok', value: { updated: [], skipped: [] } }),
    setWsEnabled: vi.fn().mockResolvedValue({ status: 'ok', value: undefined }),
  };
  Object.defineProperty(window, 'lorra', { value: m, writable: true, configurable: true });
  return m;
}

let mock: SkillsLorraMock;

beforeEach(() => {
  mock = installSkillsLorraMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// DOM 读取助手
// ---------------------------------------------------------------------------

function hero(metric: string): HTMLElement {
  const el = document.querySelector(`[data-testid="skills-hero-card"][data-metric="${metric}"]`);
  if (!el) throw new Error(`没有统计卡 data-metric=${metric}`);
  return el as HTMLElement;
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="skills-row"]'));
}

function row(name: string): HTMLElement {
  const found = rows().find((r) => r.getAttribute('data-name') === name);
  if (!found) throw new Error(`没有技能行 ${name}`);
  return found;
}

function toggleOf(name: string): HTMLInputElement {
  const el = row(name).querySelector('[data-testid="skills-toggle"]');
  if (!(el instanceof HTMLInputElement)) throw new Error(`技能 ${name} 没有启用开关`);
  return el;
}

function editOf(name: string): HTMLButtonElement {
  const el = row(name).querySelector('[data-testid="skills-edit"]');
  if (!(el instanceof HTMLButtonElement)) throw new Error(`技能 ${name} 没有编辑按钮`);
  return el;
}

function posOf(
  name: string,
): { scope: string; sub: string; title: string } {
  const el = row(name).querySelector('.sk-pos');
  return {
    scope: el?.getAttribute('data-scope') ?? '',
    sub: el?.querySelector('.sk-pos-sub')?.textContent?.trim() ?? '',
    title: el?.getAttribute('title') ?? '',
  };
}

/** 渲染页面并等数据到位(hero 卡就绪即数据已渲染)。 */
async function renderPage(xray?: SkillXray): Promise<void> {
  if (xray) mock.skills.xray.mockResolvedValue(okSkills(xray));
  render(<SkillsPage />);
  await screen.findAllByTestId('skills-hero-card');
}

// =========================================================================
// Requirement: 5 统计卡(含上下文预算第 5 卡)
// =========================================================================

/** 非空最小 xray(1 个技能):供加载/错误/无悬空等「需要表格而非空态」的用例。 */
function oneSkillXray(): SkillXray {
  return makeXray({
    skills: [makeSkill({ name: 'solo' })],
    stats: { solo: makeStats({ totalCount: 1, recentCount: 1, lastUsedAt: ago(60) }) },
  });
}

describe('Requirement: 5 统计卡 hero', () => {
  const three = makeXray({
    skills: [
      makeSkill({ name: 'used-a' }),
      makeSkill({ name: 'used-b' }),
      makeSkill({ name: 'idle-c' }),
      makeSkill({ name: 'broken-d', enabled: false, issues: [{ code: 'missing-description', message: '缺描述' }] }),
      makeSkill({ name: 'seed-e', systemManaged: true }),
    ],
    stats: {
      'used-a': makeStats({ totalCount: 5, recentCount: 3, lastUsedAt: ago(120) }),
      'used-b': makeStats({ totalCount: 2, recentCount: 1, lastUsedAt: ago(60 * 24) }),
      'idle-c': makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
      'broken-d': makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
      'seed-e': makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
    },
    budget: makeBudget(),
  });

  it('Scenario 页面数据流:5 卡并排渲染——全部/45 天用过/吃灰/有问题/上下文预算', async () => {
    await renderPage(three);
    const cards = Array.from(document.querySelectorAll('[data-testid="skills-hero-card"]'));
    expect(cards).toHaveLength(5);
    // 全部 = skills.length(系统种子也计入总数)
    expect(hero('total').textContent).toMatch(/5/);
    // 45 天用过 = recentCount>0 的技能数
    expect(hero('recent').textContent).toMatch(/2/);
    // 吃灰 = 已启用 ∧ recentCount=0(种子不注入,不进吃灰)
    expect(hero('idle').textContent).toMatch(/1/);
    // 有问题 = issues.length>0 且非系统管理(种子不进有问题计数)
    expect(hero('issues').textContent).toMatch(/1/);
    // 有问题数字 danger 色
    expect(hero('issues').querySelector('.sk-hc-v')?.className).toContain('danger');
    // 预算第 5 卡在位
    expect(hero('budget')).toBeInTheDocument();
  });

  it('Requirement 预算分级·警告档(设计稿示例):2,937 tokens → 填充 73.4%、warm-brown、双刻度、警告文案', async () => {
    await renderPage(three);
    const budgetCard = hero('budget');
    // 主数字 = token 估算(UI 唯一单位)
    expect(within(budgetCard).getByTestId('skills-budget-value').textContent).toBe('2,937');
    // mini 条:0–4,000 满刻 → 2937/4000 = 73.425% → 73.4%
    const fill = within(budgetCard).getByTestId('skills-budget-fill');
    expect(fill.style.width).toBe('73.4%');
    expect(fill.getAttribute('data-status')).toBe('warn');
    expect(fill.className).toContain('budget-warn'); // CSS: warm-brown #8A4A33
    // 双刻度:2,000 在 50% 淡次刻度 + 4,000 在 100% 主刻度
    const ticks = Array.from(budgetCard.querySelectorAll('[data-testid="skills-budget-tick"]'));
    expect(ticks).toHaveLength(2);
    const t2000 = ticks.find((t) => t.getAttribute('data-token') === '2000');
    const t4000 = ticks.find((t) => t.getAttribute('data-token') === '4000');
    expect(t2000?.getAttribute('style')).toContain('50%');
    expect(t2000?.className).toContain('sk-budget-tick-good');
    expect(t4000?.getAttribute('style')).toContain('100%');
    // 刻度标签:2,000 居中 + 4,000 右对齐防溢出
    const labels = Array.from(budgetCard.querySelectorAll('.sk-budget-ticklabel'));
    expect(labels.some((l) => l.textContent === '2,000')).toBe(true);
    const l4000 = labels.find((l) => l.textContent === '4,000');
    expect(l4000).toBeDefined();
    expect(l4000?.className).toContain('main');
    // 分级 cap 文案(警告档)
    expect(within(budgetCard).getByTestId('skills-budget-cap').textContent).toBe(
      '接近上限 · 建议关闭低频技能或缩短描述',
    );
  });

  it('Requirement 预算分级·超限档:danger 填充 + 满条 + 治理动作文案', async () => {
    await renderPage(
      makeXray({
        skills: oneSkillXray().skills,
        stats: oneSkillXray().stats,
        budget: makeBudget({ estimatedTokens: 4500, status: 'over' }),
      }),
    );
    const budgetCard = hero('budget');
    const fill = within(budgetCard).getByTestId('skills-budget-fill');
    expect(fill.style.width).toBe('100%');
    expect(fill.getAttribute('data-status')).toBe('over');
    expect(fill.className).toContain('budget-over'); // CSS: danger
    expect(within(budgetCard).getByTestId('skills-budget-cap').textContent).toBe(
      '超过参考线 · 建议关闭技能或缩短描述',
    );
  });

  it('Requirement 预算分级·良好档:accent 填充 + 「低于建议线」文案', async () => {
    await renderPage(
      makeXray({
        skills: oneSkillXray().skills,
        stats: oneSkillXray().stats,
        budget: makeBudget({ estimatedTokens: 1500, status: 'good' }),
      }),
    );
    const budgetCard = hero('budget');
    const fill = within(budgetCard).getByTestId('skills-budget-fill');
    expect(fill.style.width).toBe('37.5%'); // 1500/4000
    expect(fill.getAttribute('data-status')).toBe('good');
    expect(fill.className).toContain('budget-good');
    expect(within(budgetCard).getByTestId('skills-budget-cap').textContent).toBe(
      '低于建议线 · 技能目录精简',
    );
  });

  it('Scenario 吃灰口径:disabledInWs / globallyHidden / 停用(种子)均不进吃灰计数', async () => {
    // idle-c:enabled ∧ !disabledInWs ∧ !globallyHidden ∧ recentCount=0 → 唯一吃灰。
    // ws-off-d:本工作区停用(disabledInWs)→ 排除;hidden-e:全局隐藏 → 排除;
    // broken-d:enabled=false → 排除;seed-e:系统种子(enabled=false)→ 排除。
    await renderPage(
      makeXray({
        skills: [
          makeSkill({ name: 'idle-c' }),
          makeSkill({ name: 'ws-off-d', disabledInWs: true }),
          makeSkill({ name: 'hidden-e', globallyHidden: true }),
          makeSkill({ name: 'broken-d', enabled: false }),
          makeSkill({ name: 'seed-e', systemManaged: true }),
        ],
        stats: Object.fromEntries(
          ['idle-c', 'ws-off-d', 'hidden-e', 'broken-d', 'seed-e'].map((n) => [
            n,
            makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
          ]),
        ),
        budget: makeBudget(),
      }),
    );
    expect(hero('total').textContent).toMatch(/5/);
    expect(hero('idle').textContent).toMatch(/1/);
  });
});

// =========================================================================
// Requirement: 单表格(徽章 / 位置 / 45 天 / 开关 / 排序)
// =========================================================================

describe('Requirement: 表格行内容', () => {
  const xray = makeXray({
    skills: [
      makeSkill({
        name: 'broken-a',
        issues: [{ code: 'missing-description', message: '缺描述' }],
      }),
      makeSkill({ name: 'dupe-b', isDuplicate: true }),
      makeSkill({ name: 'seed-c', systemManaged: true }),
      makeSkill({ name: 'g-a', source: 'lorra-global', filePath: 'C:/Users/t/.lorra/skills/g-a/SKILL.md' }),
      makeSkill({ name: 'u-a', source: 'user', filePath: 'C:/Users/t/.agents/skills/u-a/SKILL.md' }),
      makeSkill({ name: 'anc-a', source: 'ancestor', filePath: 'E:/anc/.agents/skills/anc-a/SKILL.md' }),
    ],
    stats: {
      'broken-a': makeStats({ totalCount: 12, recentCount: 12, lastUsedAt: ago(120) }),
      'dupe-b': makeStats({ totalCount: 4, recentCount: 4, lastUsedAt: ago(60 * 24 * 6) }),
      'seed-c': makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
      'g-a': makeStats({ totalCount: 2, recentCount: 1, lastUsedAt: ago(60 * 24 * 9) }),
      'u-a': makeStats({ totalCount: 1, recentCount: 1, lastUsedAt: ago(60 * 24 * 12) }),
      'anc-a': makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
    },
  });

  it('Scenario 徽章三型:问题(缺描述)/副本/「内部·未注入」灰标', async () => {
    await renderPage(xray);
    expect(within(row('broken-a')).getByText('缺描述')).toBeInTheDocument();
    expect(within(row('dupe-b')).getByText('副本')).toBeInTheDocument();
    expect(within(row('seed-c')).getByText('内部·未注入')).toBeInTheDocument();
    // 干净技能无徽章
    expect(within(row('g-a')).queryByText('缺描述')).toBeNull();
  });

  it('Scenario 安装位置徽章:scope 主文案(全局/项目)+ 来源副标签 + title=完整路径', async () => {
    await renderPage(xray);
    // 工作区/祖先 → 项目;全局/用户/收集 → 全局。
    expect(posOf('broken-a').scope).toBe('project');
    expect(posOf('broken-a').sub).toBe('工作区');
    expect(posOf('g-a').scope).toBe('global');
    expect(posOf('g-a').sub).toBe('lorra 库');
    expect(posOf('u-a').scope).toBe('global');
    expect(posOf('u-a').sub).toBe('用户');
    expect(posOf('anc-a').scope).toBe('project');
    expect(posOf('anc-a').sub).toBe('祖先');
    // title 属性 = 完整路径（悬停可见）。
    expect(posOf('g-a').title).toBe('C:/Users/t/.lorra/skills/g-a/SKILL.md');
  });

  it('Scenario 收集根技能:scope=global + 副标签「收集库」', async () => {
    await renderPage(
      makeXray({
        skills: [
          makeSkill({
            name: 'col-a',
            source: 'collection',
            filePath: 'E:/collection/col-a/SKILL.md',
          }),
        ],
        stats: { 'col-a': makeStats({ totalCount: 1, recentCount: 1, lastUsedAt: ago(60) }) },
      }),
    );
    expect(posOf('col-a').scope).toBe('global');
    expect(posOf('col-a').sub).toBe('收集库');
    expect(posOf('col-a').title).toBe('E:/collection/col-a/SKILL.md');
  });

  it('Scenario 45 天触发数字(等宽右对齐列)与从未使用高行动信号', async () => {
    await renderPage(xray);
    expect(row('broken-a').textContent).toMatch(/12/); // recentCount
    expect(row('g-a').textContent).toMatch(/1/);
    // totalCount=0:从未使用 + muted 信号文案
    expect(within(row('seed-c')).getByText('从未使用')).toBeInTheDocument();
    expect(within(row('anc-a')).getByText('从未使用')).toBeInTheDocument();
  });

  it('Scenario 开关状态反映 enabled;默认按最后触发倒序(无触发排后)', async () => {
    // 单测排序:给显式 lastUsedAt
    await renderPage(
      makeXray({
        skills: [
          makeSkill({ name: 't2000' }),
          makeSkill({ name: 'never' }),
          makeSkill({ name: 't1500' }),
          makeSkill({ name: 't1000' }),
        ],
        stats: {
          t2000: makeStats({ totalCount: 3, recentCount: 3, lastUsedAt: ago(1000) }),
          t1500: makeStats({ totalCount: 2, recentCount: 2, lastUsedAt: ago(1500) }),
          t1000: makeStats({ totalCount: 1, recentCount: 1, lastUsedAt: ago(2000) }),
          never: makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
        },
      }),
    );
    expect(rows().map((r) => r.getAttribute('data-name'))).toEqual([
      't2000',
      't1500',
      't1000',
      'never',
    ]);
    // 表尾合计行
    const frow = screen.getByTestId('skills-frow');
    expect(frow.textContent).toContain('共 4 个');
  });
});

// =========================================================================
// Scenario 页面数据流:行内开关 → setWsEnabled IPC(本工作区) + 成功后重拉 xray
// =========================================================================

describe('Requirement: 本工作区开关(setWsEnabled IPC)', () => {
  const xray = makeXray({
    skills: [
      makeSkill({ name: 'mmx-cli' }),
      makeSkill({ name: 'off-a', disabledInWs: true }),
    ],
    stats: {
      'mmx-cli': makeStats({ totalCount: 5, recentCount: 5, lastUsedAt: ago(60) }),
      'off-a': makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
    },
  });

  it('Given 本工作区启用(disabledInWs=false) When 点击 Then setWsEnabled(name,false,wsPath) 被调用,成功后重拉 xray 开关变关', async () => {
    const user = userEvent.setup();
    mock.skills.xray
      .mockResolvedValueOnce(okSkills(xray))
      .mockResolvedValue(
        okSkills(
          makeXray({
            skills: [
              makeSkill({ name: 'mmx-cli', disabledInWs: true }),
              makeSkill({ name: 'off-a', disabledInWs: true }),
            ],
            stats: xray.stats,
          }),
        ),
      );
    render(<SkillsPage />);
    await screen.findAllByTestId('skills-hero-card');
    const tg = toggleOf('mmx-cli');
    expect(tg.checked).toBe(true);
    await user.click(tg);
    await waitFor(() =>
      expect(mock.skills.setWsEnabled).toHaveBeenCalledWith('mmx-cli', false, 'E:/ws'),
    );
    // 成功后重拉 xray(第二次调用),disabledInWs=true → 开关变关。
    await waitFor(() => expect(mock.skills.xray).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggleOf('mmx-cli').checked).toBe(false));
  });

  it('Given 本工作区停用(disabledInWs=true) When 点击 Then setWsEnabled(name,true,wsPath) 被调用,成功后开关变开', async () => {
    const user = userEvent.setup();
    mock.skills.xray
      .mockResolvedValueOnce(okSkills(xray))
      .mockResolvedValue(okSkills(makeXray({ skills: [makeSkill({ name: 'off-a' })], stats: xray.stats })));
    render(<SkillsPage />);
    await screen.findAllByTestId('skills-hero-card');
    expect(toggleOf('off-a').checked).toBe(false);
    await user.click(toggleOf('off-a'));
    await waitFor(() =>
      expect(mock.skills.setWsEnabled).toHaveBeenCalledWith('off-a', true, 'E:/ws'),
    );
    await waitFor(() => expect(toggleOf('off-a').checked).toBe(true));
  });

  it('Given setWsEnabled 失败 When 点击 Then 开关状态不变 + 页内动作错误横幅展示 LorraError 文案', async () => {
    const user = userEvent.setup();
    mock.skills.setWsEnabled.mockResolvedValue({
      status: 'error',
      error: { code: 'skills-toggle-failed', message: '本工作区启停写入失败' },
    });
    await renderPage(xray);
    await user.click(toggleOf('mmx-cli'));
    const banner = await screen.findByTestId('skills-action-error');
    expect(banner.textContent).toContain('本工作区启停写入失败');
    expect(toggleOf('mmx-cli').checked).toBe(true); // 状态不变
  });

  it('Requirement 系统管理:systemManaged 技能开关禁用 + tooltip「由系统管理」,点击不触发 IPC', async () => {
    const user = userEvent.setup();
    await renderPage(
      makeXray({
        skills: [makeSkill({ name: 'seed-c', systemManaged: true, enabled: false })],
        stats: { 'seed-c': makeStats() },
      }),
    );
    const tg = toggleOf('seed-c');
    expect(tg).toBeDisabled();
    // radix tooltip:悬停显示「由系统管理」
    await user.hover(tg);
    expect(await screen.findByText('由系统管理', {}, { timeout: 2000 })).toBeInTheDocument();
    await user.click(tg).catch(() => undefined);
    expect(mock.skills.setWsEnabled).not.toHaveBeenCalled();
  });

  it('Requirement 全局隐藏:globallyHidden 技能开关禁用 + tooltip「已全局隐藏」,点击不触发 IPC', async () => {
    const user = userEvent.setup();
    await renderPage(
      makeXray({
        skills: [makeSkill({ name: 'hidden-a', globallyHidden: true })],
        stats: { 'hidden-a': makeStats() },
      }),
    );
    const tg = toggleOf('hidden-a');
    expect(tg).toBeDisabled();
    await user.hover(tg);
    expect(await screen.findByText('已全局隐藏', {}, { timeout: 2000 })).toBeInTheDocument();
    await user.click(tg).catch(() => undefined);
    expect(mock.skills.setWsEnabled).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Requirement: 清理悬空(仅 dangling 非空时出现 → IPC → 成功后刷新)
// =========================================================================

describe('Requirement: 清理悬空', () => {
  it('Given 无悬空 When 页面加载 Then 不渲染「清理悬空」按钮', async () => {
    await renderPage(oneSkillXray());
    expect(screen.queryByTestId('skills-clean-dangling')).toBeNull();
  });

  it('Given 有悬空 When 点击清理 Then cleanDangling(workspacePath) 被调用,成功后重拉 xray,悬空清空后按钮消失', async () => {
    const user = userEvent.setup();
    mock.skills.xray
      .mockResolvedValueOnce(
        okSkills(makeXray({ dangling: ['E:/ws/.lorra/skills/broken'] })),
      )
      .mockResolvedValue(okSkills(makeXray({ dangling: [] })));
    render(<SkillsPage />);
    const btn = await screen.findByTestId('skills-clean-dangling');
    expect(btn).toBeInTheDocument();

    await user.click(btn);
    await waitFor(() =>
      expect(mock.skills.cleanDangling).toHaveBeenCalledWith('E:/ws'),
    );
    // 成功后刷新:第二次 xray,悬空已清 → 按钮消失
    await waitFor(() => expect(mock.skills.xray).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByTestId('skills-clean-dangling')).toBeNull(),
    );
  });

  it('Given 清理失败 When 点击 Then 页内动作错误横幅展示错误', async () => {
    const user = userEvent.setup();
    mock.skills.xray.mockResolvedValue(
      okSkills(makeXray({ dangling: ['E:/ws/.lorra/skills/broken'] })),
    );
    mock.skills.cleanDangling.mockResolvedValue({
      status: 'error',
      error: { code: 'clean-failed', message: '悬空链接清理失败' },
    });
    render(<SkillsPage />);
    await user.click(await screen.findByTestId('skills-clean-dangling'));
    const banner = await screen.findByTestId('skills-action-error');
    expect(banner.textContent).toContain('悬空链接清理失败');
  });
});

// =========================================================================
// Requirement: 编辑 = 仅工作区源技能
// =========================================================================

describe('Requirement: 编辑(仅工作区源)', () => {
  it('Given 工作区源技能 When 点击编辑 Then 调 onOpenFile(filePath) 并切回工作台', async () => {
    const user = userEvent.setup();
    useAppStore.setState({ page: 'skills' });
    const onOpenFile = vi.fn();
    mock.skills.xray.mockResolvedValue(
      okSkills(
        makeXray({
          skills: [makeSkill({ name: 'ws-a' })],
          stats: { 'ws-a': makeStats({ totalCount: 1, recentCount: 1, lastUsedAt: ago(60) }) },
        }),
      ),
    );
    render(<SkillsPage onOpenFile={onOpenFile} />);
    await screen.findAllByTestId('skills-hero-card');
    expect(editOf('ws-a')).not.toBeDisabled();
    await user.click(editOf('ws-a'));
    expect(onOpenFile).toHaveBeenCalledWith('E:/ws/.lorra/skills/ws-a/SKILL.md');
    expect(useAppStore.getState().page).toBe('workspace');
  });

  it('Given 非工作区源技能 When 页面加载 Then 编辑按钮置灰 + tooltip「仅工作区技能可编辑」', async () => {
    mock.skills.xray.mockResolvedValue(
      okSkills(
        makeXray({
          skills: [
            makeSkill({ name: 'g-a', source: 'lorra-global' }),
            makeSkill({ name: 'u-a', source: 'user' }),
            makeSkill({ name: 'anc-a', source: 'ancestor' }),
          ],
          stats: {
            'g-a': makeStats({ totalCount: 1, recentCount: 1, lastUsedAt: ago(60) }),
            'u-a': makeStats({ totalCount: 1, recentCount: 1, lastUsedAt: ago(120) }),
            'anc-a': makeStats({ totalCount: 0, recentCount: 0, lastUsedAt: null }),
          },
        }),
      ),
    );
    render(<SkillsPage />);
    await screen.findAllByTestId('skills-hero-card');
    for (const name of ['g-a', 'u-a', 'anc-a']) {
      expect(editOf(name)).toBeDisabled();
      expect(editOf(name)).toHaveAttribute('title', '仅工作区技能可编辑');
    }
  });
});

// =========================================================================
// Requirement: Git 徽章列(有更新 / 已修改 / 无条目不渲染)
// =========================================================================

describe('Requirement: Git 徽章列', () => {
  const gitSkill = makeSkill({ name: 'git-a' });
  const dirtySkill = makeSkill({ name: 'dirty-b' });
  const plainSkill = makeSkill({ name: 'plain-c' });

  it('Scenario behind → accent 徽章「有更新」;dirty → warn 徽章「已修改」;无条目 → 不渲染', async () => {
    await renderPage(
      makeXray({
        skills: [gitSkill, dirtySkill, plainSkill],
        stats: {
          'git-a': makeStats(),
          'dirty-b': makeStats(),
          'plain-c': makeStats(),
        },
        gitStatus: {
          'git-a': { gitUrl: 'https://github.com/x/git-a', behind: true, dirty: false },
          'dirty-b': { gitUrl: 'https://github.com/x/dirty-b', behind: false, dirty: true },
        },
      }),
    );
    const gitBadges = (name: string): HTMLElement[] =>
      Array.from(row(name).querySelectorAll('[data-testid="skills-git-badge"]'));
    expect(gitBadges('git-a')).toHaveLength(1);
    expect(gitBadges('git-a')[0]).toHaveTextContent('有更新');
    expect(gitBadges('git-a')[0].getAttribute('data-state')).toBe('behind');
    expect(gitBadges('dirty-b')).toHaveLength(1);
    expect(gitBadges('dirty-b')[0]).toHaveTextContent('已修改');
    expect(gitBadges('dirty-b')[0].getAttribute('data-state')).toBe('dirty');
    // 无 gitStatus 条目 → 无徽章。
    expect(gitBadges('plain-c')).toHaveLength(0);
  });
});

// =========================================================================
// Requirement: 详情弹层(点行打开;开关/操作单元格不冒泡)
// =========================================================================

describe('Requirement: 技能详情弹层', () => {
  const detailXray = makeXray({
    skills: [
      makeSkill({
        name: 'detail-a',
        source: 'collection',
        filePath: 'E:/collection/detail-a/SKILL.md',
        issues: [{ code: 'description-too-long', message: '描述超过 1024 字符，仍会全量注入' }],
      }),
      makeSkill({ name: 'ws-b' }),
      makeSkill({ name: 'hidden-c', globallyHidden: true }),
    ],
    stats: {
      'detail-a': makeStats({
        totalCount: 7,
        recentCount: 3,
        lastUsedAt: ago(60),
        byWorkspace: { 'E:/ws-a': 2, 'E:/ws-b': 1 },
      }),
      'ws-b': makeStats({ totalCount: 1, recentCount: 1, lastUsedAt: ago(120) }),
      'hidden-c': makeStats(),
    },
    gitStatus: {
      'detail-a': { gitUrl: 'https://github.com/x/detail-a', behind: true, dirty: false },
    },
  });

  it('Scenario 点行(名称区)打开弹层:标题/路径/描述 SafeMarkdown/健康项/统计分桶/git 块', async () => {
    const user = userEvent.setup();
    await renderPage(detailXray);
    await user.click(within(row('detail-a')).getByText('detail-a'));
    const modal = await screen.findByTestId('skills-detail-modal');
    expect(modal).toBeInTheDocument();
    // 路径 mono 展示
    expect(within(modal).getByTestId('skills-detail-path').textContent).toBe(
      'E:/collection/detail-a/SKILL.md',
    );
    // 描述经 SafeMarkdown 渲染(React 文本,无 dangerouslySetInnerHTML)
    const desc = within(modal).getByTestId('skills-detail-desc');
    expect(desc.textContent).toContain('detail-a 技能描述');
    expect(desc.querySelector('[data-testid="skills-detail-desc"]')).toBeNull();
    // 健康项列表
    expect(within(modal).getByTestId('skills-detail-issues').textContent).toContain(
      '描述超过 1024 字符，仍会全量注入',
    );
    // 统计块:45 天/总次数/工作区分桶
    const stats = within(modal).getByTestId('skills-detail-stats');
    expect(stats.textContent).toContain('3');
    expect(stats.textContent).toContain('7');
    expect(stats.textContent).toContain('ws-a');
    expect(stats.textContent).toContain('ws-b');
    // git 块:gitUrl + 「有更新」徽章
    const git = within(modal).getByTestId('skills-detail-git');
    expect(git.textContent).toContain('https://github.com/x/detail-a');
    expect(git.textContent).toContain('有更新');
  });

  it('Scenario 点开关单元格不冒泡开弹层', async () => {
    const user = userEvent.setup();
    await renderPage(detailXray);
    await user.click(toggleOf('ws-b'));
    expect(screen.queryByTestId('skills-detail-modal')).toBeNull();
    // 开关 IPC 照常触发(不冒泡到行点击);ws-b 本工作区启用 → 点击 = 停用(false)。
    await waitFor(() =>
      expect(mock.skills.setWsEnabled).toHaveBeenCalledWith('ws-b', false, 'E:/ws'),
    );
  });

  it('Scenario 点操作单元格(编辑)不冒泡开弹层', async () => {
    const user = userEvent.setup();
    await renderPage(detailXray);
    await user.click(editOf('ws-b'));
    expect(screen.queryByTestId('skills-detail-modal')).toBeNull();
  });

  it('Scenario 弹层全局隐藏开关:调 setEnabled(name,next),成功后重拉 xray', async () => {
    const user = userEvent.setup();
    mock.skills.xray
      .mockResolvedValueOnce(okSkills(detailXray))
      .mockResolvedValue(okSkills(detailXray));
    render(<SkillsPage />);
    await screen.findAllByTestId('skills-hero-card');
    await user.click(within(row('hidden-c')).getByText('hidden-c'));
    const modal = await screen.findByTestId('skills-detail-modal');
    const hide = within(modal).getByTestId('skills-detail-hide') as HTMLInputElement;
    // hidden-c 已全局隐藏 → 开关开
    expect(hide.checked).toBe(true);
    // 关闭全局隐藏
    await user.click(hide);
    await waitFor(() => expect(mock.skills.setEnabled).toHaveBeenCalledWith('hidden-c', false));
    await waitFor(() => expect(mock.skills.xray).toHaveBeenCalledTimes(2));
  });

  it('Scenario 弹层编辑按钮:仅 workspace 源可点;收集源置灰', async () => {
    const user = userEvent.setup();
    await renderPage(detailXray);
    await user.click(within(row('detail-a')).getByText('detail-a'));
    let modal = await screen.findByTestId('skills-detail-modal');
    expect(within(modal).getByTestId('skills-detail-edit')).toBeDisabled();
    // 关闭后打开 workspace 源
    await user.click(within(modal).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByTestId('skills-detail-modal')).toBeNull());
    await user.click(within(row('ws-b')).getByText('ws-b'));
    modal = await screen.findByTestId('skills-detail-modal');
    expect(within(modal).getByTestId('skills-detail-edit')).not.toBeDisabled();
  });

  it('Scenario 无 git 条目的技能:弹层不渲染 git 块', async () => {
    const user = userEvent.setup();
    await renderPage(detailXray);
    await user.click(within(row('ws-b')).getByText('ws-b'));
    const modal = await screen.findByTestId('skills-detail-modal');
    expect(within(modal).queryByTestId('skills-detail-git')).toBeNull();
  });
});

// =========================================================================
// Requirement: 页头操作(收集散乱技能 / 安装技能 / 检查更新 → 更新 N 个)
// =========================================================================

describe('Requirement: 页头收集 / 安装 / 更新入口', () => {
  it('Scenario 收集散乱技能:collect(wsPath) 被调用,结果提示条展示 移动/建链/冲突/说明', async () => {
    const user = userEvent.setup();
    mock.skills.collect.mockResolvedValue({
      status: 'ok',
      value: {
        moved: 2,
        linked: 1,
        conflicts: ['foo：与原技能内容不同，保留原样'],
        notes: ['bar：平铺文件已收集，原位置无链接'],
      },
    });
    await renderPage(oneSkillXray());
    await user.click(screen.getByTestId('skills-collect'));
    await waitFor(() => expect(mock.skills.collect).toHaveBeenCalledWith('E:/ws'));
    const banner = await screen.findByTestId('skills-collect-result');
    expect(banner.textContent).toContain('已收集 3 个：移动 2 · 建链 1');
    expect(banner.textContent).toContain('foo：与原技能内容不同，保留原样');
    expect(banner.textContent).toContain('bar：平铺文件已收集，原位置无链接');
  });

  it('Scenario 收集失败 → 动作错误横幅', async () => {
    const user = userEvent.setup();
    mock.skills.collect.mockResolvedValue({
      status: 'error',
      error: { code: 'skills-collect-failed', message: '收集失败' },
    });
    await renderPage(oneSkillXray());
    await user.click(screen.getByTestId('skills-collect'));
    const banner = await screen.findByTestId('skills-action-error');
    expect(banner.textContent).toContain('收集失败');
  });

  it('Scenario 检查更新:behind 计数 >0 → 「更新 N 个」按钮出现 → updateAll 调用 → 结果提示条', async () => {
    const user = userEvent.setup();
    mock.skills.checkUpdates.mockResolvedValue({
      status: 'ok',
      value: {
        'git-a': { gitUrl: 'https://github.com/x/a', behind: true, dirty: false },
        'git-b': { gitUrl: 'https://github.com/x/b', behind: true, dirty: false },
        'git-c': { gitUrl: 'https://github.com/x/c', behind: false, dirty: true },
      },
    });
    mock.skills.updateAll.mockResolvedValue({
      status: 'ok',
      value: {
        updated: ['git-a', 'git-b'],
        skipped: ['git-c：本地已修改，跳过'],
      },
    });
    await renderPage(oneSkillXray());
    // 初始无「更新 N 个」按钮
    expect(screen.queryByTestId('skills-update-all')).toBeNull();
    await user.click(screen.getByTestId('skills-check-updates'));
    await waitFor(() => expect(mock.skills.checkUpdates).toHaveBeenCalledTimes(1));
    const updateBtn = await screen.findByTestId('skills-update-all');
    expect(updateBtn.textContent).toContain('更新 2 个');
    await user.click(updateBtn);
    await waitFor(() => expect(mock.skills.updateAll).toHaveBeenCalledTimes(1));
    const result = await screen.findByTestId('skills-update-result');
    expect(result.textContent).toContain('更新成功 2 个，跳过 1 个');
    expect(result.textContent).toContain('git-c：本地已修改，跳过');
  });

  it('Scenario 检查更新失败 → 动作错误横幅', async () => {
    const user = userEvent.setup();
    mock.skills.checkUpdates.mockResolvedValue({
      status: 'error',
      error: { code: 'skills-check-updates-failed', message: '更新检查失败' },
    });
    await renderPage(oneSkillXray());
    await user.click(screen.getByTestId('skills-check-updates'));
    const banner = await screen.findByTestId('skills-action-error');
    expect(banner.textContent).toContain('更新检查失败');
    expect(screen.queryByTestId('skills-update-all')).toBeNull();
  });
});

// =========================================================================
// Requirement: 三态(加载 / 错误 / 空)与错误只影响本页
// =========================================================================

describe('Requirement: 加载态 / 错误态 / 空态', () => {
  it('Scenario 加载态:hero 骨架 + 表格骨架在位(xray pending 时)', async () => {
    // 待决 promise:项目 tsconfig lib=ES2022 无 Promise.withResolvers,沿用仓库
    // 既有 executor 存 resolver 模式(memory-page/composer/diff-card 测试同款)。
    let resolveXray!: (value: unknown) => void;
    mock.skills.xray.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveXray = resolve;
        }),
    );
    render(<SkillsPage />);
    const loading = screen.getByTestId('skills-loading');
    expect(loading).toBeInTheDocument();
    expect(loading.querySelectorAll('.sk-hc')).toHaveLength(5); // hero 骨架 5 卡
    expect(loading.querySelector('.sk-table')).not.toBeNull(); // 表格骨架
    resolveXray(okSkills(oneSkillXray()));
    expect(await screen.findByTestId('skills-table')).toBeInTheDocument();
  });

  it('Scenario 错误态:LorraError 文案 + 重试按钮;重试成功 → 数据恢复', async () => {
    const user = userEvent.setup();
    mock.skills.xray
      .mockResolvedValueOnce(errSkills('skills-index-failed', '技能索引读取失败'))
      .mockResolvedValue(okSkills(oneSkillXray()));
    render(<SkillsPage />);
    const errorBox = await screen.findByTestId('skills-error');
    expect(errorBox).toHaveAttribute('role', 'alert');
    expect(errorBox.textContent).toContain('技能索引读取失败');
    await user.click(within(errorBox).getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('skills-table')).toBeInTheDocument();
    expect(mock.skills.xray).toHaveBeenCalledTimes(2);
  });

  it('Scenario 空态:无技能 → 居中说明 + 引导,不渲染表格', async () => {
    mock.skills.xray.mockResolvedValue(okSkills(makeXray({ skills: [] })));
    render(<SkillsPage />);
    const empty = await screen.findByTestId('skills-empty');
    expect(empty.textContent).toMatch(/(技能|安装)/);
    expect(screen.queryByTestId('skills-table')).toBeNull();
    expect(screen.queryByTestId('skills-hero-card')).toBeNull();
  });
});
