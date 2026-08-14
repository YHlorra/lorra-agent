import { describe, expect, it, vi } from 'vitest';
import {
  createInstallSkillTool,
  type InstallSkillToolDeps,
  SKILL_INSTALL_TOOL_NAME,
} from '../../src/main/pi-sdk-driver/skill-tools/install-skill-tool';
import { err, ok } from '../../src/shared/result';

function makeTool(installImpl?: InstallSkillToolDeps['install']) {
  const install = vi.fn(
    installImpl ?? (async () => ok({ name: 'demo-skill', path: 'E:/collection/demo-skill' })),
  );
  return { tool: createInstallSkillTool({ install }), install };
}

describe('install_skill tool', () => {
  it('安装成功 → 文本含技能名与路径,details 带元数据', async () => {
    const { tool } = makeTool();
    const result = await tool.execute(
      'call-1',
      { git_url: 'https://github.com/x/demo-skill.git' },
      undefined,
      undefined,
      {} as never,
    );

    const first = result.content[0];
    expect(first?.type).toBe('text');
    if (first?.type === 'text') {
      expect(first.text).toContain('demo-skill');
      expect(first.text).toContain('E:/collection/demo-skill');
    }
    expect(result.details).toEqual({ name: 'demo-skill', path: 'E:/collection/demo-skill' });
  });

  it('安装失败 → execute 抛错,文案 = PM 语域 message', async () => {
    const { tool } = makeTool(async () =>
      err({ code: 'not-a-skill', message: '该仓库不是技能（缺少 SKILL.md）' }),
    );
    await expect(
      tool.execute(
        'call-1',
        { git_url: 'https://github.com/x/nope.git' },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow('该仓库不是技能（缺少 SKILL.md）');
  });

  it('把 git_url 原样传给安装函数', async () => {
    const { tool, install } = makeTool();
    await tool.execute(
      'call-1',
      { git_url: 'https://github.com/x/y.git' },
      undefined,
      undefined,
      {} as never,
    );
    expect(install).toHaveBeenCalledWith('https://github.com/x/y.git');
  });

  it('暴露工具元数据:名字 / 中文 label / 执行模式 sequential', () => {
    const { tool } = makeTool();
    expect(tool.executionMode).toBe('sequential');
    expect(tool.name).toBe(SKILL_INSTALL_TOOL_NAME);
    expect(tool.label).toBe('安装技能');
    expect(tool.description).toContain('install_skill');
  });
});
