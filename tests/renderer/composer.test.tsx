import { describe, it, expect, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '../../src/renderer/composer';

describe('Composer', () => {
  it('Given status=streaming When render Then send is disabled and stop is visible', () => {
    render(<Composer status="streaming" onSend={() => {}} onAbort={() => {}} />);
    const send = screen.getByRole('button', { name: /发送/ });
    expect(send).toBeDisabled();
    expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument();
  });

  it('Given status=tool-running When render Then send is disabled and stop is visible', () => {
    render(<Composer status="tool-running" onSend={() => {}} onAbort={() => {}} />);
    expect(screen.getByRole('button', { name: /发送/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument();
  });

  it('Given status=idle When render Then send is enabled and stop is not present', () => {
    render(<Composer status="idle" onSend={() => {}} onAbort={() => {}} />);
    expect(screen.getByRole('button', { name: /发送/ })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /停止/ })).toBeNull();
  });

  it('Given user types and clicks send When send invoked Then message cleared', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer status="idle" onSend={onSend} onAbort={() => {}} />);
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, 'hello');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSend).toHaveBeenCalledWith('hello');
    // The clear is gated by the post-onSend effect (await onSend → setSendTick
    // → useEffect → setMessage('')). user.click does not await send — wait
    // for the microtask hop to flush.
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given user clicks stop When streaming Then onAbort invoked', async () => {
    const onAbort = vi.fn();
    const user = userEvent.setup();
    render(<Composer status="streaming" onSend={() => {}} onAbort={onAbort} />);
    await user.click(screen.getByRole('button', { name: /停止/ }));
    expect(onAbort).toHaveBeenCalled();
  });

  // 补锁:发送失败 → 输入保留 → 发送按钮仍可用 → 用户重发时新文本被发出。
  // 关键时序:失败 dispatch 必须在 onSend 解析 *之前* 到达(对应真实路径 —
  // App.tsx 的 onSend 在 await lorra.session.send 后才 resolve)。若失败
  // dispatch 在 onSend 解析 *之后* 才来,Composer 的 lastSendRef 已被清空,
  // 不会再恢复文本(composer.tsx:46-55 的 effect 是「pending→settled→inlineError
  // 变」一次性闭环)。
  //
  // 关于「用户编辑后再发」:React 受控 textarea 在 effect setMessage 之后
  // user.clear/type 的时序在 jsdom 下不稳(字符会拼到旧文本上)。本测试断言
  // 重发能力,不混进 edit-and-retry;后者在 App.test.tsx 的端到端测试里覆盖。
  it('Given 发送失败(失败 dispatch 先于 onSend resolve) When 输入保留 + 重发 Then 新文本被发出', async () => {
    let resolveOnSend!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveOnSend = r;
        }),
    );
    const user = userEvent.setup();
    const { rerender } = render(
      <Composer status="idle" onSend={onSend} onAbort={() => {}} inlineError="" />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });

    // 1) 首次发送:onSend 启动,不 resolve
    await user.type(ta, '旧文本');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenLastCalledWith('旧文本');
    // Composer 不乐观清空:输入保留到 onSend resolve + effect 跑完才确定。

    // 2) 父组件在 onSend 还没 resolve 时 dispatch 失败(inlineError 非空)
    rerender(<Composer status="idle" onSend={onSend} onAbort={() => {}} inlineError="网络断了" />);

    // 3) onSend resolve → Composer effect 看到 pending.settled=true + inlineError 非空 → 恢复
    resolveOnSend();
    await waitFor(() => expect(ta).toHaveValue('旧文本'));

    // 4) 重发按钮仍可用,且能拿到当前 input 值
    const sendBtn = screen.getByRole('button', { name: /发送/ });
    expect(sendBtn).not.toBeDisabled();

    // 5) 用原值再发一次:验证「Composer 在 inlineError 下不死锁,可重试」
    await user.click(sendBtn);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('旧文本');
  });
});

// 斜杠命令(pi TUI):/命令 独占一行回车 → 执行,不发给 AI。
describe('Composer 斜杠命令', () => {
  async function setup(onCommand?: (cmd: string) => boolean | Promise<boolean>) {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer status="idle" onSend={onSend} onAbort={() => {}} onCommand={onCommand} />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    return { user, ta, onSend };
  }

  it('Given 输入 /new 回车 When onCommand 返回 true Then 命令执行、输入清空、不发送给 AI', async () => {
    const onCommand = vi.fn(() => true);
    const { user, ta, onSend } = await setup(onCommand);

    await user.type(ta, '/new');
    await user.keyboard('{Enter}');

    expect(onCommand).toHaveBeenCalledWith('new');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given 输入 /compact When onCommand 异步处理 Then 命令执行且输入清空', async () => {
    const onCommand = vi.fn(async () => true);
    const { user, ta, onSend } = await setup(onCommand);

    await user.type(ta, '/compact');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(onCommand).toHaveBeenCalledWith('compact');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given 输入 /resume When onCommand 返回 false(未处理) Then 命令不执行、输入保留', async () => {
    const onCommand = vi.fn(() => false);
    const { user, ta, onSend } = await setup(onCommand);

    await user.type(ta, '/resume');
    await user.keyboard('{Enter}');

    expect(onCommand).toHaveBeenCalledWith('resume');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(ta).toHaveValue('/resume'));
  });

  it('Given 未知命令 /foo When 回车 Then 显示提示、输入保留、不发送', async () => {
    const onCommand = vi.fn(() => true);
    const { user, ta, onSend } = await setup(onCommand);

    await user.type(ta, '/foo');
    await user.keyboard('{Enter}');

    expect(onCommand).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findByText(/未识别的命令：\/foo/)).toBeInTheDocument();
    expect(ta).toHaveValue('/foo');
  });

  it('Given 普通消息 When 回车 Then 发送并清空输入,不受斜杠检测影响', async () => {
    const onCommand = vi.fn(() => true);
    const { user, ta, onSend } = await setup(onCommand);

    await user.type(ta, '帮我写一段 /new 的说明');
    await user.keyboard('{Enter}');

    expect(onCommand).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith('帮我写一段 /new 的说明');
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given 普通消息 When Ctrl+Enter Then 不发送,不拦截默认行为(换行由浏览器插入)', async () => {
    const { user, ta, onSend } = await setup();

    await user.type(ta, '第一行');
    // fireEvent.keyDown 返回 boolean;要断言 defaultPrevented 需自己构造事件。
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(ta, ev);

    expect(onSend).not.toHaveBeenCalled();
    // 真实浏览器中 Ctrl+Enter 的 textarea 默认动作 = 插入换行;组件不得 preventDefault。
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Given 多行消息 When 回车 Then 整段发送并清空', async () => {
    const { user, ta, onSend } = await setup();

    // user-event 不建模修饰键 Enter 的换行默认动作;多行值直接以浏览器等价语义构造。
    fireEvent.change(ta, { target: { value: '第一行\n第二行' } });
    await waitFor(() => expect(ta).toHaveValue('第一行\n第二行'));
    ta.focus(); // fireEvent.change 不聚焦;Enter 需落在 textarea 上
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('第一行\n第二行');
    await waitFor(() => expect(ta).toHaveValue(''));
  });
});

// /review 复盘生成(任务 6.10):composer 直接经 window.lorra.review.generate 执行,
// 不回调 onCommand、不发给 AI;退化三态(model-unavailable / review-timed-out / 其他)
// 互斥文案复用 review-rail。
describe('Composer /review 复盘命令', () => {
  async function setupReview(generate: Mock) {
    Object.defineProperty(window, 'lorra', {
      value: { review: { generate } },
      writable: true,
      configurable: true,
    });
    const onCommand = vi.fn();
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer status="idle" onSend={onSend} onAbort={() => {}} onCommand={onCommand} />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    return { user, ta, onSend, onCommand };
  }

  const okReview = {
    status: 'ok',
    value: { id: 'r1', kind: 'daily', dateISO: '2026-08-07', createdAt: 0 },
  };

  it('Given 输入 /review 回车 When 执行 Then generate({kind:"daily"})、清空输入、不发送不回调', async () => {
    const generate = vi.fn().mockResolvedValue(okReview);
    const { user, ta, onSend, onCommand } = await setupReview(generate);

    await user.type(ta, '/review');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(generate).toHaveBeenCalledWith({ kind: 'daily' }));
    expect(onCommand).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given 输入 /review weekly 回车 When 执行 Then generate({kind:"weekly"})', async () => {
    const generate = vi.fn().mockResolvedValue(okReview);
    const { user, ta, onSend } = await setupReview(generate);

    await user.type(ta, '/review weekly');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(generate).toHaveBeenCalledWith({ kind: 'weekly' }));
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given /review foo When 回车 Then 非法 arg 提示、不触发生成、输入保留', async () => {
    const generate = vi.fn();
    const { user, ta, onSend } = await setupReview(generate);

    await user.type(ta, '/review foo');
    await user.keyboard('{Enter}');

    expect(generate).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findByText(/无效的复盘参数/)).toBeInTheDocument();
    expect(ta).toHaveValue('/review foo');
  });

  it('Given model-unavailable 错误 When 生成失败 Then 无可用模型提示(不复用超时文案)', async () => {
    const generate = vi.fn().mockResolvedValue({
      status: 'error',
      error: { code: 'model-unavailable', message: 'No API key found' },
    });
    const { user, ta } = await setupReview(generate);

    await user.type(ta, '/review');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/没有可用的模型提供方/)).toBeInTheDocument();
    expect(screen.queryByText(/复盘生成超时/)).not.toBeInTheDocument();
  });

  it('Given review-timed-out 错误 When 生成失败 Then 超时提示(不复用无模型文案)', async () => {
    const generate = vi.fn().mockResolvedValue({
      status: 'error',
      error: { code: 'review-timed-out', message: 'generation timed out' },
    });
    const { user, ta } = await setupReview(generate);

    await user.type(ta, '/review');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/复盘生成超时/)).toBeInTheDocument();
    expect(screen.queryByText(/没有可用的模型提供方/)).not.toBeInTheDocument();
  });

  it('Given 其他错误 When 生成失败 Then 失败详情提示', async () => {
    const generate = vi.fn().mockResolvedValue({
      status: 'error',
      error: { code: 'review-generation-failed', message: '模型未返回任何内容' },
    });
    const { user, ta } = await setupReview(generate);

    await user.type(ta, '/review');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/复盘生成失败：模型未返回任何内容/)).toBeInTheDocument();
  });

  it('Given 生成成功 When 完成 Then 成功反馈提示', async () => {
    const generate = vi.fn().mockResolvedValue(okReview);
    const { user, ta } = await setupReview(generate);

    await user.type(ta, '/review');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/复盘已生成/)).toBeInTheDocument();
  });
});

// 「问 AI」引用胶囊:选区文本以 [引用] 块拼进消息体,发送后清空。
describe('Composer 引用胶囊', () => {
  it('Given 有引用 When 渲染 Then 显示胶囊(文件名 + 截断文本 + ×)', () => {
    render(
      <Composer
        status="idle"
        onSend={() => {}}
        onAbort={() => {}}
        references={[{ id: 'r1', fileName: 'PRD.md', text: '这是被选中的一段很长的文字' }]}
      />,
    );
    expect(screen.getByRole('list', { name: '引用' })).toBeInTheDocument();
    expect(screen.getByText('PRD.md')).toBeInTheDocument();
    expect(screen.getByText('这是被选中的一段很长的文字')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '移除引用' })).toBeInTheDocument();
  });

  it('Given 无引用 When 渲染 Then 不显示胶囊行', () => {
    render(<Composer status="idle" onSend={() => {}} onAbort={() => {}} />);
    expect(screen.queryByRole('list', { name: '引用' })).not.toBeInTheDocument();
  });

  it('Given 有引用 When 发送 Then 消息体含 [引用] 块 + 用户输入,并清空引用', async () => {
    const onSend = vi.fn();
    const onClearReferences = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        references={[{ id: 'r1', fileName: 'spec.md', text: '选中原文内容' }]}
        onClearReferences={onClearReferences}
      />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '帮我解释一下');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith('[引用] spec.md\n> 选中原文内容\n\n帮我解释一下');
    await waitFor(() => expect(onClearReferences).toHaveBeenCalled());
  });

  it('Given 引用文本超 500 字符 When 发送 Then 消息体引用截断加 …', async () => {
    const long = '长'.repeat(600);
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        references={[{ id: 'r1', fileName: 'a.md', text: long }]}
      />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '问题');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const sent = onSend.mock.calls[0][0] as string;
    expect(sent.startsWith('[引用] a.md\n> ')).toBe(true);
    expect(sent).toContain(`${'长'.repeat(500)}…`);
  });

  it('Given 引用存在 When 发送失败(发送后 onSend 不 resolve 错误) Then 引用仍被清空,输入恢复', async () => {
    let resolveOnSend!: () => void;
    const onSend: Mock<(text: string) => Promise<void>> = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveOnSend = r;
        }),
    );
    const onClearReferences = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        inlineError=""
        references={[{ id: 'r1', fileName: 'a.md', text: '原文' }]}
        onClearReferences={onClearReferences}
      />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '我的问题');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    // 父组件 dispatch 失败 → 输入保留;引用胶囊随消息体已消费
    rerender(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        inlineError="网络断了"
        references={[{ id: 'r1', fileName: 'a.md', text: '原文' }]}
        onClearReferences={onClearReferences}
      />,
    );
    resolveOnSend();

    await waitFor(() => expect(onClearReferences).toHaveBeenCalled());
    await waitFor(() => expect(ta).toHaveValue('我的问题'));
    // 引用块不恢复(已进消息体,重发时只重发用户输入)
    expect(onSend.mock.calls[0][0]).toBe('[引用] a.md\n> 原文\n\n我的问题');
  });
});

// IDE 式补全:输入 / 弹出候选菜单,↑/↓ 选择,Tab 补全,Enter 执行,Esc 关闭。
describe('Composer 斜杠补全菜单', () => {
  async function setup(onCommand?: (cmd: string) => boolean | Promise<boolean>) {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer status="idle" onSend={onSend} onAbort={() => {}} onCommand={onCommand} />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    return { user, ta, onSend };
  }

  it('Given 输入 / When 输入框聚焦 Then 弹出全部命令候选', async () => {
    const { user, ta } = await setup();
    await user.type(ta, '/');

    const listbox = await screen.findByRole('listbox', { name: '斜杠命令' });
    expect(listbox).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(9);
    expect(options[0]).toHaveTextContent('/new');
  });

  it('Given 输入 /c When 过滤 Then 只剩 compact 与 copy', async () => {
    const { user, ta } = await setup();
    await user.type(ta, '/c');

    await screen.findByRole('listbox', { name: '斜杠命令' });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('/compact');
    expect(options[1]).toHaveTextContent('/copy');
  });

  it('Given /c + Tab When 补全 Then 高亮项(compact)补全;ArrowDown 后再 Tab 补全 copy', async () => {
    const { user, ta } = await setup();
    await user.type(ta, '/c');
    await screen.findByRole('listbox', { name: '斜杠命令' });

    await user.keyboard('{Tab}');
    expect(ta).toHaveValue('/compact');

    await user.clear(ta);
    await user.type(ta, '/c');
    await screen.findByRole('listbox', { name: '斜杠命令' });
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Tab}');

    expect(ta).toHaveValue('/copy');
  });

  it('Given /n + Enter When 执行 Then 补全命令并执行、清空输入', async () => {
    const onCommand = vi.fn(() => true);
    const { user, ta, onSend } = await setup(onCommand);
    await user.type(ta, '/n');
    await screen.findByRole('listbox', { name: '斜杠命令' });

    await user.keyboard('{Enter}');

    expect(onCommand).toHaveBeenCalledWith('new');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given /c + ArrowDown + Enter When 执行 Then 选中项(copy)被执行', async () => {
    const onCommand = vi.fn(() => true);
    const { user, ta, onSend } = await setup(onCommand);
    await user.type(ta, '/c');
    await screen.findByRole('listbox', { name: '斜杠命令' });

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onCommand).toHaveBeenCalledWith('copy');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given / + Escape When 关闭 Then 菜单消失,输入保留', async () => {
    const { user, ta } = await setup();
    await user.type(ta, '/');
    await screen.findByRole('listbox', { name: '斜杠命令' });

    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: '斜杠命令' })).not.toBeInTheDocument(),
    );
    expect(ta).toHaveValue('/');
  });

  it('Given 菜单展开 When 点击候选 Then 该命令执行并清空', async () => {
    const onCommand = vi.fn(() => true);
    const { user, ta, onSend } = await setup(onCommand);
    await user.type(ta, '/h');
    await screen.findByRole('listbox', { name: '斜杠命令' });

    await user.click(screen.getByRole('option', { name: /\/hotkeys/ }));

    expect(onCommand).toHaveBeenCalledWith('hotkeys');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(ta).toHaveValue(''));
  });

  it('Given 普通文本 When 输入 Then 不弹菜单', async () => {
    const { user, ta } = await setup();
    await user.type(ta, '你好');
    expect(screen.queryByRole('listbox', { name: '斜杠命令' })).not.toBeInTheDocument();
  });

  it('Given 输入 /f When 无匹配命令 Then 菜单不弹出,回车走未知命令提示', async () => {
    const onCommand = vi.fn(() => true);
    const { user, ta, onSend } = await setup(onCommand);
    await user.type(ta, '/f');

    expect(screen.queryByRole('listbox', { name: '斜杠命令' })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onCommand).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findByText(/未识别的命令：\/f/)).toBeInTheDocument();
  });
});

// @ 文件引用:输入 @ 弹工作区文件候选,Enter 成胶囊,发送时内容快照进消息体。
describe('Composer @ 文件引用', () => {
  async function setup(over: {
    onFileCandidates?: (q: string) => Promise<Array<{ fileId: string; name: string }>>;
    onResolveFileRef?: (fileId: string) => Promise<string | null>;
  } = {}) {
    const onSend = vi.fn();
    const onAppendReference = vi.fn();
    const onClearReferences = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        onFileCandidates={over.onFileCandidates}
        onResolveFileRef={over.onResolveFileRef}
        onAppendReference={onAppendReference}
        onClearReferences={onClearReferences}
      />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    return { user, ta, onSend, onAppendReference, onClearReferences };
  }

  const CANDIDATES = [
    { fileId: 'docs/prd.md', name: 'prd.md' },
    { fileId: 'spec.md', name: 'spec.md' },
  ];

  it('Given 输入 @ 前缀 When 候选返回 Then 弹出文件候选菜单', async () => {
    const onFileCandidates = vi.fn(async () => CANDIDATES);
    const { user, ta } = await setup({ onFileCandidates });

    await user.type(ta, '看看 @prd');

    const listbox = await screen.findByRole('listbox', { name: '文件引用' });
    expect(listbox).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('prd.md');
    expect(onFileCandidates).toHaveBeenCalledWith('prd');
  });

  it('Given 无 onFileCandidates When 输入 @ Then 不弹菜单', async () => {
    const { user, ta } = await setup();
    await user.type(ta, '@prd');
    expect(screen.queryByRole('listbox', { name: '文件引用' })).not.toBeInTheDocument();
  });

  it('Given 菜单开启 When Enter Then 成 file 胶囊,输入去掉 @前缀', async () => {
    const onFileCandidates = vi.fn(async () => CANDIDATES);
    const { user, ta, onAppendReference } = await setup({ onFileCandidates });

    await user.type(ta, '帮我看看 @prd');
    await screen.findByRole('listbox', { name: '文件引用' });
    await user.keyboard('{Enter}');

    expect(onAppendReference).toHaveBeenCalledTimes(1);
    const ref = onAppendReference.mock.calls[0][0] as {
      kind: string;
      fileId: string;
      fileName: string;
    };
    expect(ref.kind).toBe('file');
    expect(ref.fileId).toBe('docs/prd.md');
    expect(ref.fileName).toBe('prd.md');
    expect(ta).toHaveValue('帮我看看 ');
  });

  it('Given 菜单开启 When Esc Then 关闭菜单,输入保留', async () => {
    const onFileCandidates = vi.fn(async () => CANDIDATES);
    const { user, ta } = await setup({ onFileCandidates });

    await user.type(ta, '@prd');
    await screen.findByRole('listbox', { name: '文件引用' });
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox', { name: '文件引用' })).not.toBeInTheDocument();
    expect(ta).toHaveValue('@prd');
  });

  it('Given file 引用 When 发送 Then 内容快照进消息体([文件] 块 + 用户输入)', async () => {
    const onResolveFileRef = vi.fn(async () => 'PRD 正文内容');
    const onSend = vi.fn();
    const onClearReferences = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        onResolveFileRef={onResolveFileRef}
        references={[{ id: 'f1', kind: 'file', fileId: 'docs/prd.md', fileName: 'prd.md' }]}
        onClearReferences={onClearReferences}
      />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '总结一下');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith(
      '[文件] prd.md\n```\nPRD 正文内容\n```\n\n总结一下',
    );
    await waitFor(() => expect(onClearReferences).toHaveBeenCalled());
  });

  it('Given 文件内容超 2000 字符 When 发送 Then 截断加 …（已截断）', async () => {
    const long = '长'.repeat(3000);
    const onResolveFileRef = vi.fn(async () => long);
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        onResolveFileRef={onResolveFileRef}
        references={[{ id: 'f1', kind: 'file', fileId: 'a.md', fileName: 'a.md' }]}
      />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '问题');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const sent = onSend.mock.calls[0][0] as string;
    expect(sent.startsWith('[文件] a.md\n```\n')).toBe(true);
    expect(sent).toContain(`${'长'.repeat(2000)}\n…（已截断）`);
  });

  it('Given 文件内容读不到 When 发送 Then 退化为仅文件名', async () => {
    const onResolveFileRef = vi.fn(async () => null);
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        onResolveFileRef={onResolveFileRef}
        references={[{ id: 'f1', kind: 'file', fileId: 'gone.md', fileName: 'gone.md' }]}
      />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '问题');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith('[文件] gone.md\n\n问题');
  });

  it('Given file + selection 混合 When 发送 Then file 块在前,selection 在后', async () => {
    const onResolveFileRef = vi.fn(async () => '内容');
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <Composer
        status="idle"
        onSend={onSend}
        onAbort={() => {}}
        onResolveFileRef={onResolveFileRef}
        references={[
          { id: 'f1', kind: 'file', fileId: 'a.md', fileName: 'a.md' },
          { id: 's1', fileName: 'b.md', text: '选中文字' },
        ]}
      />,
    );
    const ta = screen.getByRole('textbox', { name: '向 Agent 提问' });
    await user.type(ta, '问题');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith(
      '[文件] a.md\n```\n内容\n```\n\n[引用] b.md\n> 选中文字\n\n问题',
    );
  });

  it('Given file 引用 When 渲染 Then 胶囊带「文件」标记', () => {
    render(
      <Composer
        status="idle"
        onSend={() => {}}
        onAbort={() => {}}
        references={[{ id: 'f1', kind: 'file', fileId: 'a.md', fileName: 'a.md' }]}
      />,
    );
    expect(screen.getByText('文件')).toBeInTheDocument();
    expect(screen.getByText('a.md')).toBeInTheDocument();
  });
});
