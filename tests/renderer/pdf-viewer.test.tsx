import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Annotation } from '../../src/shared/annotations';
import { PdfViewer } from '../../src/renderer/pdf-viewer';

// pdfjs-dist 整体 mock:核心渲染不在 jsdom 可达范围,这里验证组件接线
// (页容器创建 / 错误态 / 文本层标注注入 / 开关回调)。
const getDocument = vi.fn();
const loadPdfWorkerUrl = vi.fn(async () => 'mock://worker');
const createPdfWorkerPort = vi.fn(async () => ({} as Worker));

vi.mock('pdfjs-dist', () => ({
  getDocument: (...args: unknown[]) => getDocument(...args),
  GlobalWorkerOptions: { workerSrc: '', workerPort: null },
  TextLayer: TextLayerMock,
}));

function TextLayerMock(this: { container: HTMLElement }, params: {
  textContentSource: unknown;
  container: HTMLElement;
  viewport: { scale: number; rotation: number };
}): void {
  this.container = params.container;
}
TextLayerMock.prototype.render = async function render(): Promise<void> {
  const span = document.createElement('span');
  span.textContent = 'PDF 冒烟文本';
  this.container.appendChild(span);
};

vi.mock('./pdf-worker', () => ({
  loadPdfWorkerUrl,
  createPdfWorkerPort,
}));

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  callback: IntersectionObserverCallback;
  root: Element | Document | null;
  observed: Element[] = [];
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    IntersectionObserverStub.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** 测试辅助:模拟第一个被观察的 slot 进入视口。 */
  intersectFirst(): void {
    const target = this.observed[0];
    if (!target) throw new Error('no observed elements');
    void this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  static reset(): void {
    IntersectionObserverStub.instances = [];
  }
}
vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

function makeAnn(over: Partial<Annotation> & { id: string }): Annotation {
  return {
    relPath: 'a.pdf',
    kind: 'pdf',
    text: 'PDF 冒烟文本',
    anchor: { type: 'pdf', page: 1, before: '', after: '' },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function fakePdf(): void {
  const fakePage = {
    getViewport: () => ({
      width: 612,
      height: 792,
      rotation: 0,
      scale: 1.4,
      rawDims: { pageWidth: 612, pageHeight: 792, pageX: 0, pageY: 0 },
    }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({
      items: [
        {
          str: 'PDF 冒烟文本',
          transform: [1, 0, 0, 1, 0, 0],
          width: 120,
          height: 16,
          fontName: 'f1',
          hasEOL: true,
        },
      ],
      styles: {},
    }),
  };
  const fakeDoc = {
    numPages: 1,
    getPage: async () => fakePage,
  };
  getDocument.mockReturnValue({
    promise: Promise.resolve(fakeDoc),
    destroy: vi.fn(async () => {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  IntersectionObserverStub.reset();
  fakePdf();
  // jsdom 无 2D canvas 上下文,组件 renderPage 会提前 return。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(window.lorra.fs, 'openBinary').mockResolvedValue({
    ok: true,
    value: { data: new Uint8Array([1, 2, 3]) },
  });
});

async function renderReady(over: {
  annotations?: Annotation[];
  onAnnotate?: Mock<(draft: unknown) => void>;
  onRemoveAnnotation?: Mock<(id: string) => void>;
  onAskAi?: Mock<(text: string) => void>;
} = {}) {
  const onAnnotate: Mock<(draft: unknown) => void> = over.onAnnotate ?? vi.fn();
  const onRemoveAnnotation: Mock<(id: string) => void> = over.onRemoveAnnotation ?? vi.fn();
  const onAskAi: Mock<(text: string) => void> = over.onAskAi ?? vi.fn();
  const utils = render(
    <PdfViewer
      fileId="pdf-1"
      annotations={over.annotations ?? []}
      onAnnotate={onAnnotate}
      onRemoveAnnotation={onRemoveAnnotation}
      onAskAi={onAskAi}
    />,
  );
  // 触发懒渲染:把第 1 页 slot 送入视口
  await waitFor(() => {
    const slot = document.querySelector('.pdf-page-slot');
    expect(slot).not.toBeNull();
  });
  const observer = IntersectionObserverStub.instances.at(-1);
  expect(observer).toBeDefined();
  observer?.intersectFirst();
  await waitFor(() => {
    expect(document.querySelector('.annotation-text-layer')).not.toBeNull();
  });
  return { utils, onAnnotate, onRemoveAnnotation, onAskAi };
}

describe('PdfViewer', () => {
  it('Given 正常 PDF When 渲染 Then 页容器 + canvas + 文本层创建', async () => {
    const { utils } = await renderReady();
    expect(utils.container.querySelector('.pdf-page-slot')).not.toBeNull();
    expect(utils.container.querySelector('canvas.pdf-canvas')).not.toBeNull();
    expect(utils.container.querySelector('.annotation-text-layer')).not.toBeNull();
    expect(screen.getByText('1 / 1 页')).toBeInTheDocument();
  });

  it('Given 损坏 PDF When getDocument 失败 Then 错误态 + 重试按钮', async () => {
    getDocument.mockReturnValue({
      promise: Promise.reject(new Error('InvalidPDF')),
      destroy: vi.fn(async () => {}),
    });
    const utils = render(
      <PdfViewer fileId="pdf-1" annotations={[]} onAnnotate={() => {}} onRemoveAnnotation={() => {}} onAskAi={() => {}} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('无法渲染此 PDF');
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
    expect(utils.container.querySelector('.pdf-page-slot')).toBeNull();
  });

  it('Given 已有 pdf 标注 When 文本层渲染 Then 注入 mark[data-ann-id]', async () => {
    const { utils } = await renderReady({
      annotations: [makeAnn({ id: 'p1', anchor: { type: 'pdf', page: 1, before: '', after: '' } })],
    });
    await waitFor(() => {
      const mark = utils.container.querySelector('mark[data-ann-id="p1"]');
      expect(mark).not.toBeNull();
      expect(mark).toHaveClass('annotation-hl');
      expect(mark?.textContent).toBe('PDF 冒烟文本');
    });
  });

  it('Given 标注锚点失配 When 文本层渲染 Then 不注入 mark 不报错', async () => {
    const { utils } = await renderReady({
      annotations: [makeAnn({ id: 'gone', text: '旧文本', anchor: { type: 'pdf', page: 1, before: 'x', after: 'y' } })],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(utils.container.querySelector('mark[data-ann-id="gone"]')).toBeNull();
  });

  it('Given 在文本层选中文字 When 点「高亮」 Then onAnnotate 携带 kind=pdf + page', async () => {
    const { onAnnotate } = await renderReady();
    const span = document.querySelector('.annotation-text-layer span');
    expect(span).not.toBeNull();
    const range = document.createRange();
    range.selectNodeContents(span as Node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    span?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.queryByRole('toolbar', { name: '选中文字操作' })).not.toBeNull();
    });
    await user.click(screen.getByRole('button', { name: '高亮' }));

    expect(onAnnotate).toHaveBeenCalledTimes(1);
    const draft = onAnnotate.mock.calls[0][0] as {
      kind: string;
      text: string;
      anchor: { type: string; page: number; before: string; after: string };
    };
    expect(draft.kind).toBe('pdf');
    expect(draft.text).toBe('PDF 冒烟文本');
    expect(draft.anchor).toMatchObject({ type: 'pdf', page: 1 });
  });

  it('Given 同页同文本已有标注 When 再点「高亮」 Then onRemoveAnnotation(开关)', async () => {
    const { onRemoveAnnotation, onAnnotate } = await renderReady({
      annotations: [makeAnn({ id: 'p1', anchor: { type: 'pdf', page: 1, before: '', after: '' } })],
    });
    const span = document.querySelector('.annotation-text-layer span');
    const range = document.createRange();
    range.selectNodeContents(span as Node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    span?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.queryByRole('toolbar', { name: '选中文字操作' })).not.toBeNull();
    });
    await user.click(screen.getByRole('button', { name: '高亮' }));

    expect(onRemoveAnnotation).toHaveBeenCalledWith('p1');
    expect(onAnnotate).not.toHaveBeenCalled();
  });

  it('Given 点「划线」按钮 When 面板打开 Then 显示标注列表', async () => {
    const { utils } = await renderReady({ annotations: [makeAnn({ id: 'p1' })] });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '划线列表' }));
    expect(await screen.findByRole('complementary', { name: '划线列表' })).toBeInTheDocument();
    expect(utils.container.querySelector('.annotation-item-text')).toHaveTextContent('PDF 冒烟文本');
  });
});
