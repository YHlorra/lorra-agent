import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Annotation, AnnotationDraft } from '../shared/annotations';
import { DocumentViewer } from './document-viewer';

// spy 跨用例隔离(与 App.test.tsx 同惯例):Ctrl+导航用例的 openExternal/resolveWikilink
// 调用记录不得泄漏到无 Ctrl 用例,否则断言误红。
beforeEach(() => {
  vi.restoreAllMocks();
});

// mermaid 走动态 import:mock 掉,避免 jsdom 里真实加载 WebWorker 依赖。
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="mmd-svg" />' })),
  },
}));

function makeAnn(over: Partial<Annotation> & { id: string }): Annotation {
  return {
    relPath: 'a.md',
    kind: 'md',
    text: '选中文本',
    anchor: { type: 'text', before: '', after: '' },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function renderViewer(over: {
  file?: { status: 'ready' | 'error'; content?: string; error?: string };
  fileName?: string;
  fileId?: string | null;
  annotations?: Annotation[];
  onAnnotate?: Mock<(draft: AnnotationDraft) => void>;
  onRemoveAnnotation?: Mock<(id: string) => void>;
  onAskAi?: Mock<(text: string) => void>;
  onSaveContent?: Mock<(content: string) => Promise<'saved' | 'conflict' | 'error'>>;
  onEditStateChange?: Mock<(editing: boolean) => void>;
  onOpenFile?: Mock<(fileId: string) => void>;
}) {
  const onAnnotate: Mock<(draft: AnnotationDraft) => void> = over.onAnnotate ?? vi.fn();
  const onRemoveAnnotation: Mock<(id: string) => void> = over.onRemoveAnnotation ?? vi.fn();
  const onAskAi: Mock<(text: string) => void> = over.onAskAi ?? vi.fn();
  const onSaveContent: Mock<(content: string) => Promise<'saved' | 'conflict' | 'error'>> =
    over.onSaveContent ?? vi.fn().mockResolvedValue('saved');
  const onEditStateChange: Mock<(editing: boolean) => void> = over.onEditStateChange ?? vi.fn();
  const onOpenFile: Mock<(fileId: string) => void> = over.onOpenFile ?? vi.fn();
  const utils = render(
    <DocumentViewer
      file={over.file ?? { status: 'ready', content: '正文内容' }}
      fileName={over.fileName ?? 'a.md'}
      fileId={over.fileId ?? null}
      annotations={over.annotations ?? []}
      onAnnotate={onAnnotate}
      onRemoveAnnotation={onRemoveAnnotation}
      onAskAi={onAskAi}
      onSaveContent={onSaveContent}
      onEditStateChange={onEditStateChange}
      onOpenFile={onOpenFile}
    />,
  );
  return {
    utils,
    onAnnotate,
    onRemoveAnnotation,
    onAskAi,
    onSaveContent,
    onEditStateChange,
    onOpenFile,
  };
}

/** 模拟用户选中 document-content 内的一段文字(触发 SelectionToolbar 的 mouseup 检测)。 */
async function selectTextInDocument(
  text: string,
  container: HTMLElement = document.body,
): Promise<void> {
  const content = container.querySelector('.document-content');
  expect(content).not.toBeNull();
  const range = document.createRange();
  const walker = document.createTreeWalker(content as Node, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  const full = nodes.map((n) => n.data).join('');
  const idx = full.indexOf(text);
  expect(idx, `text "${text}" present in document`).toBeGreaterThanOrEqual(0);
  // 定位到包含该文本的节点
  let acc = 0;
  let target: Text | null = null;
  let startOff = 0;
  for (const n of nodes) {
    if (idx < acc + n.data.length) {
      target = n;
      startOff = idx - acc;
      break;
    }
    acc += n.data.length;
  }
  expect(target).not.toBeNull();
  range.setStart(target as Text, startOff);
  range.setEnd(target as Text, startOff + text.length);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await waitFor(() => {
    expect(screen.queryByRole('toolbar', { name: '选中文字操作' })).toBeInTheDocument();
  });
}

describe('DocumentViewer 链接/图片协议消毒', () => {
  it('Given 含 javascript: 链接的 md When 渲染 Then 链接不携带危险 href', () => {
    renderViewer({ file: { status: 'ready', content: '[恶意](javascript:alert(1))' } });
    const link = screen.getByText('恶意');
    expect(link.tagName).toBe('A');
    expect(link).not.toHaveAttribute('href');
  });

  it('Given 含 data: 图片的 md When 渲染 Then 图片被去 src', () => {
    renderViewer({ file: { status: 'ready', content: '![x](data:image/png;base64,AAAA)' } });
    const img = screen.getByAltText('x');
    expect(img).not.toHaveAttribute('src');
  });

  it('Given 合法 https 链接 When 渲染 Then 保留 href', () => {
    renderViewer({ file: { status: 'ready', content: '[官网](https://example.com)' } });
    expect(screen.getByRole('link', { name: '官网' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
  });

  it('Given 含 ./foo.png 本地相对图片的 md When 渲染 Then 保留相对 src', () => {
    renderViewer({ file: { status: 'ready', content: '![x](./foo.png)' } });
    expect(screen.getByAltText('x')).toHaveAttribute('src', './foo.png');
  });

  it('Given 含 ../assets/banner.png 跨级相对图片的 md When 渲染 Then 保留相对 src', () => {
    renderViewer({ file: { status: 'ready', content: '![x](../assets/banner.png)' } });
    expect(screen.getByAltText('x')).toHaveAttribute('src', '../assets/banner.png');
  });

  it('Given 含 http:// 明文远程图片的 md When 渲染 Then 保留 src', () => {
    renderViewer({ file: { status: 'ready', content: '![x](http://example.com/foo.png)' } });
    expect(screen.getByAltText('x')).toHaveAttribute('src', 'http://example.com/foo.png');
  });
});

describe('DocumentViewer 划线/笔记/问 AI', () => {
  it('Given 选中正文文字 When mouseup Then 浮动工具条出现,点「高亮」回调携带选区文本', async () => {
    const { onAnnotate } = renderViewer({ file: { status: 'ready', content: '这是正文内容' } });
    const user = userEvent.setup();
    await selectTextInDocument('正文内容');

    await user.click(screen.getByRole('button', { name: '高亮' }));
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    const draft = onAnnotate.mock.calls[0][0] as AnnotationDraft;
    expect(draft).toMatchObject({ kind: 'md', text: '正文内容' });
    expect(draft.anchor).toMatchObject({ type: 'text', before: '这是', after: '' });
  });

  it('Given 代码文件选中文字 When 高亮 Then kind=code', async () => {
    const { onAnnotate } = renderViewer({
      file: { status: 'ready', content: 'const a = 1;\nconst b = 2;' },
      fileName: 'a.ts',
    });
    const user = userEvent.setup();
    await selectTextInDocument('const b');

    await user.click(screen.getByRole('button', { name: '高亮' }));
    expect(onAnnotate.mock.calls[0][0]).toMatchObject({ kind: 'code', text: 'const b' });
  });

  it('Given 选中已划线的同一段文字 When 再点「高亮」 Then 触发 onRemoveAnnotation(Office 式开关,不叠加)', async () => {
    const { onAnnotate, onRemoveAnnotation } = renderViewer({
      file: { status: 'ready', content: '这是正文内容' },
      annotations: [
        makeAnn({
          id: 'a1',
          text: '正文内容',
          anchor: { type: 'text', before: '这是', after: '' },
        }),
      ],
    });
    const user = userEvent.setup();
    await selectTextInDocument('正文内容');

    await user.click(screen.getByRole('button', { name: '高亮' }));
    expect(onRemoveAnnotation).toHaveBeenCalledWith('a1');
    expect(onAnnotate).not.toHaveBeenCalled();
  });

  it('Given 选中未划线文字 When 点「高亮」 Then onAnnotate(新增)', async () => {
    const { onAnnotate, onRemoveAnnotation } = renderViewer({
      file: { status: 'ready', content: '未被划过的文字' },
      annotations: [],
    });
    const user = userEvent.setup();
    await selectTextInDocument('未被划过的文字');

    await user.click(screen.getByRole('button', { name: '高亮' }));
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(onRemoveAnnotation).not.toHaveBeenCalled();
  });

  it('Given 选中已划线文字 When 保存笔记 Then 同 id 更新 note(upsert)', async () => {
    const { onAnnotate } = renderViewer({
      file: { status: 'ready', content: '要记笔记的文字' },
      annotations: [
        makeAnn({
          id: 'a1',
          text: '记笔记的文字',
          anchor: { type: 'text', before: '要', after: '' },
        }),
      ],
    });
    const user = userEvent.setup();
    await selectTextInDocument('记笔记的文字');

    await user.click(screen.getByRole('button', { name: '笔记' }));
    const ta = await screen.findByRole('textbox', { name: '笔记内容' });
    await user.type(ta, '新想法');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onAnnotate).toHaveBeenCalledTimes(1);
    const draft = onAnnotate.mock.calls[0][0] as AnnotationDraft;
    expect(draft.id).toBe('a1');
    expect(draft.note).toBe('新想法');
  });

  it('Given 选中文字点「笔记」When 输入并保存 Then onAnnotate 携带 note 字段', async () => {
    const { onAnnotate } = renderViewer({ file: { status: 'ready', content: '要记笔记的文字' } });
    const user = userEvent.setup();
    await selectTextInDocument('记笔记的文字');

    await user.click(screen.getByRole('button', { name: '笔记' }));
    const ta = await screen.findByRole('textbox', { name: '笔记内容' });
    await user.type(ta, '我的想法');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(onAnnotate.mock.calls[0][0]).toMatchObject({
      text: '记笔记的文字',
      note: '我的想法',
    });
  });

  it('Given 选中文字点「问 AI」When 点击 Then onAskAi 携带选区文本', async () => {
    const { onAskAi } = renderViewer({ file: { status: 'ready', content: '问 AI 的这段文字' } });
    const user = userEvent.setup();
    await selectTextInDocument('这段文字');

    await user.click(screen.getByRole('button', { name: '问 AI' }));
    expect(onAskAi).toHaveBeenCalledWith('这段文字');
  });

  it('Given 已有标注 When 渲染 Then mark 注入正文(annotation-hl)', async () => {
    renderViewer({
      file: { status: 'ready', content: '前后文中间是选中文本后面还有字' },
      annotations: [
        makeAnn({
          id: 'a1',
          text: '中间是选中文本',
          anchor: { type: 'text', before: '前后文', after: '后面' },
        }),
      ],
    });
    const mark = await screen.findByText('中间是选中文本');
    expect(mark.tagName).toBe('MARK');
    expect(mark).toHaveClass('annotation-hl');
    expect(mark).toHaveAttribute('data-ann-id', 'a1');
  });

  it('Given 标注锚点失配(原文已编辑)When 渲染 Then 不注入 mark 且不报错', () => {
    const { utils } = renderViewer({
      file: { status: 'ready', content: '现在的内容完全不同了' },
      annotations: [
        makeAnn({
          id: 'gone',
          text: '旧文本',
          anchor: { type: 'text', before: '旧前文', after: '旧后文' },
        }),
      ],
    });
    expect(utils.container.querySelector('mark[data-ann-id="gone"]')).toBeNull();
  });

  it('Given 点「划线」按钮 When 面板打开 Then 列表显示标注文本;点删除回调 onRemoveAnnotation', async () => {
    const { onRemoveAnnotation } = renderViewer({
      file: { status: 'ready', content: '有标注的正文' },
      annotations: [makeAnn({ id: 'a1', text: '有标注的正文', note: '附注' })],
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '划线列表' }));
    const panel = await screen.findByRole('complementary', { name: '划线列表' });
    expect(within(panel).getByText('有标注的正文')).toBeInTheDocument();
    expect(within(panel).getByText('附注')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: '删除划线' }));
    expect(onRemoveAnnotation).toHaveBeenCalledWith('a1');
  });

  it('Given 无标注 When 打开划线面板 Then 显示空态「还没有划线」', async () => {
    const user = userEvent.setup();
    renderViewer({ file: { status: 'ready', content: '正文' } });
    await user.click(screen.getByRole('button', { name: '划线列表' }));
    expect(await screen.findByText('还没有划线')).toBeInTheDocument();
  });

  it('Given 点划线列表项 When mark 存在 Then 滚动+闪烁(不弹提示)', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    renderViewer({
      file: { status: 'ready', content: '点我跳转的文字' },
      annotations: [makeAnn({ id: 'j1', text: '点我跳转的文字' })],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '划线列表' }));
    const panel = await screen.findByRole('complementary', { name: '划线列表' });
    await user.click(within(panel).getByText('点我跳转的文字'));

    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    expect(screen.queryByText(/原文已变更/)).toBeNull();
    scrollSpy.mockRestore();
  });

  it('Given 点划线列表项 When mark 不存在(原文已变更) Then 提示「原文已变更」且不崩溃', async () => {
    renderViewer({
      file: { status: 'ready', content: '现在的正文' },
      annotations: [makeAnn({ id: 'gone', text: '旧文本' })],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '划线列表' }));
    await user.click(await screen.findByText('旧文本'));

    expect(await screen.findByText('原文已变更，划线无法定位')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Obsidian 式阅读布局(/):frontmatter 标题/标签 pill 行、
// GFM 表格/任务列表/callout/mermaid;正文不再重复首 H1。
// ---------------------------------------------------------------------------

describe('DocumentViewer Obsidian 式阅读布局', () => {
  it('Given 带 frontmatter 的 md When 渲染 Then 页顶大标题 + 标签 pill 行,正文不含首 H1', () => {
    const content = `---
title: 产品设计文档
tags:
  - design
  - spec
---

# 产品设计文档

正文第一段
`;
    renderViewer({ file: { status: 'ready', content } });
    expect(screen.getByRole('heading', { level: 1, name: '产品设计文档' })).toBeInTheDocument();
    expect(screen.getByText('#design')).toBeInTheDocument();
    expect(screen.getByText('#spec')).toBeInTheDocument();
    // 正文内不再重复首 H1(仅文档头一个 h1)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('正文第一段')).toBeInTheDocument();
  });

  it('Given 无 frontmatter 无 H1 When 渲染 Then 标题回退文件名', () => {
    renderViewer({ file: { status: 'ready', content: '只有正文' }, fileName: 'notes.md' });
    expect(screen.getByRole('heading', { level: 1, name: 'notes.md' })).toBeInTheDocument();
  });

  it('Given GFM 表格 + 任务列表 When 渲染 Then 语义 HTML(表格 + checkbox)', () => {
    const content = '# t\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] 未完成\n- [x] 已完成\n';
    renderViewer({ file: { status: 'ready', content } });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'a' })).toBeInTheDocument();
    const checks = screen.getAllByRole('checkbox');
    expect(checks).toHaveLength(2);
    expect(checks[0]).not.toBeChecked();
    expect(checks[1]).toBeChecked();
  });

  it('Given Obsidian callout When 渲染 Then div.callout.callout-tip + 标题', () => {
    const content = '# t\n\n> [!tip] 小贴士\n>\n> 内容在此\n';
    renderViewer({ file: { status: 'ready', content } });
    const callout = document.querySelector('.document .callout.callout-tip');
    expect(callout).not.toBeNull();
    expect(screen.getByText('小贴士')).toBeInTheDocument();
    expect(screen.getByText('内容在此')).toBeInTheDocument();
  });

  it('Given 数学公式 $...$ When 渲染 Then KaTeX 输出', () => {
    const content = '# t\n\n当 $x \\gt 0$ 时成立。\n';
    renderViewer({ file: { status: 'ready', content } });
    // katex 渲染为 .katex 元素
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  it('Given mermaid 代码块 When 渲染 Then 动态 import 渲染 SVG', async () => {
    const content = '# t\n\n```mermaid\ngraph TD\nA-->B\n```\n';
    renderViewer({ file: { status: 'ready', content } });
    // mock 的 render 返回 <svg data-testid="mmd-svg">
    expect(await screen.findByTestId('mmd-svg')).toBeInTheDocument();
  });

  it('Given md 就绪 When 渲染 Then saved-state 显示发现性提示', () => {
    renderViewer({ file: { status: 'ready', content: '# t\n\n正文' } });
    expect(screen.getByText('已保存 · 点击正文直接编辑')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 阅读编辑合一(//):点击块就地编辑原始 Markdown,
// 失焦/Ctrl+S 保存(整篇原文块替换),Esc 取消,冲突关闭编辑。
// ---------------------------------------------------------------------------

describe('DocumentViewer 点击就地编辑', () => {
  const DOC = '# 标题\n\n段落一 **加粗** 内容\n\n段落二\n';

  it('Given 点击正文段落(无选区) When 点击 Then 出现 textarea,内容为该段原始 Markdown 源', async () => {
    const user = userEvent.setup();
    const { onEditStateChange } = renderViewer({ file: { status: 'ready', content: DOC } });

    await user.click(screen.getByText(/段落一/));
    const ta = await screen.findByRole('textbox');
    expect(ta).toHaveClass('md-edit-input');
    expect((ta as HTMLTextAreaElement).value).toBe('段落一 **加粗** 内容');
    expect(onEditStateChange).toHaveBeenCalledWith(true);
  });

  it('Given 修改后失焦 When blur Then onSaveContent 收到完整原文(仅该块被替换)', async () => {
    const user = userEvent.setup();
    const { onSaveContent } = renderViewer({ file: { status: 'ready', content: DOC } });

    await user.click(screen.getByText(/段落一/));
    const ta = await screen.findByRole('textbox');
    await user.clear(ta);
    await user.type(ta, '新段落内容');
    await user.tab();

    expect(onSaveContent).toHaveBeenCalledTimes(1);
    expect(onSaveContent.mock.calls[0][0]).toBe('# 标题\n\n新段落内容\n\n段落二\n');
  });

  it('Given 修改后按 Ctrl+S When 保存 Then onSaveContent 收到整篇原文', async () => {
    const user = userEvent.setup();
    const { onSaveContent } = renderViewer({ file: { status: 'ready', content: DOC } });

    await user.click(screen.getByText(/段落一/));
    const ta = await screen.findByRole('textbox');
    await user.clear(ta);
    await user.type(ta, '保存后的段落');
    await user.keyboard('{Control>}s{/Control}');

    expect(onSaveContent).toHaveBeenCalledTimes(1);
    expect(onSaveContent.mock.calls[0][0]).toBe('# 标题\n\n保存后的段落\n\n段落二\n');
  });

  it('Given 按 Escape When 编辑中 Then 取消且不触发 onSaveContent', async () => {
    const user = userEvent.setup();
    const { onSaveContent, onEditStateChange } = renderViewer({
      file: { status: 'ready', content: DOC },
    });

    await user.click(screen.getByText(/段落一/));
    await screen.findByRole('textbox');
    await user.keyboard('{Escape}');

    expect(onSaveContent).not.toHaveBeenCalled();
    expect(document.querySelector('.md-edit-input')).toBeNull();
    expect(onEditStateChange).toHaveBeenLastCalledWith(false);
  });

  it('Given 已有文字选区 When 点击 Then 不进入编辑(划线流程不受影响)', async () => {
    const { onAnnotate } = renderViewer({ file: { status: 'ready', content: DOC } });

    // 划选「段落二」触发浮动工具条;fireEvent.click 不折叠选区(保留 getSelection),
    // 验证 BlockWrap 的选区守卫本身——真实浏览器 mousedown 会先折叠选区。
    await selectTextInDocument('段落二');
    fireEvent.click(screen.getByText(/段落一/));

    expect(document.querySelector('.md-edit-input')).toBeNull();
    expect(onAnnotate).not.toHaveBeenCalled();
  });

  it('Given onSaveContent 返回 conflict When 保存 Then 编辑态关闭(内容由 App 重取)', async () => {
    const user = userEvent.setup();
    const { onSaveContent } = renderViewer({
      file: { status: 'ready', content: DOC },
      onSaveContent: vi.fn().mockResolvedValue('conflict'),
    });

    await user.click(screen.getByText(/段落一/));
    const ta = await screen.findByRole('textbox');
    await user.type(ta, 'x');
    await user.tab();

    expect(onSaveContent).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.md-edit-input')).toBeNull();
  });

  it('Given onSaveContent 返回 error When 保存 Then 编辑态与 draft 保留(可重试)', async () => {
    const user = userEvent.setup();
    renderViewer({
      file: { status: 'ready', content: DOC },
      onSaveContent: vi.fn().mockResolvedValue('error'),
    });

    await user.click(screen.getByText(/段落一/));
    const ta = await screen.findByRole('textbox');
    await user.type(ta, '改了一半');
    await user.tab();

    const taAfter = await screen.findByRole('textbox');
    expect((taAfter as HTMLTextAreaElement).value).toContain('改了一半');
  });

  it('Given 带 frontmatter 的文件编辑中段 When 保存 Then 保存内容含 frontmatter(toFull 映射正确)', async () => {
    const user = userEvent.setup();
    const full = `---
title: 文档
tags: [a]
---

# 标题

段落一

段落二
`;
    const { onSaveContent } = renderViewer({ file: { status: 'ready', content: full } });

    await user.click(screen.getByText(/段落一/));
    const ta = await screen.findByRole('textbox');
    await user.clear(ta);
    await user.type(ta, '改过的段落');
    await user.tab();

    expect(onSaveContent.mock.calls[0][0]).toBe(
      `---
title: 文档
tags: [a]
---

# 标题

改过的段落

段落二
`,
    );
  });

  it('Given 选中文字 When 点「高亮」 Then 回归:划线流程仍正常(编辑包裹后)', async () => {
    const user = userEvent.setup();
    const { onAnnotate } = renderViewer({ file: { status: 'ready', content: DOC } });

    await selectTextInDocument('段落二');
    await user.click(screen.getByRole('button', { name: '高亮' }));
    expect(onAnnotate.mock.calls[0][0]).toMatchObject({ text: '段落二' });
  });
});

// ---------------------------------------------------------------------------
// 标题/tag 就地编辑(2026-08-17):点击标题/tag → 输入框 → Enter/blur 保存
// (rewriteMetaFields 只 patch frontmatter 的 title/tags),Esc 取消,error 保留草稿。
// ---------------------------------------------------------------------------

describe('DocumentViewer 标题/tag 就地编辑', () => {
  const DOC = `---
title: 旧标题
tags: [a, b]
---

# 旧标题

正文
`;

  it('Given 点击标题 When 编辑并回车 Then 保存内容 frontmatter title 更新', async () => {
    const user = userEvent.setup();
    const { onSaveContent } = renderViewer({ file: { status: 'ready', content: DOC } });

    await user.click(screen.getByRole('button', { name: '旧标题' }));
    const input = await screen.findByRole('textbox', { name: '文档标题' });
    await user.clear(input);
    await user.type(input, '新标题');
    await user.keyboard('{Enter}');

    expect(onSaveContent).toHaveBeenCalledTimes(1);
    expect(onSaveContent.mock.calls[0][0]).toContain('title: 新标题');
    expect(onSaveContent.mock.calls[0][0]).toContain('tags: [a, b]');
  });

  it('Given 点击 tag When 编辑并回车 Then 保存内容 tags 数组更新(其余字段保留)', async () => {
    const user = userEvent.setup();
    const { onSaveContent } = renderViewer({ file: { status: 'ready', content: DOC } });

    await user.click(screen.getByText('#a'));
    const input = await screen.findByRole('textbox', { name: '标签' });
    await user.clear(input);
    await user.type(input, 'newtag');
    await user.keyboard('{Enter}');

    expect(onSaveContent).toHaveBeenCalledTimes(1);
    expect(onSaveContent.mock.calls[0][0]).toContain('tags: [newtag, b]');
    expect(onSaveContent.mock.calls[0][0]).toContain('title: 旧标题');
  });

  it('Given Esc 取消 When 编辑标题中 Then 不触发 onSaveContent 且输入框消失', async () => {
    const user = userEvent.setup();
    const { onSaveContent } = renderViewer({ file: { status: 'ready', content: DOC } });

    await user.click(screen.getByRole('button', { name: '旧标题' }));
    await screen.findByRole('textbox', { name: '文档标题' });
    await user.keyboard('{Escape}');

    expect(onSaveContent).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: '文档标题' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: '旧标题' })).toBeInTheDocument();
  });

  it('Given onSaveContent 返回 error When 保存标题 Then 编辑态保留(可重试)', async () => {
    const user = userEvent.setup();
    const { onSaveContent } = renderViewer({
      file: { status: 'ready', content: DOC },
      onSaveContent: vi.fn().mockResolvedValue('error'),
    });

    await user.click(screen.getByRole('button', { name: '旧标题' }));
    const input = await screen.findByRole('textbox', { name: '文档标题' });
    await user.type(input, '未保存的标题');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(onSaveContent).toHaveBeenCalledTimes(1));
    const stillThere = await screen.findByRole('textbox', { name: '文档标题' });
    expect((stillThere as HTMLInputElement).value).toContain('未保存的标题');
  });
});

// ---------------------------------------------------------------------------
// Ctrl+点击导航(2026-08-17):双链 [[target]] → resolveWikilink → onOpenFile;
// 外链 https/mailto → openExternal;相对/绝对路径 → onOpenFile。无 Ctrl 不导航。
// ---------------------------------------------------------------------------

describe('DocumentViewer Ctrl+点击导航', () => {
  it('Given Ctrl+点击双链 When 目标存在 Then 调 resolveWikilink 并 onOpenFile', async () => {
    const resolveWikilink = vi
      .spyOn(window.lorra.fs, 'resolveWikilink')
      .mockResolvedValue({ ok: true, value: { fileId: 'b.md' } });
    const { onOpenFile } = renderViewer({
      file: { status: 'ready', content: '# t\n\n见 [[b]] 页面\n' },
    });

    const wl = await screen.findByText('b');
    fireEvent.click(wl, { ctrlKey: true });

    await waitFor(() => expect(resolveWikilink).toHaveBeenCalledWith({ name: 'b' }));
    expect(onOpenFile).toHaveBeenCalledWith('b.md');
  });

  it('Given Ctrl+点击双链 When 目标不存在 Then 提示「目标不存在」且不打开', async () => {
    vi.spyOn(window.lorra.fs, 'resolveWikilink').mockResolvedValue({
      ok: true,
      value: { fileId: null },
    });
    const { onOpenFile } = renderViewer({
      file: { status: 'ready', content: '# t\n\n见 [[gone]] 页面\n' },
    });

    fireEvent.click(await screen.findByText('gone'), { ctrlKey: true });

    expect(await screen.findByText('目标不存在')).toBeInTheDocument();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('Given Ctrl+点击外链 When 点击 Then 调 openExternal 且不进就地编辑', async () => {
    const openExternal = vi.spyOn(window.lorra.app, 'openExternal').mockResolvedValue(true);
    renderViewer({ file: { status: 'ready', content: '# t\n\n看 [官网](https://example.com)\n' } });

    const link = await screen.findByRole('link', { name: '官网' });
    fireEvent.click(link, { ctrlKey: true });

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://example.com'));
    expect(document.querySelector('.md-edit-input')).toBeNull();
  });

  it('Given Ctrl+点击相对路径链接 When 点击 Then onOpenFile(剥 ./ 前缀)', async () => {
    const { onOpenFile } = renderViewer({
      file: { status: 'ready', content: '# t\n\n去 [其他页](./other.md)\n' },
    });

    const link = await screen.findByText('其他页');
    expect(link.closest('a')).toHaveAttribute('data-href', './other.md');
    fireEvent.click(link, { ctrlKey: true });

    expect(onOpenFile).toHaveBeenCalledWith('other.md');
  });

  it('Given 无 Ctrl 点击链接 When 点击 Then 不导航(capture 不拦截,保留正文就地编辑)', async () => {
    const openExternal = vi.spyOn(window.lorra.app, 'openExternal').mockResolvedValue(true);
    const { onOpenFile } = renderViewer({
      file: { status: 'ready', content: '# t\n\n看 [官网](https://example.com)\n' },
    });

    const link = await screen.findByRole('link', { name: '官网' });
    fireEvent.click(link);

    expect(openExternal).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
