import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCard } from '../../src/renderer/tool-card';

const base = { toolName: 'search', target: 'example' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ToolCard', () => {
  it('Given args When expanded Then pretty-printed JSON is shown in the detail', async () => {
    const user = userEvent.setup();
    render(
      <ToolCard
        {...base}
        status="ok"
        result="done"
        args={{ query: 'hello', limit: 3 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /search/ }));
    expect(screen.getByText(/"query": "hello"/)).toBeInTheDocument();
    expect(screen.getByText(/"limit": 3/)).toBeInTheDocument();
  });

  it('Given no args When expanded Then no args section is rendered', async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolCard {...base} status="ok" result="done" />);
    await user.click(screen.getByRole('button', { name: /search/ }));
    expect(container.querySelector('.tool-args')).toBeNull();
  });

  it('Given empty object args When expanded Then no args section is rendered', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolCard {...base} status="ok" result="done" args={{}} />,
    );
    await user.click(screen.getByRole('button', { name: /search/ }));
    expect(container.querySelector('.tool-args')).toBeNull();
  });

  it('Given toolName When 渲染 Then 显示工具类型图标', () => {
    const { container } = render(<ToolCard {...base} toolName="read" status="ok" result="done" />);
    expect(container.querySelector('.tool-type-icon')).not.toBeNull();
  });

  it('Given args + result When expanded Then 输入/输出双分区都存在', async () => {
    const user = userEvent.setup();
    render(
      <ToolCard
        {...base}
        toolName="read"
        status="ok"
        result="done"
        args={{ query: 'hello' }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /read/ }));
    expect(screen.getByText('输入')).toBeInTheDocument();
    expect(screen.getByText('输出')).toBeInTheDocument();
  });

  it('Given result 250 行 When expanded Then 截断为 200 行并提示省略行数', async () => {
    const user = userEvent.setup();
    const longResult = Array.from({ length: 250 }, (_, i) => `line${i}`).join('\n');
    const { container } = render(
      <ToolCard {...base} toolName="read" status="ok" result={longResult} />,
    );
    await user.click(screen.getByRole('button', { name: /read/ }));
    expect(screen.getByText('… 50 行已省略')).toBeInTheDocument();
    const text = container.querySelector('.tool-output-text')?.textContent ?? '';
    expect(text.startsWith('line0')).toBe(true);
    expect(text).not.toContain('line249');
  });

  it('Given result 多行 When expanded Then 行号列每行一个数字', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolCard {...base} toolName="read" status="ok" result={'line1\nline2'} />,
    );
    await user.click(screen.getByRole('button', { name: /read/ }));
    const numbers = Array.from(container.querySelectorAll('.tool-output-lines div')).map(
      (el) => el.textContent,
    );
    expect(numbers).toEqual(['1', '2']);
  });

  it('Given 复制输出按钮 When clicked Then clipboard 收到结果文本', async () => {
    // userEvent.setup 会用自己的 Clipboard stub 覆盖 navigator.clipboard,
    // 必须在 setup 之后再定义 mock,组件里的 writeText 才是被测对象。
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ToolCard {...base} toolName="read" status="ok" result="复制我" />);
    await user.click(screen.getByRole('button', { name: /read/ }));
    await user.click(screen.getByRole('button', { name: '复制输出' }));
    expect(writeText).toHaveBeenCalledWith('复制我');
  });

  describe('ToolCard 紧凑行(pi-gui 形态)', () => {
    it('write 成功:label 显示「已编辑 路径」(≤3 段原样),不再单独显示 target', () => {
      render(
        <ToolCard
          {...base}
          toolName="write"
          target="src/main.ts"
          status="ok"
          result="done"
        />,
      );
      expect(
        screen.getByRole('button', { name: /已编辑 src\/main\.ts/ }),
      ).toBeInTheDocument();
      expect(screen.queryByText('src/main.ts')).toBeNull();
    });

    it('深路径 write:label 只保留末 3 段', () => {
      render(
        <ToolCard
          {...base}
          toolName="write"
          target="workspace/project/src/a/b/c.ts"
          status="ok"
          result="done"
        />,
      );
      expect(
        screen.getByRole('button', { name: /已编辑 a\/b\/c\.ts/ }),
      ).toBeInTheDocument();
    });

    it('write + diff 结果:显示 +N/-M 统计', () => {
      render(
        <ToolCard
          {...base}
          toolName="write"
          target="src/a.ts"
          status="ok"
          result={'diff --git a/src/a.ts b/src/a.ts\n@@ -1,3 +1,4 @@\n+新行\n-旧行'}
        />,
      );
      expect(screen.getByText('+1')).toBeInTheDocument();
      expect(screen.getByText('-1')).toBeInTheDocument();
    });

    it('非 write 工具:label 仍为工具名,无 diff 统计', () => {
      const { container } = render(
        <ToolCard {...base} toolName="read" target="src/a.ts" status="ok" result="done" />,
      );
      expect(screen.getByRole('button', { name: /read/ })).toBeInTheDocument();
      expect(container.querySelector('.tool-diff-stats')).toBeNull();
    });
  });
});
