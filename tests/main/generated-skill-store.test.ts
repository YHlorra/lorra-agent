import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  materializeGeneratedSkills,
  readGeneratedSkillAudit,
} from '../../src/main/skills/generated-skill-store';
import type { ExperienceCaseDto } from '../../src/shared/memory-api';
import type { Result } from '../../src/shared/result';
import { ok } from '../../src/shared/result';

const { fakeCases } = vi.hoisted(() => ({
  fakeCases: {
    result: null as Result<ExperienceCaseDto[]> | null,
  },
}));

vi.mock('../../src/main/memory/experience-distiller', () => ({
  listExperienceCases: () => fakeCases.result as Result<ExperienceCaseDto[]>,
}));

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function makeCase(overrides: Partial<ExperienceCaseDto> = {}): ExperienceCaseDto {
  return {
    caseId: 'case-1',
    title: '排查登录超时',
    problem: '先看请求日志',
    solution: '先看请求日志\n- 必须先复现',
    constraints: ['必须先复现'],
    sourceEntryIds: ['mem-1'],
    workspace: 'C:/workspace',
    updatedAt: 1,
    ...overrides,
  };
}

function expectedSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) return slug;
  return `generated-skill-${createHash('sha1').update(input).digest('hex').slice(0, 8)}`;
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'lorra-generated-skill-'));
  fakeCases.result = ok([]);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('generated-skill-store', () => {
  it('至少两条相似 case 时生成系统 skill，并带 provenance frontmatter', () => {
    const slug = expectedSlug('排查登录超时');
    fakeCases.result = ok([
      makeCase({ caseId: 'case-1', sourceEntryIds: ['mem-1'] }),
      makeCase({ caseId: 'case-2', sourceEntryIds: ['mem-2'], updatedAt: 2 }),
    ]);

    const written = expectOk(materializeGeneratedSkills(workspace));

    expect(written).toHaveLength(1);
    expect(written[0]).toContain(path.join('.lorra', 'skills', 'generated', slug, 'SKILL.md'));
    expect(existsSync(written[0])).toBe(true);
    const content = readFileSync(written[0], 'utf8');
    expect(content).toContain(`name: ${slug}`);
    expect(content).toContain('type: Skill');
    expect(content).toContain('process:lorra-experience/1');
    expect(content).toContain('caseIds: [case-1, case-2]');
    expect(content).toContain('entryIds: [mem-1, mem-2]');
    expect(content).toContain('# Provenance');
  });

  it('已有非系统 skill 时跳过覆写；audit 可读出来源与警告', () => {
    const slug = expectedSlug('排查登录超时');
    const skillFile = path.join(workspace, '.lorra', 'skills', 'generated', slug, 'SKILL.md');
    fakeCases.result = ok([
      makeCase({ caseId: 'case-1', sourceEntryIds: ['mem-1'] }),
      makeCase({ caseId: 'case-2', sourceEntryIds: ['mem-2'] }),
    ]);
    mkdirSync(path.dirname(skillFile), { recursive: true });
    writeFileSync(
      skillFile,
      [
        '---',
        `name: ${slug}`,
        'type: Skill',
        'caseIds: [case-a]',
        'entryIds: [mem-a]',
        'verified: false',
        'generated:',
        '  by: "process:lorra-experience/1"',
        '  at: "2026-08-17T00:00:00.000Z"',
        '---',
        '',
        '# custom',
      ].join('\n'),
      'utf8',
    );

    const written = expectOk(materializeGeneratedSkills(workspace));
    const audit = readGeneratedSkillAudit(workspace, '排查登录超时');

    expect(written).toEqual([]);
    expect(audit).toEqual({
      skillName: slug,
      generated: true,
      filePath: skillFile,
      caseIds: ['case-a'],
      entryIds: ['mem-a'],
      warnings: ['verified=false', '缺少 freshness'],
    });
  });
});
