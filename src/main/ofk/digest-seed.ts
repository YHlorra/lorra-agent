import type { Result } from '../../shared/result';
import { loadOrSeedSkill } from '../memory/review-generator';

/**
 * OFK 每日摘要编译技能:<workspace>/.lorra/skills/ofk-digest.md 的
 * 内置种子(中文提示词),工作区激活时播种(write-if-missing,用户改过不覆写)。
 * 摘要编译 prompt 以本常量内容为方法论(用户技能文件对 agent 可见可改;
 * 编译链路用内置种子保证确定性——两个入口同源,单点维护)。
 */
export const OFK_DIGEST_SKILL_NAME = 'ofk-digest';

export const OFK_DIGEST_SEED = `---
name: ofk-digest
description: 每日知识库摘要编译:把当日会话分类并生成工作摘要,写入 OFK 文档层
---

# 知识库编译器

你是一个知识库编译器。输入是某工作区某一天的会话清单 JSON,输出一份 JSON(不要输出任何其他内容)。

## 输入 JSON 契约

\`\`\`json
{
  "date": "YYYY-MM-DD",
  "workspace": "<ws-slug>",
  "sessions": [
    {
      "sessionRef": "<会话标识>",
      "title": "<标题>",
      "description": "<描述>",
      "start": "<ISO>",
      "end": "<ISO>",
      "active_ms": 0,
      "tokens": 0,
      "model": "<provider/modelId>",
      "tools": ["read"],
      "unfinished": false,
      "contains_todo": false,
      "body": "<会话正文:用户要求/智能体做了什么/结果>"
    }
  ]
}
\`\`\`

## 输出 JSON 契约

\`\`\`json
{
  "categoryBySession": {
    "<sessionRef>": "<work|programming|reading|chat|project|uncategorized>"
  },
  "segmentsBySession": {
    "<sessionRef>": [
      { "category": "reading", "start": "<ISO>", "end": "<ISO>", "summary": "<一句话摘要>" }
    ]
  },
  "digest": "<markdown 摘要>"
}
\`\`\`

## 六分类判定规则

- work:工作任务、会议、项目推进、业务讨论
- programming:写代码、调试、重构、技术方案、代码评审
- reading:读文章、读文档、读代码、学习资料
- chat:闲聊、答疑、日常对话(无明确产出)
- project:与某个具体项目强绑定的长期事项(跨会话上下文)
- uncategorized:以上都不像或信息不足

## 语义分段规则

- 同一会话内主题发生转换(如从阅读切到锻炼、从技术讨论切到闲聊)→ 切成多段,每段标 category 与起止 ISO 时间(依据正文里的 [HH:MM] 时刻,结合概念 start/end 换算 ISO)
- 单主题短会话 = 单段或省略(不切)
- 段首尾相接、不要重叠、不要留空档;每段 summary 一句话
- segmentsBySession 可省略(全部单主题时);每段必须落在该会话 start/end 范围内

## 摘要写法

- 覆盖:今天做了什么 / 用户提了什么要求 / 调了哪些工具 / 关键结论
- 每个会话一行要点,重要会话可多写;总字数 ≤ 600
- 用中文,markdown 列表形态,不要复述原文
`;

/** 工作区激活时播种(write-if-missing,与 seedMemoryMaintenanceSkill 同纪律)。 */
export function seedOfkDigestSkill(workspacePath: string): Result<string> {
  return loadOrSeedSkill(workspacePath, OFK_DIGEST_SKILL_NAME, OFK_DIGEST_SEED);
}
