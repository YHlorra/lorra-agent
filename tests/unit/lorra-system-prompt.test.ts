import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLorraSystemPrompt } from '../../src/main/pi-sdk-driver/lorra-system-prompt';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildLorraSystemPrompt', () => {
  it('注入运行时真实配置路径(非硬编码),换用户目录仍准确', () => {
    vi.stubEnv('LORRA_E2E_USERDATA', 'C:/test/user-data');
    const prompt = buildLorraSystemPrompt({ workspacePath: 'C:/wsp' });

    expect(prompt).toContain(path.join('C:/test/user-data', '.lorra'));
    expect(prompt).toContain(path.join('C:/test/user-data', '.lorra', 'models.json'));
    expect(prompt).toContain(path.join('C:/test/user-data', '.lorra', 'knowledge'));
    expect(prompt).toContain(path.join('C:/wsp', '.lorra', 'skills'));
    expect(prompt).toContain(path.join(os.homedir(), '.agents', 'skills'));
  });

  it('汇报格式:下一步动作、编号步骤、next action、明确时间预估', () => {
    const prompt = buildLorraSystemPrompt({ workspacePath: 'C:/wsp' });

    expect(prompt).toContain('下一步可执行动作');
    expect(prompt).toContain('next action');
    expect(prompt).toContain('每步只一个动作');
    expect(prompt).toContain('预估对应的工作时间');
    expect(prompt).toContain('分钟到小时');
    expect(prompt).toContain('禁止');
    expect(prompt).toContain('模糊词');
  });

  it('三层汇报结构与「根因修复 vs 症状补丁」边界', () => {
    const prompt = buildLorraSystemPrompt({ workspacePath: 'C:/wsp' });

    expect(prompt).toContain('第一性原理');
    expect(prompt).toContain('根因修复');
    expect(prompt).toContain('症状补丁');
    expect(prompt).toContain('需要主动汇报');
  });

  it('列出 lorra 专属工具及其使用时机(让 agent 知道能扩展什么)', () => {
    const prompt = buildLorraSystemPrompt({ workspacePath: 'C:/wsp' });

    expect(prompt).toContain('memory');
    expect(prompt).toContain('knowledge');
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('skill-install');
    expect(prompt).toContain('<available_skills>');
  });

  it('声明 side effect 走审批、检索内容为不可信数据(安全边界不押在文字上)', () => {
    const prompt = buildLorraSystemPrompt({ workspacePath: 'C:/wsp' });

    expect(prompt).toContain('不可信数据');
    expect(prompt).toContain('批准');
  });

  it('作为 systemPromptOverride 整体替换:不含 SDK 默认主文的标志句', () => {
    const prompt = buildLorraSystemPrompt({ workspacePath: 'C:/wsp' });

    expect(prompt).not.toContain('operating inside pi');
    expect(prompt).not.toContain('expert coding assistant');
  });

  it('整体替换后仍承担 SDK 默认主文的职责:工具通则 + pi 文档指引', () => {
    const prompt = buildLorraSystemPrompt({ workspacePath: 'C:/wsp' });

    expect(prompt).toContain('按工具的实际能力使用');
    expect(prompt).toContain('文件路径写清楚');
    expect(prompt).toContain('pi 本体');
    expect(prompt).toContain('extensions');
    expect(prompt).toContain('skills');
  });
});
