import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Result } from '../../../shared/result';
import type { InstallResult } from '../../../shared/skills-api';

/**
 * 智能体工具:从 git 仓库安装技能(2026-08-13 UX 重构)。
 * 替代前端「安装技能」按钮——用户只需在对话里发链接/请求,agent 自动调用本工具。
 * 安装核心复用 src/main/skills/skill-manager.ts 的 installSkill(URL 校验、
 * clone --depth 1、SKILL.md 产物校验、元数据注册、失败回滚全部在那里);
 * 本工具只负责 schema、prompt 引导与 Result → 工具结果(成功文案 / 抛错)的适配。
 * 供应链风险:第三方代码安装由 tool-safety 拦截器走审批卡(权限卡)裁决。
 */

export const SKILL_INSTALL_TOOL_NAME = 'install_skill';

const installSkillSchema = Type.Object({
  git_url: Type.String({ minLength: 1 }),
});

export interface InstallSkillToolDeps {
  /** 注入技能安装核心;生产由 session-persistence 惰性动态 import 接线。 */
  install: (gitUrl: string) => Promise<Result<InstallResult>>;
}

export function createInstallSkillTool(
  deps: InstallSkillToolDeps,
): ToolDefinition<typeof installSkillSchema> {
  return {
    name: SKILL_INSTALL_TOOL_NAME,
    label: '安装技能',
    description:
      '安装技能（install_skill）：从 https git 仓库下载并注册一个技能。仅当用户明确要求「安装/下载/添加某个技能」并给出仓库链接时调用。安装后向用户转述结果：成功告知技能名与位置，失败转述具体原因。',
    promptSnippet:
      '安装技能（install_skill）：用户要求下载技能时，用其提供的 https 仓库链接调用本工具',
    promptGuidelines: [
      '仅在用户明确要求安装/下载技能时调用；git_url 必须是用户提供的 https 链接，禁止自行编造仓库地址',
      '安装成功后在回复里转述技能名；失败（如缺少 SKILL.md、仓库已存在）把错误原因原样转述给用户',
      '一次只安装一个技能；用户同时给出多个链接时逐个调用',
    ],
    parameters: installSkillSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const res = await deps.install(params.git_url);
      if (res.isErr()) {
        // 错误文案已是 PM 语域(skills-git.ts 定稿),原样抛出变 tool_result isError。
        throw new Error(res.error.message);
      }
      return {
        content: [
          { type: 'text', text: `技能「${res.value.name}」安装成功，位置：${res.value.path}` },
        ],
        details: { name: res.value.name, path: res.value.path },
      };
    },
  };
}
