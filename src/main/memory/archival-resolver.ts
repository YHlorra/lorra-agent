import type { ArchivalAuditDto, ArchivalTrigger } from '../../shared/memory-api';
import { readConcept } from '../ofk/ofk-bundle';
import { buildRecallProjection } from './recall';

interface ResolveArchivalArgs {
  workspace: string;
  query?: string;
  sources: Array<'memory' | 'ofk'>;
  triggeredBy: ArchivalTrigger;
  reason: string;
}

const OFK_MAX_DOCS = 2;
const OFK_SUMMARY_MAX_CHARS = 180;

/**
 * P3 正式 archival resolver:先走既有 recall,再按 recall 命中的 ofkRef 做少量文档补充。
 * ponytail: 不新建第二检索引擎,只沿已有 recall 命中的文档指针补两条摘要。
 */
export async function resolveArchivalRecall(
  args: ResolveArchivalArgs,
): Promise<ArchivalAuditDto | null> {
  const sections: string[] = [];
  const projection =
    args.sources.includes('memory') || args.triggeredBy === 'session-start'
      ? buildRecallProjection({
          workspace: args.workspace,
          ...(args.query ? { query: args.query } : {}),
        })
      : { text: '', entryIds: [], ofkRefs: [] };
  if (projection.text) sections.push(projection.text);

  const ofkPaths: string[] = [];
  if (args.sources.includes('ofk')) {
    for (const relPath of projection.ofkRefs.slice(0, OFK_MAX_DOCS)) {
      const read = await readConcept(relPath);
      if (read.isErr() || !read.value) continue;
      const summary = summarizeOfk(read.value);
      if (!summary) continue;
      ofkPaths.push(relPath);
      sections.push(`- [ofk] ${relPath}：${summary}(文档补充)`);
    }
  }

  if (sections.length === 0) return null;
  return {
    reason: args.reason,
    triggeredBy: args.triggeredBy,
    sources: args.sources,
    ...(args.query ? { query: args.query } : {}),
    memoryEntryIds: projection.entryIds,
    ofkPaths,
    text: sections.join('\n'),
    updatedAt: Date.now(),
  };
}

function summarizeOfk(content: string): string {
  const stripped = content
    .replace(/^---[\s\S]*?---\n?/, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  if (!stripped) return '';
  if (stripped.length <= OFK_SUMMARY_MAX_CHARS) return stripped;
  return `${stripped.slice(0, OFK_SUMMARY_MAX_CHARS - 1)}...`;
}
