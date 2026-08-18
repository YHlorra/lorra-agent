export interface ExperiencePlan {
  reason: string;
  query: string;
}

export interface ExperienceContext {
  reason: string;
  caseIds: string[];
  skillNames: string[];
  text: string;
}

const PROCEDURAL_TRIGGER =
  /排查|修复|debug|fix|troubleshoot|investigate|workflow|runbook|playbook|步骤|流程|怎么做|经验|踩坑|故障|问题/i;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function scoreCase(query: string, haystack: string): number {
  const q = normalize(query);
  const h = normalize(haystack);
  if (!q || !h) return 0;
  if (h.includes(q) || q.includes(h)) return 4;
  const tokens = q.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
  return tokens.reduce((score, token) => score + (h.includes(token) ? 1 : 0), 0);
}

export function planExperienceContext(text: string): ExperiencePlan | null {
  const query = text.trim();
  if (!query || !PROCEDURAL_TRIGGER.test(query)) return null;
  return {
    reason: '当前问题像可复用的 procedural task，可补经验与技能片段',
    query,
  };
}

/**
 * ponytail: 经验层先复用 procedural_experience + generated skill 文件，不再造新索引。
 * 命中 procedural 问题时挑最相关的 1-2 条 case，并附上可用的 generated skill 名称。
 */
export async function buildExperienceContext(
  workspacePath: string,
  plan: ExperiencePlan,
): Promise<ExperienceContext | null> {
  const [{ listExperienceCases }, { materializeGeneratedSkills, readGeneratedSkillAudit }] =
    await Promise.all([
      import('./experience-distiller'),
      import('../skills/generated-skill-store'),
    ]);
  materializeGeneratedSkills(workspacePath);
  const derived = listExperienceCases(workspacePath);
  if (derived.isErr()) return null;
  const matches = derived.value
    .map((item) => ({
      item,
      score: Math.max(
        scoreCase(plan.query, item.title),
        scoreCase(plan.query, item.problem),
        scoreCase(plan.query, item.solution),
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
    .slice(0, 2)
    .map((item) => item.item);
  if (matches.length === 0) return null;

  const skillNames: string[] = [];
  const lines = matches.map((item) => {
    const constraints = item.constraints.length > 0 ? `；约束：${item.constraints.join('；')}` : '';
    const audit = readGeneratedSkillAudit(workspacePath, item.title);
    if (audit?.generated) skillNames.push(audit.skillName);
    return `- [case] ${item.title}：${item.problem}${constraints}`;
  });
  for (const skillName of [...new Set(skillNames)]) {
    lines.push(`- [skill] ${skillName}：来自已沉淀的重复经验，可优先复用其步骤与注意事项`);
  }

  return {
    reason: plan.reason,
    caseIds: matches.map((item) => item.caseId),
    skillNames: [...new Set(skillNames)],
    text: lines.join('\n'),
  };
}
