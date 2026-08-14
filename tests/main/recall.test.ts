import { describe, expect, it, vi } from 'vitest';
import {
  buildRecallContext,
  RECALL_CONTENT_MAX_CHARS,
  RECALL_CONTEXT_MARKER,
  stripRecallContext,
} from '../../src/main/memory/recall';
import { MEMORY_RECALL_TOP_K, type MemoryEntry } from '../../src/shared/memory-schema';

// 召回注入组装(design 6.6)契约:
// - 单次调 getSharedMemoryStore.recall({ scope: 'workspace', workspace, k })
// 取「user 级全局 + 当前工作区」生效条目(agent 级恒命中由 store 负责)
// - 每条渲染为「类别 + 标题 + 内容截断(~200 字)+ 证据标注」
// - fail-open:store Err/抛错/无候选 → 空串,绝不抛,绝不阻塞会话启动
//
// shared-memory-store 用假 store 替换(契约镜像:user 级恒命中 + workspace 匹配,
// 与 MemoryStoreCore 的 recall scope 语义一致),测试钉死 buildRecallContext 的
// 调用约定与渲染输出,不依赖 store 落地进度。

const { fakeStore } = vi.hoisted(() => {
  return {
    fakeStore: {
      entries: [] as MemoryEntry[],
      recallArgs: [] as Array<Record<string, unknown>>,
      failMode: 'ok' as 'ok' | 'err' | 'throw',
    },
  };
});

vi.mock('../../src/main/memory/shared-memory-store', () => ({
  getSharedMemoryStore: () => {
    if (fakeStore.failMode === 'err') {
      return { isErr: () => true, error: { code: 'store-unavailable', message: 'db gone' } };
    }
    return {
      isErr: () => false,
      value: {
        recall: (params: Record<string, unknown>) => {
          fakeStore.recallArgs.push(params);
          if (fakeStore.failMode === 'throw') throw new Error('db gone');
          // 契约镜像:user 级恒命中 + workspace 匹配(scope='workspace' 单次查询)
          const hits = fakeStore.entries.filter(
            (e) => e.scope === 'user' || e.workspace === params.workspace,
          );
          return { isErr: () => false, value: hits };
        },
      },
    };
  },
  resetSharedMemoryStoreForTest: () => {},
}));

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    entryId: 'id-' + (overrides.title ?? 'entry'),
    schemaVersion: 1,
    tags: [],
    kind: 'working_context',
    title: '标题',
    content: '内容',
    producer: 'agent-1',
    source: 'agent-proposal',
    scope: 'workspace',
    workspace: 'C:/work/demo',
    evidence: 'user-stated',
    basis: 'basis',
    lifecycle: 'active',
    supersedes: null,
    createdAt: 1,
    updatedAt: 1,
    confirmedAt: 1,
    ofkRef: null,
    ...overrides,
  };
}

describe('buildRecallContext(design 6.6 召回注入组装)', () => {
  beforeEach(() => {
    fakeStore.entries = [];
    fakeStore.recallArgs = [];
    fakeStore.failMode = 'ok';
  });

  it('四 evidence 各一条 → 注入文本含对应证据标注(你明说的/观察/agent 推断/未验证)', () => {
    fakeStore.entries = [
      makeEntry({ title: 'A', evidence: 'user-stated' }),
      makeEntry({ title: 'B', evidence: 'extracted' }),
      makeEntry({ title: 'C', evidence: 'inferred' }),
      makeEntry({ title: 'D', evidence: 'unverified' }),
    ];
    const block = buildRecallContext({ workspace: 'C:/work/demo' });

    expect(block).toContain('(你明说的)');
    expect(block).toContain('(观察)');
    expect(block).toContain('(agent 推断)');
    expect(block).toContain('(未验证)');
    // 每条记忆输出「类别标签 + 标题 + 内容」
    expect(block).toContain('[working_context]');
    expect(block).toContain('A');
    expect(block).toContain('D');
  });

  it('workspace 隔离: A 工作区条目不注入 B 工作区上下文, recall 以当前 workspace 查询', () => {
    fakeStore.entries = [
      makeEntry({ title: 'AAA note', workspace: 'WA' }),
      makeEntry({ title: 'BBB note', workspace: 'WB' }),
    ];

    const blockB = buildRecallContext({ workspace: 'WB' });
    expect(blockB).toContain('BBB note');
    expect(blockB).not.toContain('AAA note');
    expect(fakeStore.recallArgs.at(-1)).toEqual({
      scope: 'workspace',
      workspace: 'WB',
      k: MEMORY_RECALL_TOP_K,
    });

    const blockA = buildRecallContext({ workspace: 'WA' });
    expect(blockA).toContain('AAA note');
    expect(blockA).not.toContain('BBB note');
  });

  it('user 级条目跨工作区可见', () => {
    fakeStore.entries = [
      makeEntry({ title: '全局条目', scope: 'user', workspace: null }),
      makeEntry({ title: 'B 专属条目', workspace: 'WB' }),
    ];

    const blockB = buildRecallContext({ workspace: 'WB' });
    expect(blockB).toContain('全局条目');
    expect(blockB).toContain('B 专属条目');

    const blockA = buildRecallContext({ workspace: 'WA' });
    expect(blockA).toContain('全局条目');
    expect(blockA).not.toContain('B 专属条目');
  });

  it('k 透传: 显式 k 传给 recall, 缺省用 MEMORY_RECALL_TOP_K', () => {
    buildRecallContext({ workspace: 'WB', k: 3 });
    expect(fakeStore.recallArgs.at(-1)).toEqual({ scope: 'workspace', workspace: 'WB', k: 3 });

    buildRecallContext({ workspace: 'WB' });
    expect(fakeStore.recallArgs.at(-1)).toEqual({
      scope: 'workspace',
      workspace: 'WB',
      k: MEMORY_RECALL_TOP_K,
    });
  });

  it('内容截断: 超 RECALL_CONTENT_MAX_CHARS 的内容截断并附省略号', () => {
    const longContent = '长'.repeat(RECALL_CONTENT_MAX_CHARS + 10);
    fakeStore.entries = [makeEntry({ content: longContent })];
    const block = buildRecallContext({ workspace: 'C:/work/demo' });

    expect(block).toContain('长'.repeat(RECALL_CONTENT_MAX_CHARS) + '…');
    expect(block).not.toContain('长'.repeat(RECALL_CONTENT_MAX_CHARS + 1));
  });

  it('长页多段 → 注入含标题 + 首段, 不含末段(段落感知截断 6.14)', () => {
    const firstPara = '首'.repeat(RECALL_CONTENT_MAX_CHARS + 10);
    const content = `${firstPara}\n\n中间段\n\n末段标记XYZ`;
    fakeStore.entries = [makeEntry({ title: '长页标题', content })];
    const block = buildRecallContext({ workspace: 'C:/work/demo' });

    expect(block).toContain('长页标题');
    expect(block).toContain('首'.repeat(RECALL_CONTENT_MAX_CHARS));
    expect(block).not.toContain('末段标记XYZ');
    expect(block).not.toContain('中间段');
  });

  it('query 命中末段 → 注入含命中段(末段)而非首段, query 透传 recall', () => {
    const longFirst = '首段内容' + '长'.repeat(RECALL_CONTENT_MAX_CHARS);
    const content = `${longFirst}\n\n中间段\n\n末段包含查询词 Kubernetes 部署`;
    fakeStore.entries = [makeEntry({ title: '长页', content })];
    const block = buildRecallContext({ workspace: 'C:/work/demo', query: 'Kubernetes' });

    expect(block).toContain('长页');
    expect(block).toContain('末段包含查询词 Kubernetes 部署');
    expect(block).not.toContain('首段内容');
    expect(block).not.toContain('中间段');
    expect(fakeStore.recallArgs.at(-1)).toEqual({
      scope: 'workspace',
      workspace: 'C:/work/demo',
      k: MEMORY_RECALL_TOP_K,
      query: 'Kubernetes',
    });
  });

  it('query 无命中段 → 回退首段', () => {
    const firstPara = '首段文字' + '长'.repeat(RECALL_CONTENT_MAX_CHARS);
    const content = `${firstPara}\n\n次段文字`;
    fakeStore.entries = [makeEntry({ title: '页', content })];
    const block = buildRecallContext({ workspace: 'C:/work/demo', query: '完全不存在' });

    expect(block).toContain('首段文字');
    expect(block).not.toContain('次段文字');
  });

  it('无空行分段(仅单换行) → 取首行', () => {
    const firstLine = '首'.repeat(150);
    const content = `${firstLine}\n${'尾'.repeat(100)}`;
    fakeStore.entries = [makeEntry({ content })];
    const block = buildRecallContext({ workspace: 'C:/work/demo' });

    expect(block).toContain('首'.repeat(150));
    expect(block).not.toContain('尾');
  });

  it('内容不超上限 → 原样全文注入(不截断)', () => {
    const content = '短首段\n\n短末段';
    fakeStore.entries = [makeEntry({ title: '短页', content })];
    const block = buildRecallContext({ workspace: 'C:/work/demo' });

    expect(block).toContain(content);
  });

  it('截断后仍超上限 → 段落尾部裁剪 + … 且无 U+FFFD(不切碎代理对)', () => {
    // 200 字符边界落在 astral 字符(𠀀 = 2 个 UTF-16 单元)中间:
    // 朴素 slice 会产生孤立代理, 编码后变 U+FFFD, 段落感知截断必须避免
    const content = 'a'.repeat(RECALL_CONTENT_MAX_CHARS - 1) + '𠀀' + '尾';
    expect(content.length).toBeGreaterThan(RECALL_CONTENT_MAX_CHARS);
    fakeStore.entries = [makeEntry({ content })];
    const block = buildRecallContext({ workspace: 'C:/work/demo' });

    expect(block).toContain('…');
    expect(block).not.toContain('\uFFFD');
    const bytes = Buffer.from(block, 'utf8');
    expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it('无候选 → 空串(不注入任何内容)', () => {
    fakeStore.entries = [];
    expect(buildRecallContext({ workspace: 'C:/work/demo' })).toBe('');
  });

  it('store 抛错(mock) → 空串不抛(fail-open)', () => {
    fakeStore.failMode = 'throw';
    expect(buildRecallContext({ workspace: 'C:/work/demo' })).toBe('');
  });

  it('store Err → 空串不抛(fail-open)', () => {
    fakeStore.failMode = 'err';
    expect(buildRecallContext({ workspace: 'C:/work/demo' })).toBe('');
  });

  it('导出 RECALL_CONTEXT_MARKER 常量(注入断言锚点)', () => {
    expect(RECALL_CONTEXT_MARKER.length).toBeGreaterThan(0);
  });

  // 一跳检索渲染:recall 返回 k 条命中 + 关联页时,
  // 前 k 行渲染为主命中(无标注),k 位之后追加「关联页」标注行。
  it('6 条返回(k=5 命中 + 1 关联)→ 前 5 行无标注,第 6 行含「，关联页」', () => {
    fakeStore.entries = [
      makeEntry({ title: 'H1' }),
      makeEntry({ title: 'H2' }),
      makeEntry({ title: 'H3' }),
      makeEntry({ title: 'H4' }),
      makeEntry({ title: 'H5' }),
      makeEntry({ title: '关联页A' }),
    ];
    const block = buildRecallContext({ workspace: 'C:/work/demo', k: 5 });
    const lines = block.split('\n');

    expect(lines).toHaveLength(6);
    for (const line of lines.slice(0, 5)) {
      expect(line).not.toContain('，关联页');
    }
    expect(lines[5]).toContain('[working_context] 关联页A');
    expect(lines[5]).toContain('，关联页');
  });

  it('恰好 5 条(k=5 无关联)→ 全部按主命中渲染,无「，关联页」标注', () => {
    fakeStore.entries = [
      makeEntry({ title: 'H1' }),
      makeEntry({ title: 'H2' }),
      makeEntry({ title: 'H3' }),
      makeEntry({ title: 'H4' }),
      makeEntry({ title: 'H5' }),
    ];
    const block = buildRecallContext({ workspace: 'C:/work/demo', k: 5 });

    expect(block.split('\n')).toHaveLength(5);
    expect(block).not.toContain('，关联页');
  });

  it('关联页渲染与主命中同构:类别标签 + 标题 + 截断内容 + 证据标注', () => {
    const longContent = '关'.repeat(RECALL_CONTENT_MAX_CHARS + 50);
    fakeStore.entries = [
      makeEntry({ title: 'H1', evidence: 'extracted' }),
      makeEntry({ title: '关联页B', evidence: 'inferred', content: longContent }),
    ];
    const block = buildRecallContext({ workspace: 'C:/work/demo', k: 1 });
    const lines = block.split('\n');

    expect(lines[1]).toContain('[working_context] 关联页B');
    expect(lines[1]).toContain('(agent 推断，关联页)');
    expect(lines[1]).toContain('…'); // 内容仍走段落感知截断
  });
});

// ---------------------------------------------------------------------------
// stripRecallContext(2026-08-09 走查实证修复):召回注入块随用户消息进会话
// jsonl,显示层剥离 marker 包裹前缀——用户气泡只见自己的原文,注入内容不可见。
// ---------------------------------------------------------------------------

describe('stripRecallContext(显示层剥离注入块)', () => {
  const injected = (block: string, userText: string): string =>
    `${RECALL_CONTEXT_MARKER}\n${block}\n${RECALL_CONTEXT_MARKER}\n\n${userText}`;

  it('Given 消息含注入块前缀 When 剥离 Then 只剩用户原文', () => {
    const text = injected(
      '- [soft_preference] 咖啡偏好：喜欢美式咖啡。(你明说的)',
      '我喜欢喝什么咖啡？',
    );
    expect(stripRecallContext(text)).toBe('我喜欢喝什么咖啡？');
  });

  it('Given 注入块含多行记忆 When 剥离 Then 用户原文完整保留', () => {
    const block = '- [a] 第一条\n- [b] 第二条\n- [c] 第三条';
    const text = injected(block, '帮我看看这个');
    expect(stripRecallContext(text)).toBe('帮我看看这个');
  });

  it('Given 无 marker 的普通消息 When 剥离 Then 原样返回(零改动)', () => {
    expect(stripRecallContext('普通消息')).toBe('普通消息');
  });

  it('Given 只有起始 marker 无闭合 marker When 剥离 Then 保守原样返回', () => {
    const text = `${RECALL_CONTEXT_MARKER}\n未闭合块`;
    expect(stripRecallContext(text)).toBe(text);
  });

  it('Given 用户原文本身含 marker 字样 When 剥离 Then 只剥首个成对块,其余保留', () => {
    const text = injected('块', `原文提到 ${RECALL_CONTEXT_MARKER}`);
    expect(stripRecallContext(text)).toBe(`原文提到 ${RECALL_CONTEXT_MARKER}`);
  });
});

describe('buildRecallContext ofkRef 标注（）', () => {
  it('条目带 ofkRef → 输出行尾追加「（文档：<ref>）」', () => {
    fakeStore.failMode = 'ok';
    fakeStore.entries = [makeEntry({ title: '长文档', ofkRef: '/memory/abc.md' })];
    const ctx = buildRecallContext({ workspace: 'C:/work/demo' });
    expect(ctx).toContain('（文档：/memory/abc.md）');
  });

  it('ofkRef 为 null → 无标注行(保持既有形状)', () => {
    fakeStore.failMode = 'ok';
    fakeStore.entries = [makeEntry({ title: '普通条目' })];
    const ctx = buildRecallContext({ workspace: 'C:/work/demo' });
    expect(ctx).not.toContain('（文档：');
  });
});
