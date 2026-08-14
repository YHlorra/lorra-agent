import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Annotation, AnnotationDraft } from '../shared/annotations';
import {
  AnnotationLayer,
  anchorAround,
  findOverlappingAnnotation,
  matchTextAnchor,
} from './annotation-layer';

function makeAnn(over: Partial<Annotation> & { id: string }): Annotation {
  return {
    relPath: 'a.md',
    kind: 'md',
    text: '目标文本',
    anchor: { type: 'text', before: '', after: '' },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('matchTextAnchor', () => {
  it('Given 文本跨多个文本节点 When 匹配 Then 返回覆盖完整文本的 Range', () => {
    const host = document.createElement('div');
    host.innerHTML = '前文<strong>目</strong>标<em>文</em>本后文';
    const range = matchTextAnchor(host, { before: '前文', text: '目标文本', after: '后文' });
    expect(range).not.toBeNull();
    expect(range?.toString()).toBe('目标文本');
  });

  it('Given 同文本出现两次 When 带上下文锚点 Then 选中正确的那次', () => {
    const host = document.createElement('div');
    host.textContent = '第一次出现关键词位置A 第二次出现关键词位置B';
    // 锚点定位第二次出现(前文 = 第二次出现)
    const range = matchTextAnchor(host, {
      before: '第二次出现',
      text: '关键词',
      after: '位置B',
    });
    expect(range?.toString()).toBe('关键词');
    // 单文本节点下 startOffset = needle 起点 + before 长度
    const text = host.textContent ?? '';
    const secondAt = text.indexOf('第二次出现');
    expect(range?.startOffset).toBe(secondAt + '第二次出现'.length);
  });

  it('Given 无上下文(空 before/after)When 匹配 Then 用 text 全文定位', () => {
    const host = document.createElement('div');
    host.textContent = 'abc目标def';
    const range = matchTextAnchor(host, { before: '', text: '目标', after: '' });
    expect(range?.toString()).toBe('目标');
  });

  it('Given 文本不存在 When 匹配 Then 返回 null', () => {
    const host = document.createElement('div');
    host.textContent = '完全不同的内容';
    expect(matchTextAnchor(host, { before: 'x', text: '不存在的', after: 'y' })).toBeNull();
  });
});

describe('anchorAround', () => {
  it('Given 选区文本 When 调用 Then 取前后各 50 字符(此处截短)', () => {
    const host = document.createElement('div');
    host.textContent =
      '前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面前面中间目标后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面后面';
    const anchor = anchorAround(host, '中间目标');
    expect(anchor.before).toHaveLength(50);
    expect(anchor.after).toHaveLength(50);
    expect(anchor.before.endsWith('面前面')).toBe(true);
    expect(anchor.after.startsWith('后面')).toBe(true);
    expect(anchor.text).toBe('中间目标');
  });

  it('Given 选区在文本开头 When 调用 Then before 为空', () => {
    const host = document.createElement('div');
    host.textContent = '开头目标后面内容';
    const anchor = anchorAround(host, '开头目标');
    expect(anchor.before).toBe('');
    expect(anchor.after).toBe('后面内容');
  });

  it('Given 文本不存在 When 调用 Then 返回全空锚点', () => {
    const host = document.createElement('div');
    host.textContent = '正文';
    expect(anchorAround(host, '没有的')).toEqual({ before: '', after: '', text: '' });
  });
});

describe('findOverlappingAnnotation(Office 式开关)', () => {
  function makeDraft(over: Partial<AnnotationDraft> & { id: string }): AnnotationDraft {
    return {
      kind: 'md',
      text: '目标文本',
      anchor: { type: 'text', before: '前文', after: '后文' },
      createdAt: '2026-08-01T00:00:00.000Z',
      ...over,
    };
  }

  it('Given 同文本同锚点 When 检测 Then 命中(再次高亮 = 取消)', () => {
    const list = [
      makeAnn({
        id: 'a1',
        text: '目标文本',
        anchor: { type: 'text', before: '前文', after: '后文' },
      }),
    ];
    expect(findOverlappingAnnotation(list, makeDraft({ id: 'new' }))?.id).toBe('a1');
  });

  it('Given 同文本不同锚点(不同位置) When 检测 Then 不命中', () => {
    const list = [
      makeAnn({
        id: 'a1',
        text: '目标文本',
        anchor: { type: 'text', before: '另一处前文', after: '后文' },
      }),
    ];
    expect(findOverlappingAnnotation(list, makeDraft({ id: 'new' }))).toBeUndefined();
  });

  it('Given 不同 kind When 检测 Then 不命中', () => {
    const list = [{ ...makeAnn({ id: 'a1' }), kind: 'code' as const }];
    expect(findOverlappingAnnotation(list, makeDraft({ id: 'new' }))).toBeUndefined();
  });

  it('Given epub 同 CFI When 检测 Then 命中', () => {
    const list: Annotation[] = [
      { ...makeAnn({ id: 'e1' }), kind: 'epub', anchor: { type: 'cfi', cfi: '/6/4' } },
    ];
    const draft = makeDraft({ id: 'new', kind: 'epub', anchor: { type: 'cfi', cfi: '/6/4' } });
    expect(findOverlappingAnnotation(list, draft)?.id).toBe('e1');
  });

  it('Given pdf 同页同锚点 When 检测 Then 命中;异页不命中', () => {
    const list: Annotation[] = [
      {
        ...makeAnn({ id: 'p1' }),
        kind: 'pdf',
        text: '目标文本',
        anchor: { type: 'pdf', page: 3, before: '前文', after: '后文' },
      },
    ];
    expect(
      findOverlappingAnnotation(
        list,
        makeDraft({
          id: 'new',
          kind: 'pdf',
          anchor: { type: 'pdf', page: 3, before: '前文', after: '后文' },
        }),
      )?.id,
    ).toBe('p1');
    expect(
      findOverlappingAnnotation(
        list,
        makeDraft({
          id: 'new',
          kind: 'pdf',
          anchor: { type: 'pdf', page: 4, before: '前文', after: '后文' },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('AnnotationLayer', () => {
  it('Given md 标注 When 渲染 Then 注入 mark[data-ann-id]', async () => {
    render(
      <AnnotationLayer annotations={[makeAnn({ id: 'a1', text: '高亮我' })]}>
        <p>前面高亮我后面</p>
      </AnnotationLayer>,
    );
    const mark = await screen.findByText('高亮我');
    expect(mark.tagName).toBe('MARK');
    expect(mark).toHaveClass('annotation-hl');
    expect(mark).toHaveAttribute('data-ann-id', 'a1');
  });

  it('Given 同文本出现两次 When 上下文锚点消歧 Then 只高亮命中那次', async () => {
    render(
      <AnnotationLayer
        annotations={[
          makeAnn({
            id: 'a2',
            text: '重复词',
            anchor: { type: 'text', before: '第二次 ', after: ' 收尾' },
          }),
        ]}
      >
        <p>第一次 重复词 中间 第二次 重复词 收尾</p>
      </AnnotationLayer>,
    );
    const marks = document.querySelectorAll('mark[data-ann-id="a2"]');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('重复词');
  });

  it('Given 锚点失配(原文已编辑)When 渲染 Then 不注入 mark,onStale 收到该 id', () => {
    const spy = vi.fn();
    render(
      <AnnotationLayer annotations={[makeAnn({ id: 'gone', text: '旧文本' })]} onStale={spy}>
        <p>新内容</p>
      </AnnotationLayer>,
    );
    expect(document.querySelector('mark[data-ann-id="gone"]')).toBeNull();
    expect(spy).toHaveBeenCalledWith(['gone']);
  });

  it('Given epub 标注 When 渲染 Then 跳过(高亮只处理 md/code,不崩)', async () => {
    render(
      <AnnotationLayer
        annotations={[
          { ...makeAnn({ id: 'e1' }), kind: 'epub', anchor: { type: 'cfi', cfi: '/6/4' } },
        ]}
      >
        <p>epub 内容</p>
      </AnnotationLayer>,
    );
    expect(document.querySelector('mark[data-ann-id="e1"]')).toBeNull();
  });

  it('Given 内容重渲染 When 标注不变 Then mark 重新注入且不重复', async () => {
    const { rerender } = render(
      <AnnotationLayer annotations={[makeAnn({ id: 'r1', text: '重渲染目标' })]}>
        <p>重渲染目标</p>
      </AnnotationLayer>,
    );
    await screen.findByText('重渲染目标');
    expect(document.querySelectorAll('mark[data-ann-id="r1"]')).toHaveLength(1);

    rerender(
      <AnnotationLayer annotations={[makeAnn({ id: 'r1', text: '重渲染目标' })]}>
        <p>重渲染目标</p>
      </AnnotationLayer>,
    );
    await screen.findByText('重渲染目标');
    expect(document.querySelectorAll('mark[data-ann-id="r1"]')).toHaveLength(1);
  });
});
