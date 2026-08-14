import { describe, expect, it } from 'vitest';
import { createPlanTool } from '../../src/main/pi-sdk-driver/web-tools/plan-tool';

const tool = createPlanTool();

describe('update_plan tool', () => {
  it('echoes a valid plan as text content', async () => {
    const params = {
      explanation: '先搜资料再写报告',
      plan: [
        { step: '搜索最新动态', status: 'in_progress' as const },
        { step: '阅读关键文章', status: 'pending' as const },
        { step: '综合成报告', status: 'pending' as const },
      ],
    };
    const result = await tool.execute('call-1', params, undefined, undefined, {} as never);

    const first = result.content[0];
    expect(first?.type).toBe('text');
    if (first?.type === 'text') {
      expect(JSON.parse(first.text)).toEqual(params);
    }
    expect(result.details).toEqual({});
  });

  it('rejects when more than one step is in_progress', async () => {
    await expect(
      tool.execute(
        'call-1',
        {
          plan: [
            { step: 'a', status: 'in_progress' as const },
            { step: 'b', status: 'in_progress' as const },
          ],
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow('同时只能有一个进行中的步骤');
  });

  it('rejects an empty plan (defensive; schema already enforces minItems)', async () => {
    await expect(
      tool.execute('call-1', { plan: [] }, undefined, undefined, {} as never),
    ).rejects.toThrow('计划不能为空');
  });

  it('exposes orchestration guidance via promptSnippet and promptGuidelines', () => {
    expect(tool.promptSnippet).toBeTruthy();
    expect(tool.promptSnippet).toContain('update_plan');
    const guidelines = tool.promptGuidelines ?? [];
    expect(guidelines.join('\n')).toContain('先调用 update_plan');
    expect(guidelines.join('\n')).toContain('最多一个步骤处于 in_progress');
  });

  it('names the tool update_plan with a UI label', () => {
    expect(tool.name).toBe('update_plan');
    expect(tool.label).toBe('任务计划');
  });
});
