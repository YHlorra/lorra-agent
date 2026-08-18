import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionStatus } from '../../src/shared/agent-events';
import { ChatPane } from '../../src/renderer/chat-pane';
import type { RecordedNotice } from '../../src/renderer/reducer';

interface RenderArgs {
  events: AgentEvent[];
  status?: SessionStatus;
}

function renderChat({ events, status = 'idle' }: RenderArgs) {
  const props = {
    status,
    events,
    modelAvailable: true,
    modelLoading: false,
    defaultModelName: 'test-model',
    inlineError: '',
    onOpenProviders: () => {},
    onSend: () => Promise.resolve(),
    onAbort: () => Promise.resolve(),
  };
  return render(<ChatPane {...props} />);
}

// 构造 AgentEvent。事件 union 字段多,用 unknown cast 后只填关心的字段。
function messageEvent(
  type: 'message.partial' | 'message.final' | 'message.error',
  role: 'user' | 'assistant',
  text: string,
): AgentEvent {
  return {
    type,
    sessionId: 's1',
    eventId: `evt-${type}-${text.length}`,
    seq: 1,
    ts: 1000,
    messageId: 'm1',
    role,
    content: { text },
  } as unknown as AgentEvent;
}

// ---------------------------------------------------------------------------
// markdown 渲染策略:assistant 渲染、user 与 error 保持纯文本
// ---------------------------------------------------------------------------

describe('ChatPane 消息气泡 markdown 渲染策略', () => {
  it('Given assistant 消息含 markdown 标题与代码块 When 渲染 Then 转成语义 HTML（h2 + code）', () => {
    renderChat({
      events: [messageEvent('message.final', 'assistant', '## 标题\n\n```ts\nconst x = 1;\n```')],
    });

    // heading: markdown ## 转 h2
    expect(screen.getByRole('heading', { level: 2, name: '标题' })).toBeInTheDocument();
    // code block: rehype-highlight 把 ```ts 包成 <code class="hljs language-ts">,
    // 内部 token 会拆成 <span> 多个子节点,所以断言 code 元素 + textContent,不用 getByText。
    const codeEl = document.querySelector('.markdown-body code.language-ts');
    expect(codeEl).toBeTruthy();
    expect(codeEl?.textContent).toContain('const x = 1;');
  });

  it('Given assistant 消息含 javascript: 链接 When 渲染 Then 锚点去 href（与 document-viewer 共用消毒）', () => {
    renderChat({
      events: [messageEvent('message.final', 'assistant', '[点我](javascript:alert(1))')],
    });

    const link = screen.getByText('点我');
    expect(link.tagName).toBe('A');
    expect(link).not.toHaveAttribute('href');
  });

  it('Given assistant 消息含 GFM 表格 When 渲染 Then 转成语义 table（remark-gfm 必须启用）', () => {
    renderChat({
      events: [
        messageEvent(
          'message.final',
          'assistant',
          '| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |',
        ),
      ],
    });

    // chat 变体缺 remark-gfm 时表格会退化成纯文本 —— 该断言曾因此失败(2026-08-07 修复)。
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(screen.getByText('甲')).toBeInTheDocument();
    expect(screen.getByText('乙')).toBeInTheDocument();
  });

  it('Given assistant 消息含 GFM 表格 When 渲染 Then 表格被 .md-table-wrap 包裹(内部滚动,不撑破对话列)', () => {
    renderChat({
      events: [
        messageEvent(
          'message.final',
          'assistant',
          '| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |',
        ),
      ],
    });

    const table = screen.getByRole('table');
    expect(table.closest('.md-table-wrap')).not.toBeNull();
    expect(table.closest('.chat-stream')).not.toBeNull();
  });

  it('Given user 消息含 markdown 字符 When 渲染 Then 保持纯文本（不渲染成 h2）', () => {
    renderChat({
      events: [messageEvent('message.final', 'user', '## 我手写 ## 当标题')],
    });

    // user 输入不渲染 markdown:不出现 h2
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    // 原文作为文本节点保留
    expect(screen.getByText('## 我手写 ## 当标题')).toBeInTheDocument();
  });

  it('Given message.error 含尖括号字符 When 渲染 Then 保持纯文本', () => {
    renderChat({
      events: [messageEvent('message.error', 'assistant', 'Error at <anonymous>')],
    });

    // 错误信息强制 plain:不渲染 markdown,文本节点原样
    expect(screen.getByText('Error at <anonymous>')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('Given assistant 消息是流式 partial When 渲染 Then 同样走 markdown 路径（与 final 一致）', () => {
    renderChat({
      events: [messageEvent('message.partial', 'assistant', '# 流式中')],
    });

    // 流式 partial 也渲染 markdown,避免「partial 纯文本 / final 富文本」视觉跳变
    expect(screen.getByRole('heading', { level: 1, name: '流式中' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 非消息类事件走原路径:thinking → ThinkingCard、tool.* → ToolCard、session.* → null
// ---------------------------------------------------------------------------

describe('ChatPane 非消息事件路由', () => {
  it('Given thinking.partial When 渲染 Then 走 ThinkingCard（默认展开,流式全文可见）', () => {
    const thinking: AgentEvent = {
      type: 'thinking.partial',
      sessionId: 's1',
      eventId: 't1',
      seq: 1,
      ts: 1000,
      messageId: 'm1',
      role: 'assistant',
      content: { thinking: '## 这是思考' },
    } as unknown as AgentEvent;
    renderChat({ events: [thinking] });

    // ThinkingCard 默认展开(thinking-card.test 钉死):流式全文直接可见,
    // markdown 结构正常渲染(标题出现),非干标题。
    expect(screen.getByRole('heading', { level: 2, name: '这是思考' })).toBeInTheDocument();
    // 摘要仍可见:「思考」label + 「思考中」状态
    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.getByText('思考中')).toBeInTheDocument();
  });

  it('Given tool.end When 渲染 Then 走 ToolCard(presentational,默认无安全 note)', () => {
    const toolEnd: AgentEvent = {
      type: 'tool.end',
      sessionId: 's1',
      eventId: 't2',
      seq: 2,
      ts: 2000,
      toolName: 'read',
      target: '/tmp/foo',
      callId: 'call-1',
      result: '文件内容',
      ok: true,
    } as unknown as AgentEvent;
    renderChat({ events: [toolEnd] });

    // ToolCard 自身显示工具名 + 目标 + 结果,具体契约由 tool-card.test 覆盖。
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('/tmp/foo')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 多轮完整循环(补锁):send→thinking→tool→stream→final 同序列渲染
// 真实时序由 reducer 保证(message/thinking 同 messageId 不互覆盖、tool 流按
// callId 关联),此处只断言 ChatRow 把这些事件都映射到对应组件。
// ---------------------------------------------------------------------------

describe('ChatPane 多轮完整循环', () => {
  it('Given 完整两轮事件流(user → thinking → tool → answer × 2) When 渲染 Then thinking/tool/message 全部就位且无重复', () => {
    // partial/final 替换是 reducer 的职责(见 tests/integration/chat-flow.integration.test.ts);
    // ChatPane 只见 dedup 后的最终事件,所以这里只放 final。
    const events: AgentEvent[] = [
      // --- 第 1 轮 ---
      messageEvent('message.final', 'user', '帮我看 foo.ts'),
      {
        type: 'thinking.final',
        sessionId: 's1',
        eventId: 't-final',
        seq: 2,
        ts: 2000,
        messageId: 'm1',
        role: 'assistant',
        content: { thinking: '先想一下再动手' },
      } as unknown as AgentEvent,
      {
        type: 'tool.start',
        sessionId: 's1',
        eventId: 'ts-1',
        seq: 3,
        ts: 3000,
        toolName: 'read',
        target: 'foo.ts',
        callId: 'call-A',
      } as unknown as AgentEvent,
      {
        type: 'tool.end',
        sessionId: 's1',
        eventId: 'te-1',
        seq: 4,
        ts: 4000,
        toolName: 'read',
        target: 'foo.ts',
        callId: 'call-A',
        result: '文件内容',
        ok: true,
      } as unknown as AgentEvent,
      messageEvent('message.final', 'assistant', '## 答案\n\n在第 40 行'),
      // --- 第 2 轮:用户追问 + 直接回答 ---
      messageEvent('message.final', 'user', '那如果空数组呢？'),
      messageEvent('message.final', 'assistant', '空数组会跳过循环。'),
    ];
    renderChat({ events });

    // 两轮用户消息各自出现
    expect(screen.getByText('帮我看 foo.ts')).toBeInTheDocument();
    expect(screen.getByText('那如果空数组呢？')).toBeInTheDocument();
    // 思考卡片:仅 1 个(thinking.final 已被 reducer dedup),summary 可见
    expect(screen.getByText('思考')).toBeInTheDocument();
    // 「已完成」同时出现在 ThinkingCard 状态(思考完成)与 ToolCard 状态
    // (工具 ok),所以断言数量而非精确等于 1。
    expect(screen.getAllByText('已完成').length).toBeGreaterThanOrEqual(1);
    // 工具卡片(presentational):tool.start + tool.end 共享 toolName/target,
    // 「read」/「foo.ts」会各出现在两张卡片中。
    expect(screen.getAllByText('read').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('foo.ts').length).toBeGreaterThanOrEqual(1);
    // AI 最终回答:markdown 渲染,h2 出现(普通回答不渲染 markdown)
    expect(screen.getByRole('heading', { level: 2, name: '答案' })).toBeInTheDocument();
    // 第二轮纯文本回答(user + assistant)
    expect(screen.getByText('空数组会跳过循环。')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// thinkingRedacted 占位文案:thinking 文本为空但被策略脱敏时,
// 用户展开详情应看到脱敏提示,看不到原始思考(原始本就不存在)。
// ---------------------------------------------------------------------------

describe('ChatPane thinkingRedacted 占位', () => {
  it('Given thinking.final 为空 + thinkingRedacted=true When 渲染 Then 默认展开即显示脱敏占位文案', () => {
    const thinkingFinal: AgentEvent = {
      type: 'thinking.final',
      sessionId: 's1',
      eventId: 't-redacted',
      seq: 1,
      ts: 1000,
      messageId: 'm-redacted',
      role: 'assistant',
      content: { thinking: '' },
      thinkingRedacted: true,
    } as unknown as AgentEvent;
    renderChat({ events: [thinkingFinal] });

    // ThinkingCard 默认展开(thinking-card.test 钉死):脱敏占位文案直接可见,
    // 且无任何「原始思考」文本节点。
    expect(screen.getByText('（思考内容已被安全策略折叠）')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// tool.blocked 安全 note 渲染:安全拦截器阻断的工具,
// 在右栏必须可观测(用户要知道 AI 想做这事但被拦了)。
// ---------------------------------------------------------------------------

describe('ChatPane tool.blocked 安全 note', () => {
  it('Given tool.blocked 事件 When 渲染 Then ToolCard 显示已阻断徽章 + 折叠时含 safetyNote', () => {
    const blocked: AgentEvent = {
      type: 'tool.blocked',
      sessionId: 's1',
      eventId: 'tb-1',
      seq: 1,
      ts: 1000,
      toolName: 'write_file',
      target: '/etc/passwd',
      callId: 'call-blocked',
      safetyNote: 'path-out-of-workspace',
    } as unknown as AgentEvent;
    renderChat({ events: [blocked] });

    // 「已阻断」徽章出现,常规 status 文案「进行中/已完成/失败」不出现
    expect(screen.getByText('已阻断')).toBeInTheDocument();
    expect(screen.queryByText('进行中')).toBeNull();
    expect(screen.queryByText('已完成')).toBeNull();
    expect(screen.queryByText('失败')).toBeNull();

    // 工具名 + 目标仍可见
    expect(screen.getByText('write_file')).toBeInTheDocument();
    expect(screen.getByText('/etc/passwd')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// update_plan 计划卡(搜索编排):tool.start/end 带合法 plan args 时
// 渲染 PlanCard;args 非法时回退通用 ToolCard(防御 SDK 参数形状变化)。
// ---------------------------------------------------------------------------

describe('ChatPane update_plan 计划卡', () => {
  it('Given tool.start(update_plan, 3 步含 1 个 in_progress) When 渲染 Then 计划卡:标题 + 步骤文本 + 状态标记', () => {
    const planStart: AgentEvent = {
      type: 'tool.start',
      sessionId: 's1',
      eventId: 'tp-1',
      seq: 1,
      ts: 1000,
      toolName: 'update_plan',
      target: 'update_plan',
      callId: 'call-plan',
      args: {
        explanation: '先规划再调研',
        plan: [
          { step: '搜索资料', status: 'in_progress' },
          { step: '阅读文章', status: 'pending' },
          { step: '写成报告', status: 'pending' },
        ],
      },
    } as unknown as AgentEvent;
    renderChat({ events: [planStart] });

    expect(screen.getByText('任务计划')).toBeInTheDocument();
    expect(screen.getByText('先规划再调研')).toBeInTheDocument();
    expect(screen.getByText('搜索资料')).toBeInTheDocument();
    expect(screen.getByText('阅读文章')).toBeInTheDocument();
    expect(screen.getByText('写成报告')).toBeInTheDocument();
    // 恰好 1 个「进行中」标记 + 2 个「待开始」(状态徽标 aria-label)
    expect(screen.getByLabelText('进行中')).toBeInTheDocument();
    expect(screen.getAllByLabelText('待开始')).toHaveLength(2);
  });

  it('Given tool.end(update_plan, 含 explanation + completed 步骤) When 渲染 Then explanation 与 ✓ 标记出现', () => {
    const planEnd: AgentEvent = {
      type: 'tool.end',
      sessionId: 's1',
      eventId: 'tp-2',
      seq: 2,
      ts: 2000,
      toolName: 'update_plan',
      target: 'update_plan',
      callId: 'call-plan',
      result: '{"plan":[]}',
      ok: true,
      args: {
        explanation: '第一步已完成',
        plan: [
          { step: '搜索资料', status: 'completed' },
          { step: '阅读文章', status: 'in_progress' },
        ],
      },
    } as unknown as AgentEvent;
    renderChat({ events: [planEnd] });

    expect(screen.getByText('第一步已完成')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
    expect(screen.getByLabelText('已完成')).toBeInTheDocument();
  });

  it('Given tool.end(update_plan, args 非法——plan 缺字段) When 渲染 Then 回退通用 ToolCard', () => {
    const badPlan: AgentEvent = {
      type: 'tool.end',
      sessionId: 's1',
      eventId: 'tp-3',
      seq: 3,
      ts: 3000,
      toolName: 'update_plan',
      target: 'update_plan',
      callId: 'call-plan',
      result: 'x',
      ok: true,
      args: { plan: [{ step: '缺少 status 字段' }] },
    } as unknown as AgentEvent;
    renderChat({ events: [badPlan] });

    // 回退 ToolCard:工具名出现,「任务计划」标题不出现
    expect(screen.getAllByText('update_plan').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('任务计划')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 消息内联连续流(2026-08-10):思考段/工具调用按事件序内联在消息流中,
// 无活动条分组;blocked/error/计划行默认展开保证原因可见。
// ---------------------------------------------------------------------------

describe('ChatPane 内联连续流', () => {
  function toolStartEvent(
    toolName: string,
    callId: string,
    eventId: string,
    ts = 1000,
  ): AgentEvent {
    return {
      type: 'tool.start',
      sessionId: 's1',
      eventId,
      seq: 1,
      ts,
      toolName,
      target: `${toolName}.md`,
      callId,
    } as unknown as AgentEvent;
  }

  function toolEndEvent(
    toolName: string,
    callId: string,
    eventId: string,
    ts = 1000,
  ): AgentEvent {
    return {
      type: 'tool.end',
      sessionId: 's1',
      eventId,
      seq: 1,
      ts,
      toolName,
      target: `${toolName}.md`,
      callId,
      result: '内容',
      ok: true,
    } as unknown as AgentEvent;
  }

  it('Given 同一轮 2 个不同工具(含 thinking) When 渲染 Then 思考/工具内联成行,无活动条', () => {
    const events: AgentEvent[] = [
      {
        type: 'thinking.final',
        sessionId: 's1',
        eventId: 't1',
        seq: 1,
        ts: 1000,
        messageId: 'm1',
        role: 'assistant',
        content: { thinking: '先看看' },
      } as unknown as AgentEvent,
      toolStartEvent('read', 'call-A', 'ts1'),
      toolEndEvent('read', 'call-A', 'te1'),
      toolStartEvent('write', 'call-B', 'ts2'),
      toolEndEvent('write', 'call-B', 'te2'),
    ];
    renderChat({ events });

    // 无活动条分组:思考段与工具行直接内联在消息流
    expect(document.querySelectorAll('.activity-strip')).toHaveLength(0);
    expect(document.querySelectorAll('.thinking-event')).toHaveLength(1);
    expect(document.querySelectorAll('.tool-event')).toHaveLength(2);
    // 顺序 = 事件序:思考段在前,两个工具按 start 序
    const stream = Array.from(document.querySelectorAll('.thinking-event, .tool-event'));
    expect(stream.map((el) => el.className)).toEqual([
      expect.stringContaining('thinking-event'),
      expect.stringContaining('tool-event'),
      expect.stringContaining('tool-event'),
    ]);
    // 头部摘要消失:无「N 个工具 · M 段思考」计数
    expect(screen.queryByText('2 个工具 · 1 段思考')).not.toBeInTheDocument();
  });

  it('Given 思考+工具流 When 渲染 Then 默认全部可见(无组级折叠),各自行可独立展开', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderChat({
      events: [toolStartEvent('read', 'call-A', 'ts1'), toolEndEvent('read', 'call-A', 'te1')],
    });

    // 工具行直接可见(无活动条包裹)
    expect(document.querySelectorAll('.tool-event')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /read/ })).toBeInTheDocument();
    // 折叠语义仍在行级:summary 可展开 detail
    await user.click(screen.getByRole('button', { name: /read/ }));
    expect(screen.getByText('内容')).toBeInTheDocument();
  });

  it('Given 思考段带时长 When 渲染 Then 思考行显示思考 · N秒(无整轮组头)', () => {
    renderChat({
      events: [
        {
          type: 'thinking.final',
          sessionId: 's1',
          eventId: 't1',
          seq: 1,
          ts: 1000,
          messageId: 'm1',
          role: 'assistant',
          content: { thinking: '先看看' },
        } as unknown as AgentEvent,
        toolStartEvent('read', 'call-A', 'ts1', 1000),
        toolEndEvent('read', 'call-A', 'te1', 206000),
      ],
    });

    // 思考行自带时长(直传路径:final.ts - partial?无 partial → 0 → 无时长)。
    // 工具行正常内联;「执行过程 · 3分25秒」组头已随活动条移除。
    expect(screen.getByRole('button', { name: /思考/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /read/ })).toBeInTheDocument();
    expect(screen.queryByText(/3分25秒/)).not.toBeInTheDocument();
  });

  it('Given tool.blocked When 渲染 Then blocked 行默认展开且 safetyNote 可见()', () => {
    const blocked: AgentEvent = {
      type: 'tool.blocked',
      sessionId: 's1',
      eventId: 'tb-1',
      seq: 1,
      ts: 1000,
      toolName: 'write_file',
      target: '/etc/passwd',
      callId: 'call-blocked',
      safetyNote: 'path-out-of-workspace',
    } as unknown as AgentEvent;
    renderChat({ events: [blocked] });

    expect(document.querySelectorAll('.tool-event')).toHaveLength(1);
    // 默认展开:阻断原因直接可见,无需再点击
    expect(screen.getByText('path-out-of-workspace')).toBeInTheDocument();
    expect(screen.getByText('已阻断')).toBeInTheDocument();
  });

  it('Given update_plan When 渲染 Then 计划行默认展开、步骤文本可见', () => {
    const planStart: AgentEvent = {
      type: 'tool.start',
      sessionId: 's1',
      eventId: 'tp-1',
      seq: 1,
      ts: 1000,
      toolName: 'update_plan',
      target: 'update_plan',
      callId: 'call-plan',
      args: {
        plan: [
          { step: '搜索资料', status: 'in_progress' },
          { step: '写成报告', status: 'pending' },
        ],
      },
    } as unknown as AgentEvent;
    renderChat({ events: [planStart] });

    // 工具行 + 计划卡(plan-card 根元素自带 tool-event 类,与工具行区分计数)
    expect(document.querySelectorAll('.tool-event.tool-card-status-running')).toHaveLength(1);
    expect(document.querySelectorAll('.plan-card')).toHaveLength(1);
    // 默认展开:计划步骤直接可见
    expect(screen.getByText('搜索资料')).toBeInTheDocument();
    expect(screen.getByText('写成报告')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6.13 用户结晶「记住这段」+ 复制:助手消息底部按钮行(常驻,紧贴气泡下方),
// 点击调 window.lorra.memory.crystallize(content=消息文本, title=首行截断)。
// 成功 → 轻提示「已存入待确认记忆」;失败 → 错误提示;空消息 → 无按钮行。
// ---------------------------------------------------------------------------

describe('ChatPane 助手消息底部按钮行(复制 + 记住这段)', () => {
  const crystallizeMock = vi.fn();
  // test-setup 的 window.lorra stub 无 memory 桥;这里整体替换(属性 writable+configurable)。
  const originalLorra = window.lorra;

  function renderWithMemory(events: AgentEvent[]) {
    Object.defineProperty(window, 'lorra', {
      value: { ...originalLorra, memory: { crystallize: crystallizeMock } },
      writable: true,
      configurable: true,
    });
    return renderChat({ events });
  }

  beforeEach(() => {
    crystallizeMock.mockReset();
    crystallizeMock.mockResolvedValue({ ok: true, value: { entryId: 'e1' } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'lorra', {
      value: originalLorra,
      writable: true,
      configurable: true,
    });
  });

  it('助手消息常驻「复制这条回复」+「记住这段」;user 消息恒无', () => {
    renderWithMemory([
      messageEvent('message.final', 'user', '用户提问'),
      messageEvent('message.final', 'assistant', '这是需要记住的要点'),
    ]);

    // 无需 hover,按钮行常驻气泡下方。
    const assistantActions = document.querySelector('.message.assistant .message-actions')!;
    expect(
      within(assistantActions as HTMLElement).getByRole('button', { name: '复制这条回复' }),
    ).toBeInTheDocument();
    expect(
      within(assistantActions as HTMLElement).getByRole('button', { name: '记住这段' }),
    ).toBeInTheDocument();
    // user 消息无按钮行。
    expect(document.querySelector('.message.user .message-actions')).toBeNull();
  });

  it('点击「复制这条回复」→ 该条助手消息文本进剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const text = '这条回复需要复制';
    renderWithMemory([messageEvent('message.final', 'assistant', text)]);

    fireEvent.click(screen.getByRole('button', { name: '复制这条回复' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  });

  it('点击「记住这段」→ 调 crystallize(content=消息文本, title=首行截断);成功 → 轻提示', async () => {
    const multiLine = '第一行标题内容\n第二行细节';
    renderWithMemory([messageEvent('message.final', 'assistant', multiLine)]);

    fireEvent.click(screen.getByRole('button', { name: '记住这段' }));

    expect(crystallizeMock).toHaveBeenCalledTimes(1);
    expect(crystallizeMock).toHaveBeenCalledWith({ content: multiLine, title: '第一行标题内容' });
    expect(await screen.findByText('已记入记忆库')).toBeInTheDocument();
  });

  it('结晶失败(content-too-long)→ 错误提示', async () => {
    crystallizeMock.mockResolvedValue({
      ok: false,
      error: { code: 'content-too-long', message: 'content exceeds 2048 bytes' },
    });
    renderWithMemory([messageEvent('message.final', 'assistant', '超长内容')]);

    fireEvent.click(screen.getByRole('button', { name: '记住这段' }));

    expect(await screen.findByText(/保存失败/)).toBeInTheDocument();
    expect(screen.getByText(/content exceeds 2048 bytes/)).toBeInTheDocument();
    expect(screen.queryByText('已记入记忆库')).toBeNull();
  });

  it('空消息(assistant 无文本)→ 无按钮行', () => {
    renderWithMemory([messageEvent('message.final', 'assistant', '')]);
    expect(screen.queryByRole('button', { name: '记住这段' })).toBeNull();
    expect(screen.queryByRole('button', { name: '复制这条回复' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 发送后「对话框移到最新」(2026-08-09 UX 调整):用户消息落流时 chat-stream
// 平滑滚动到底部;assistant 消息(流式回答)不打断用户回读上文的滚动位置。
// ---------------------------------------------------------------------------

describe('ChatPane 发送后滚动到最新', () => {
  it('Given 末位事件是用户消息 When 渲染 Then chat-stream 滚动到底部', () => {
    const scrollSpy = vi
      .spyOn(Element.prototype, 'scrollTo')
      .mockImplementation(() => {});
    renderChat({
      events: [messageEvent('message.final', 'user', '帮我查一下')],
    });

    const stream = document.querySelector('.chat-stream');
    expect(stream).not.toBeNull();
    expect(scrollSpy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth' }),
    );
    scrollSpy.mockRestore();
  });

  it('Given 末位事件是 assistant 消息 When 渲染 Then 不触发滚动', () => {
    const scrollSpy = vi
      .spyOn(Element.prototype, 'scrollTo')
      .mockImplementation(() => {});
    renderChat({
      events: [messageEvent('message.final', 'assistant', '正在回答')],
    });

    expect(scrollSpy).not.toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  it('Given 会话恢复(空→首条历史事件) When 渲染后 300ms Then chat-stream 锚定到底部', () => {
    vi.useFakeTimers();
    const { container } = renderChat({
      events: [messageEvent('message.final', 'assistant', '历史回复')],
    });
    const stream = container.querySelector('.chat-stream')!;
    Object.defineProperty(stream, 'scrollHeight', { value: 2400, configurable: true });
    Object.defineProperty(stream, 'clientHeight', { value: 340, configurable: true });

    expect(stream.scrollTop).toBe(0);
    vi.advanceTimersByTime(300);
    expect(stream.scrollTop).toBe(2400);
    vi.useRealTimers();
  });

  it('Given 恢复落底后追加 assistant 事件 When 渲染 Then 不移动滚动位置(流式回读不打断)', () => {
    vi.useFakeTimers();
    const scrollSpy = vi
      .spyOn(Element.prototype, 'scrollTo')
      .mockImplementation(() => {});
    const first = [messageEvent('message.final', 'user', '帮我查一下')];
    const { rerender, container } = renderChat({ events: first });
    const stream = container.querySelector('.chat-stream')!;
    Object.defineProperty(stream, 'scrollHeight', { value: 2400, configurable: true });
    Object.defineProperty(stream, 'clientHeight', { value: 340, configurable: true });
    vi.advanceTimersByTime(300);
    expect(stream.scrollTop).toBe(2400);

    // 流式追加 assistant 消息:不触发任何 scrollTo,位置保持在落底处。
    scrollSpy.mockClear();
    rerender(
      <ChatPane
        status="streaming"
        events={[...first, messageEvent('message.final', 'assistant', '流式回答')]}
        modelAvailable
        modelLoading={false}
        defaultModelName="test-model"
        inlineError=""
        onOpenProviders={() => {}}
        onSend={() => Promise.resolve()}
        onAbort={() => Promise.resolve()}
      />,
    );
    vi.advanceTimersByTime(2000);
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(stream.scrollTop).toBe(2400);
    scrollSpy.mockRestore();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 1.6 memory.recorded 只读通知条:标题 + 类别/证据徽标,无按钮,
// 自动消退(超时逐条 dismiss)或保留至下一事件
// ---------------------------------------------------------------------------

describe('ChatPane memory.recorded 只读通知条', () => {
  const dismiss = vi.fn();

  function renderWithNotices(notices: RecordedNotice[]): ReturnType<typeof render> {
    return render(
      <ChatPane
        status="idle"
        events={[]}
        modelAvailable
        modelLoading={false}
        defaultModelName="test-model"
        inlineError=""
        onOpenProviders={() => {}}
        onSend={() => Promise.resolve()}
        onAbort={() => Promise.resolve()}
        recordedNotices={notices}
        onMemoryNoticeDismissed={dismiss}
      />,
    );
  }

  beforeEach(() => {
    dismiss.mockReset();
  });

  it('memory.recorded → 通知条渲染标题 + 类别/证据徽标', () => {
    renderWithNotices([
      { entryId: 'e1', title: '禁删根目录', kind: 'hard_policy', evidence: 'user-stated' },
    ]);
    const list = screen.getByTestId('memory-notice-list');
    const notice = within(list).getByTestId('memory-notice');
    expect(notice).toHaveAttribute('data-entry-id', 'e1');
    expect(within(notice).getByText('禁删根目录')).toBeInTheDocument();
    expect(within(notice).getByText('硬性规则')).toBeInTheDocument();
    expect(within(notice).getByText('你明说的')).toBeInTheDocument();
  });

  it('通知条无任何按钮(确认/编辑/拒绝/忽略已移除)', () => {
    renderWithNotices([
      { entryId: 'e1', title: '标题', kind: 'knowledge', evidence: 'inferred' },
    ]);
    const notice = screen.getByTestId('memory-notice');
    expect(notice.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /确认|编辑|拒绝|忽略/ })).toBeNull();
  });

  it('多条通知 → 各自渲染,互不覆盖', () => {
    renderWithNotices([
      { entryId: 'e1', title: '第一条', kind: 'hard_policy', evidence: 'user-stated' },
      { entryId: 'e2', title: '第二条', kind: 'knowledge', evidence: 'extracted' },
    ]);
    expect(screen.getAllByTestId('memory-notice')).toHaveLength(2);
    expect(screen.getByText('第一条')).toBeInTheDocument();
    expect(screen.getByText('第二条')).toBeInTheDocument();
  });

  it('自动消退:超时后逐条调 onMemoryNoticeDismissed(entryId)', () => {
    vi.useFakeTimers();
    try {
      renderWithNotices([
        { entryId: 'e1', title: '一', kind: 'hard_policy', evidence: 'user-stated' },
        { entryId: 'e2', title: '二', kind: 'knowledge', evidence: 'extracted' },
      ]);
      expect(dismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(6000);
      expect(dismiss).toHaveBeenCalledTimes(2);
      expect(dismiss).toHaveBeenCalledWith('e1');
      expect(dismiss).toHaveBeenCalledWith('e2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('无 recordedNotices → 不渲染通知条', () => {
    renderChat({ events: [] });
    expect(screen.queryByTestId('memory-notice-list')).toBeNull();
  });
});
// ---------------------------------------------------------------------------
// 新建 Agent 对话按钮接线(2026-08-09 走查修复):header「新建 Agent 对话」按钮
// 曾是无 onClick 的死按钮——PM 走查触点①(新会话首问)依赖此入口,必须触发
// onCreateSession。hero「开始新对话」经命令通道已通,此处钉死按钮接线防回归。
// ---------------------------------------------------------------------------

describe('ChatPane 新建 Agent 对话按钮', () => {
  it('Given 点击 header「新建 Agent 对话」When 传了 onCreateSession Then 回调被调用', () => {
    const onCreateSession = vi.fn();
    const props = {
      status: 'idle' as SessionStatus,
      events: [] as AgentEvent[],
      modelAvailable: true,
      modelLoading: false,
      defaultModelName: 'test-model',
      inlineError: '',
      onOpenProviders: () => {},
      onSend: () => Promise.resolve(),
      onAbort: () => Promise.resolve(),
      onCreateSession,
    };
    render(<ChatPane {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '新建 Agent 对话' }));
    expect(onCreateSession).toHaveBeenCalledTimes(1);
  });

  it('Given 未传 onCreateSession When 点击 Then 不抛错(空态/旧调用方兼容)', () => {
    renderChat({ events: [] });
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: '新建 Agent 对话' })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 模型不可用提示(2026-08-18 修复):空会话无模型时 chat-empty-cta 已传达同一
// 信息,底部 banner 不重复渲染;会话已有事件后模型失联 → banner 出现。
// ---------------------------------------------------------------------------

describe('ChatPane 模型不可用提示', () => {
  function renderModelOff(events: AgentEvent[]): RenderResult {
    return render(
      <ChatPane
        status="idle"
        events={events}
        modelAvailable={false}
        modelLoading={false}
        defaultModelName={null}
        inlineError=""
        onOpenProviders={() => {}}
        onSend={() => Promise.resolve()}
        onAbort={() => Promise.resolve()}
      />,
    );
  }

  it('空会话 + 无模型 → 显示空 CTA,不渲染底部 banner(消除重复提示)', () => {
    renderModelOff([]);
    expect(screen.getByText('暂无可用模型，连接一个供应商开始对话。')).toBeInTheDocument();
    expect(screen.queryByText('模型暂不可用')).toBeNull();
  });

  it('已有会话事件 + 无模型 → 渲染底部 banner(CTA 已消失)', () => {
    renderModelOff([messageEvent('message.final', 'user', '继续')]);
    expect(screen.getByText('模型暂不可用')).toBeInTheDocument();
    expect(screen.getByText('请检查模型连接或账户配置，工作区仍可继续使用。')).toBeInTheDocument();
    expect(screen.queryByText('暂无可用模型，连接一个供应商开始对话。')).toBeNull();
  });
});
