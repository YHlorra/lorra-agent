import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { OkfCheckResultDto, OkfIssueDto } from '../../shared/memory-api';
import { parseConceptFrontmatter } from '../../shared/ofk-schema';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { readConcept } from './ofk-bundle';

function warn(code: string, message: string): OkfIssueDto {
  return { level: 'warn', code, message };
}

function info(code: string, message: string): OkfIssueDto {
  return { level: 'info', code, message };
}

function isAbsoluteTarget(target: string): boolean {
  return path.isAbsolute(target);
}

async function readTarget(target: string): Promise<Result<string | null>> {
  try {
    if (isAbsoluteTarget(target)) {
      if (!existsSync(target)) return ok(null);
      return ok(readFileSync(target, 'utf8'));
    }
    return await readConcept(target);
  } catch (cause) {
    return err(toLorraError(cause, 'okf-check-failed'));
  }
}

/**
 * 最小 OKF 检查器:只做 frontmatter 健康提示,绝不写回文件。
 * ponytail: 先复用现有 frontmatter 解析器,把缺字段/未验证/陈旧治理提示浮出来。
 */
export async function checkOkfDocument(target: string): Promise<Result<OkfCheckResultDto>> {
  const read = await readTarget(target);
  if (read.isErr()) return read;
  if (read.value === null) {
    return err({ code: 'not-found', message: `document not found: ${target}` });
  }

  const issues: OkfIssueDto[] = [];
  const parsed = parseConceptFrontmatter(read.value);
  if (!parsed) {
    issues.push(warn('missing-frontmatter', '缺少 YAML frontmatter'));
    return ok({
      path: target,
      type: null,
      generated: false,
      verified: false,
      issues: [
        ...issues,
        warn('missing-type', '缺少 type'),
        info('unverified', 'verified 未声明或为 false'),
        info('missing-freshness', '建议补 freshness 标记'),
        info('missing-lifecycle', '建议补 lifecycle 标记'),
      ],
    });
  }

  const fm = parsed.frontmatter;
  const type = typeof fm.type === 'string' ? fm.type : null;
  const generated =
    typeof fm.generated === 'object' && fm.generated !== null && !Array.isArray(fm.generated);
  const verified = fm.verified === true;

  if (!type) issues.push(warn('missing-type', '缺少 type'));

  const sources = Array.isArray(fm.sources) ? fm.sources : [];
  if (sources.length === 0) {
    issues.push(info('missing-sources', '建议补 sources'));
  } else {
    const missingResource = sources.some((source) => {
      if (typeof source !== 'object' || source === null) return true;
      return typeof (source as Record<string, unknown>).resource !== 'string';
    });
    if (missingResource) {
      issues.push(warn('missing-source-resource', 'sources[].resource 缺失'));
    }
  }

  if (generated) {
    const generatedBlock = fm.generated as Record<string, unknown>;
    if (typeof generatedBlock.by !== 'string' || typeof generatedBlock.at !== 'string') {
      issues.push(warn('missing-generated-meta', 'generated.by/generated.at 缺失'));
    }
  } else {
    issues.push(info('missing-generated', '建议补 generated 元数据'));
  }

  if (!verified) {
    issues.push(info('unverified', 'verified 未声明或为 false'));
  }
  if (typeof fm.freshness !== 'string') {
    issues.push(info('missing-freshness', '建议补 freshness 标记'));
  }
  if (typeof fm.lifecycle !== 'string') {
    issues.push(info('missing-lifecycle', '建议补 lifecycle 标记'));
  }

  return ok({
    path: target,
    type,
    generated,
    verified,
    issues,
  });
}
