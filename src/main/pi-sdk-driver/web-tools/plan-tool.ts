import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/**
 * LLM-facing plan tool: a codex-style `update_plan` that lets the model
 * publish/update a multi-step plan. The harness does not drive execution —
 * the model self-orchestrates; this tool only validates the state machine
 * (single `in_progress` step, non-empty plan) and echoes the plan back so
 * the renderer can draw it from `tool.start/end.args`.
 */

const planStepSchema = Type.Object({
  step: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('in_progress'),
    Type.Literal('completed'),
  ]),
});

const planSchema = Type.Object({
  explanation: Type.Optional(Type.String()),
  plan: Type.Array(planStepSchema, { minItems: 1, maxItems: 8 }),
});

export const MAX_PLAN_STEPS = 8;

export function createPlanTool(): ToolDefinition<typeof planSchema> {
  return {
    name: 'update_plan',
    label: '任务计划',
    description:
      '制定或更新多步任务计划：每步含描述与状态（pending / in_progress / completed）。多步任务开始前先制定计划，每完成或开始一步就更新对应步骤状态。',
    promptSnippet: '制定/更新多步任务计划（update_plan）：非平凡多步任务先计划再执行',
    promptGuidelines: [
      '多步任务（搜索调研、修改多个文件、写报告）开始前先调用 update_plan 制定计划；每完成或开始一步，更新对应步骤状态',
      '步骤描述控制在 5-7 个词以内；调整计划时必须在 explanation 里说明原因',
      '同一时刻最多一个步骤处于 in_progress',
    ],
    parameters: planSchema,
    executionMode: 'parallel',
    async execute(_toolCallId, params) {
      // Defensive: schema minItems already blocks empty plans, but the
      // state-machine constraint below is the real contract.
      if (params.plan.length === 0) {
        throw new Error('update_plan: 计划不能为空');
      }
      const inProgress = params.plan.filter((s) => s.status === 'in_progress').length;
      if (inProgress > 1) {
        throw new Error('update_plan: 同时只能有一个进行中的步骤');
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(params) }],
        details: {},
      };
    },
  };
}
