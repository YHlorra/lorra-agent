import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExperienceAuditDto, ExperienceCaseDto } from '../../shared/memory-api';
import { parseConceptFrontmatter, yamlQuote } from '../../shared/ofk-schema';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { listExperienceCases } from '../memory/experience-distiller';

const GENERATED_ROOT = path.join('.lorra', 'skills', 'generated');
const GENERATED_MARKER = 'process:lorra-experience/1';

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) return slug;
  // ponytail: 中文等非 ASCII 标题先走短哈希兜底，避免全部塌成同一个 generated-skill。
  return `generated-skill-${createHash('sha1').update(input).digest('hex').slice(0, 8)}`;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupCases(cases: ExperienceCaseDto[]): Map<string, ExperienceCaseDto[]> {
  const groups = new Map<string, ExperienceCaseDto[]>();
  for (const item of cases) {
    const key = normalizeTitle(item.title);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}

function generatedSkillPath(workspacePath: string, slug: string): string {
  return path.join(workspacePath, GENERATED_ROOT, slug, 'SKILL.md');
}

function buildSkillMarkdown(slug: string, cases: ExperienceCaseDto[]): string {
  const now = new Date().toISOString();
  const title = `${slug} workflow`;
  const description = cases[0]?.problem.slice(0, 80) || `${slug} reusable workflow`;
  const steps = cases
    .slice(0, 2)
    .map((item, index) => `- 步骤 ${index + 1}: ${item.solution.split('\n')[0]}`)
    .join('\n');
  const caveats = Array.from(new Set(cases.flatMap((item) => item.constraints))).slice(0, 3);
  const caseIds = cases.map((item) => item.caseId);
  const entryIds = cases.flatMap((item) => item.sourceEntryIds);
  return [
    '---',
    `name: ${yamlQuote(slug)}`,
    `description: ${yamlQuote(description)}`,
    'type: Skill',
    'sources:',
    ...entryIds.map((entryId) => `  - resource: ${yamlQuote(`memory:${entryId}`)}`),
    `generated: { by: ${yamlQuote(GENERATED_MARKER)}, at: ${now} }`,
    'verified: false',
    'freshness: draft',
    'lifecycle: active',
    `caseIds: [${caseIds.map((item) => yamlQuote(item)).join(', ')}]`,
    `entryIds: [${entryIds.map((item) => yamlQuote(item)).join(', ')}]`,
    '---',
    '',
    '# When To Use',
    '',
    `- ${cases[0]?.problem || title}`,
    '',
    '# Steps',
    '',
    steps,
    '',
    '# Caveats',
    '',
    ...(caveats.length > 0
      ? caveats.map((item) => `- ${item}`)
      : ['- 先按最小 diff 处理,不额外扩张范围']),
    '',
    '# Provenance',
    '',
    ...cases.map((item) => `- ${item.caseId} -> ${item.sourceEntryIds.join(', ')}`),
    '',
  ].join('\n');
}

export function materializeGeneratedSkills(workspacePath: string): Result<string[]> {
  try {
    const derived = listExperienceCases(workspacePath);
    if (derived.isErr()) return derived;
    const groups = [...groupCases(derived.value).entries()].filter(
      ([key, cases]) => key.length > 0 && cases.length >= 2,
    );
    const written: string[] = [];
    for (const [key, cases] of groups) {
      const slug = slugify(key);
      const target = generatedSkillPath(workspacePath, slug);
      if (existsSync(target)) {
        const existing = readFileSync(target, 'utf8');
        if (!existing.includes(GENERATED_MARKER)) continue;
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, buildSkillMarkdown(slug, cases), 'utf8');
      written.push(target);
    }
    return ok(written);
  } catch (cause) {
    return err(toLorraError(cause, 'generated-skill-write-failed'));
  }
}

export function readGeneratedSkillAudit(
  workspacePath: string,
  nameOrId: string,
): ExperienceAuditDto | null {
  const target = generatedSkillPath(workspacePath, slugify(nameOrId));
  if (!existsSync(target)) return null;
  const content = readFileSync(target, 'utf8');
  const parsed = parseConceptFrontmatter(content);
  if (!parsed) {
    return {
      skillName: nameOrId,
      generated: false,
      filePath: target,
      caseIds: [],
      entryIds: [],
      warnings: ['缺少 frontmatter'],
    };
  }
  const fm = parsed.frontmatter;
  const caseIds = Array.isArray(fm.caseIds)
    ? fm.caseIds.filter((item): item is string => typeof item === 'string')
    : [];
  const entryIds = Array.isArray(fm.entryIds)
    ? fm.entryIds.filter((item): item is string => typeof item === 'string')
    : [];
  const generated =
    typeof fm.generated === 'object' &&
    fm.generated !== null &&
    typeof (fm.generated as Record<string, unknown>).by === 'string' &&
    String((fm.generated as Record<string, unknown>).by).includes(GENERATED_MARKER);
  const warnings: string[] = [];
  if (fm.verified !== true) warnings.push('verified=false');
  if (typeof fm.freshness !== 'string') warnings.push('缺少 freshness');
  return {
    skillName: typeof fm.name === 'string' ? fm.name : nameOrId,
    generated,
    filePath: target,
    caseIds,
    entryIds,
    warnings,
  };
}
