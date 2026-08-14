import { createElement } from 'react';
import { beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { useAppStore } from '@/lib/app-store';
import type { LorraResult } from '../shared/result';

// react-resizable-panels v4 在 jsdom 下与 user-event 打字冲突(实测:同一受控
// input,无 Separator 时打字正常,有 Separator 时不响应;真实浏览器无此问题,
// 属库内部测量/焦点逻辑与 jsdom 的交互怪癖)。测试环境用透传 mock:Group/Panel
// 渲染为普通容器,useDefaultLayout 返回 no-op;真实拖拽属于浏览器交互,不进
// jsdom 单测(由走查/手工回归覆盖),App 的分栏接线逻辑仍走真实代码。
vi.mock('react-resizable-panels', () => {
  const Div = (props: Record<string, unknown>) => createElement('div', props);
  return {
    Group: (props: Record<string, unknown>) => createElement('div', props),
    Panel: (props: Record<string, unknown>) => createElement(Div, props),
    Separator: (props: Record<string, unknown>) =>
      createElement('div', { role: 'separator', ...props }),
    useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: () => {} }),
  };
});

// radix ScrollArea 依赖 ResizeObserver,jsdom 不提供;补最小 stub 让挂载不炸。
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// pdfjs-dist v6 模块顶层有 `new DOMMatrix`(SCALE_MATRIX),jsdom 无 DOMMatrix。
// 最小 stub:仅保证 import 不炸;真实变换逻辑由 pdf-viewer.test 的整模块 mock 覆盖。
class DOMMatrixStub {
  constructor(init?: string | number[]) {
    if (typeof init === 'string' && init.length > 0) {
      const values = init.split(',').map(Number);
      const keys = [
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        'm11',
        'm12',
        'm13',
        'm14',
        'm21',
        'm22',
        'm23',
        'm24',
        'm31',
        'm32',
        'm33',
        'm34',
        'm41',
        'm42',
        'm43',
        'm44',
      ];
      keys.forEach((key, i) => {
        const v = values[i];
        if (v !== undefined) {
          (this as unknown as Record<string, number>)[key] = v;
        }
      });
    }
  }
  multiplySelf(): this {
    return this;
  }
  preMultiplySelf(): this {
    return this;
  }
  translate(): this {
    return this;
  }
  scale(): this {
    return this;
  }
  invertSelf(): this {
    return this;
  }
  rotateSelf(): this {
    return this;
  }
}
globalThis.DOMMatrix = DOMMatrixStub as unknown as typeof DOMMatrix;

// cmdk 选中项滚动时调用 scrollIntoView,jsdom 未实现。
Element.prototype.scrollIntoView = () => {};

// 发送后「对话框移到最新」(2026-08-09 UX 调整):chat-stream scrollTo,jsdom 未实现。
Element.prototype.scrollTo = () => {};

// Store 是模块级单例:页面路由状态会跨测试用例泄漏,每个用例重置回工作台。
// 主题/折叠偏好/语言/隐藏文件同样跨用例泄漏,重置回默认并清掉 localStorage 与 html.dark。
beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  useAppStore.setState({
    page: 'workspace',
    theme: 'light',
    navCollapsed: false,
    language: 'zh',
    showHiddenFiles: false,
    defaultHideThinking: false,
  });
});

// Electron's contextBridge is not present in jsdom; provide a default stub so
// components that call `window.lorra.*` during mount can run in unit tests.
// Individual tests may override the stub via `vi.spyOn(window.lorra, ...)`.
declare global {
  // eslint-disable-next-line no-var
  var __lorraStub: { workspacePath: string | null } | undefined;
}

// better-result v3 迁移:preload 经 toView 输出渲染层形状 {ok,value}/{ok,error},
// 消费方以 res.ok 判别;stub 必须同形状(旧 BR 实例是 {status:'ok'},res.ok 恒为 undefined)。
const okRpc = <T>(value: T): Promise<LorraResult<T>> => Promise.resolve({ ok: true, value });
const errorRpc = (code: string, message: string): Promise<LorraResult<never>> =>
  Promise.resolve({ ok: false, error: { code, message } });

const stub = {
  platform: 'win32' as NodeJS.Platform,
  app: {
    info: () => Promise.resolve({ version: '0.0.0-test', name: 'lorra' }),
    licenses: () => Promise.resolve([]),
  },
  window: {
    minimize: () => Promise.resolve(true),
    toggleMaximize: () => Promise.resolve(true),
    close: () => Promise.resolve(true),
  },
  workspace: {
    pick: () => Promise.resolve({ path: globalThis.__lorraStub?.workspacePath ?? null }),
    switch: () => Promise.resolve({ path: globalThis.__lorraStub?.workspacePath ?? null }),
    get: () => Promise.resolve({ path: globalThis.__lorraStub?.workspacePath ?? null }),
    activate: (path: string) =>
      Promise.resolve({ path: path ?? globalThis.__lorraStub?.workspacePath ?? null }),
    list: () =>
      Promise.resolve({
        workspaces: globalThis.__lorraStub?.workspacePath
          ? [globalThis.__lorraStub.workspacePath]
          : [],
      }),
    remove: () => Promise.resolve({ workspaces: [] }),
  },
  session: {
    list: () => errorRpc('not-implemented', 'no session stub'),
    open: () => errorRpc('not-implemented', 'no session stub'),
    continueRecent: () => errorRpc('not-implemented', 'no session stub'),
    create: () => errorRpc('not-implemented', 'no session stub'),
    send: () => errorRpc('not-implemented', 'no session stub'),
    abort: () => errorRpc('not-implemented', 'no session stub'),
    compact: () => errorRpc('not-implemented', 'no compact stub'),
    respondApproval: () => errorRpc('not-implemented', 'no approval stub'),
  },
  fs: {
    tree: () =>
      okRpc([] as Array<{ id: string; name: string; type: 'file' | 'dir'; hasChildren: boolean }>),
    search: () => okRpc([] as Array<{ fileId: string; name: string }>),
    open: () => errorRpc('not-implemented', 'no fs stub'),
    openBinary: () => errorRpc('not-implemented', 'no fs stub'),
  },
  annotations: {
    list: () => errorRpc('not-implemented', 'no annotations stub'),
    save: () => errorRpc('not-implemented', 'no annotations stub'),
    remove: () => errorRpc('not-implemented', 'no annotations stub'),
  },
  events: {
    subscribe: () => () => {},
  },
  settings: {
    get: () =>
      okRpc({
        showHiddenFiles: false,
        language: 'zh',
        defaultHideThinking: false,
        compileModel: null,
        dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
      }),
    set: () => okRpc(undefined),
  },
  plugins: {
    list: () => okRpc({ plugins: [] }),
  },
  providers: {
    catalog: () => okRpc([]),
    list: () => okRpc([]),
    connect: () => okRpc(undefined),
    disconnect: () => okRpc(undefined),
    getAuthStatus: () => okRpc({ configured: false }),
    testConnection: () => okRpc(undefined),
    custom: { add: () => okRpc(undefined), remove: () => okRpc(undefined) },
  },
  models: {
    list: () => okRpc([]),
    getDefault: () => okRpc({ providerId: 'anthropic', modelId: 'claude-test' }),
    setDefault: () => okRpc(undefined),
    toggle: () => okRpc(undefined),
    getAvailable: () =>
      okRpc([
        {
          id: 'claude-test',
          name: 'Claude Test',
          provider: 'anthropic',
          contextWindow: 200000,
          maxTokens: 8192,
          reasoning: false,
          enabled: true,
          default: true,
          available: true,
        },
      ]),
  },
};

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'lorra', {
    value: stub,
    writable: true,
    configurable: true,
  });
}
