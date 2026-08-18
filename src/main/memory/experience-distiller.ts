import { createHash } from 'node:crypto';
import type { ExperienceCaseDto } from '../../shared/memory-api';
import type { Result } from '../../shared/result';
import { ok } from '../../shared/result';
import { getSharedMemoryStore } from './shared-memory-store';

function firstParagraph(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? ''
  );
}

function extractConstraints(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith('- ') &&
        /(约束|限制|注意|不要|必须|should|must|avoid|constraint)/i.test(line),
    )
    .slice(0, 3)
    .map((line) => line.slice(2).trim());
}

function caseFingerprint(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized) return normalized;
  return createHash('sha1').update(title).digest('hex').slice(0, 12);
}

/**
 * procedural_experience → case 派生层。无新库表,直接从现有 active 经验条目读。
 */
export function listExperienceCases(workspacePath: string): Result<ExperienceCaseDto[]> {
  const shared = getSharedMemoryStore();
  if (shared.isErr()) return shared;
  const active = shared.value.listActive('procedural_experience');
  if (active.isErr()) return active;
  return ok(
    active.value
      .filter((entry) => entry.scope === 'user' || entry.workspace === workspacePath)
      .map((entry) => ({
        caseId: `${caseFingerprint(entry.title)}:${entry.entryId}`,
        title: entry.title,
        problem: firstParagraph(entry.content) || entry.title,
        solution: entry.content.trim(),
        constraints: extractConstraints(entry.content),
        sourceEntryIds: [entry.entryId],
        workspace: entry.workspace ?? workspacePath,
        updatedAt: entry.updatedAt,
      })),
  );
}
