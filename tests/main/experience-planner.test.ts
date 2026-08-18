import { describe, expect, it, vi } from 'vitest';
import {
  buildExperienceContext,
  planExperienceContext,
} from '../../src/main/memory/experience-planner';
import type { ExperienceCaseDto } from '../../src/shared/memory-api';
import { ok } from '../../src/shared/result';

const { fakeDeps } = vi.hoisted(() => ({
  fakeDeps: {
    cases: [] as ExperienceCaseDto[],
    auditByTitle: new Map<string, { generated: boolean; skillName: string }>(),
  },
}));

vi.mock('../../src/main/memory/experience-distiller', () => ({
  listExperienceCases: () => ok(fakeDeps.cases),
}));

vi.mock('../../src/main/skills/generated-skill-store', () => ({
  materializeGeneratedSkills: vi.fn(() => ok([])),
  readGeneratedSkillAudit: (_workspacePath: string, nameOrId: string) =>
    fakeDeps.auditByTitle.get(nameOrId)
      ? {
          skillName: fakeDeps.auditByTitle.get(nameOrId)?.skillName ?? nameOrId,
          generated: fakeDeps.auditByTitle.get(nameOrId)?.generated ?? false,
          filePath: 'C:/workspace/.lorra/skills/generated/demo/SKILL.md',
          caseIds: ['case-1'],
          entryIds: ['mem-1'],
          warnings: [],
        }
      : null,
}));

function makeCase(overrides: Partial<ExperienceCaseDto> = {}): ExperienceCaseDto {
  return {
    caseId: 'case-1',
    title: '排查登录超时',
    problem: '先看请求日志',
    solution: '先看请求日志，再看最近变更',
    constraints: ['必须先复现'],
    sourceEntryIds: ['mem-1'],
    workspace: 'C:/workspace',
    updatedAt: 1,
    ...overrides,
  };
}

describe('experience-planner', () => {
  it('只在明显 procedural 问题上触发经验层', () => {
    expect(planExperienceContext('帮我排查登录超时')).toEqual({
      reason: '当前问题像可复用的 procedural task，可补经验与技能片段',
      query: '帮我排查登录超时',
    });
    expect(planExperienceContext('你还记得我之前的偏好吗？')).toBeNull();
  });

  it('从最相关 case 生成经验片段，并附上 generated skill 名称', async () => {
    fakeDeps.cases = [
      makeCase(),
      makeCase({
        caseId: 'case-2',
        title: '修复登录超时',
        problem: '先看超时链路',
        constraints: ['不要直接重置数据'],
        sourceEntryIds: ['mem-2'],
        updatedAt: 2,
      }),
      makeCase({
        caseId: 'case-3',
        title: '整理周报',
        problem: '先看 timeline',
        sourceEntryIds: ['mem-3'],
      }),
    ];
    fakeDeps.auditByTitle = new Map([
      ['排查登录超时', { generated: true, skillName: 'generated-skill-a' }],
    ]);

    const context = await buildExperienceContext('C:/workspace', {
      reason: 'procedural',
      query: '请帮我排查登录超时并给步骤',
    });

    expect(context).toMatchObject({
      reason: 'procedural',
      caseIds: ['case-1'],
      skillNames: ['generated-skill-a'],
    });
    expect(context?.text).toContain('[case] 排查登录超时');
    expect(context?.text).toContain('约束：必须先复现');
    expect(context?.text).toContain('[skill] generated-skill-a');
    expect(context?.text).not.toContain('整理周报');
  });
});
