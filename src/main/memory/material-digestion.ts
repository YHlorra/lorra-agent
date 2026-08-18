import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import type { MemoryEntry } from '../../shared/memory-schema';
import { MEMORY_CONTENT_MAX_BYTES } from '../../shared/memory-schema';
import type { LorraError, Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import type { ProposeInput, UpdatePatch } from './memory-store';
import type { ModelInvoke } from './review-generator';
import { createCompileModelInvoke } from './review-model';
import { truncateUtf8ToBytes } from './text-bytes';

/**
 * 素材消化 + 用户结晶(phase3-contract 6.13 / ):
 * - 素材输入(raw 只读)永不落库:消化只存模型提取产物,且产物仅候选,用户确认
 * 是唯一激活路径。
 * - digestMaterial 复用 review-model 的隐藏内存会话(零落盘,不建运行时):
 * SessionManager.inMemory + tools:[] + 120s 超时,只取模型文本输出。
 * 测试注入 invoke/proposeMemory 回调,不触达真实会话与真实库。
 * - 提取产物截断至 ≤ MEMORY_CONTENT_MAX_BYTES(不劈多字节字符)后走候选闸门;
 * 无模型/超时/超长 → 结构化错误,不落任何东西。
 * - crystallize = 用户主动结晶(content ≤ 2KB 校验)→ user-stated 候选。
 */

/** 素材输入上限(字节 utf8):> 此值拒,防文件爆炸。 */
export const DIGEST_INPUT_MAX_BYTES = 200 * 1024;

export interface DigestResult {
  entryId: string;
  /** ingest 编译:true = 命中既有知识页并就地更新(非新增)。 */
  compiled?: boolean;
  /** 编译命中页的标题(更新路径展示用)。 */
  matchedTitle?: string;
}

export interface DigestDeps {
  /** 模型提取回调;缺省走 review-model 隐藏内存会话(生产接线)。 */
  invoke?: ModelInvoke;
  /** 候选写入;缺省走共享 MemoryStore 单例(动态 import 装载,同 review-generator)。 */
  proposeMemory?: (input: ProposeInput) => Promise<Result<MemoryEntry>> | Result<MemoryEntry>;
  /** 就地更新;缺省走共享 MemoryStore 单例。 */
  updateMemory?: (
    entryId: string,
    patch: UpdatePatch,
  ) => Promise<Result<MemoryEntry>> | Result<MemoryEntry>;
  /** 编译匹配:给定提取产物找「标题/首段命中」的既有 knowledge 页;缺省走 store.compileMatch。 */
  matchKnowledge?: (input: {
    title: string;
    content: string;
  }) => Promise<Result<MemoryEntry | null>> | Result<MemoryEntry | null>;
  /** 自动关联:给定新页 id 与主题短语建 related 链;缺省走共享 store.linkRelated。 */
  linkKnowledge?: (
    fromId: string,
    topicPhrases: string[],
  ) => Promise<Result<string[]>> | Result<string[]>;
}

/**
 * 文本素材消化(ingest 编译):校验 → 模型提取 → 编译路由 →
 * 标题/首段命中既有 knowledge 页 → 调和(第二次模型调用,旧页+新材料合并)
 * → 就地 update(supersedes 链);无命中 → 新增。失败零落库。
 */
export async function digestMaterial(
  input: { text: string; title?: string; workspace: string },
  deps: DigestDeps = {},
): Promise<Result<DigestResult>> {
  if (input.text.trim() === '') {
    return err({ code: 'empty-input', message: '素材文本为空' });
  }
  if (Buffer.byteLength(input.text, 'utf8') > DIGEST_INPUT_MAX_BYTES) {
    return err({
      code: 'input-too-long',
      message: `素材超过 ${DIGEST_INPUT_MAX_BYTES / 1024}KB 上限`,
    });
  }

  const invoke = deps.invoke ?? createCompileModelInvoke();
  let invoked: Result<string>;
  try {
    invoked = await invoke(composeDigestPrompt(input));
  } catch (cause) {
    return err(mapDigestError(cause));
  }
  if (invoked.isErr()) return err(normalizeInvokeError(invoked.error));

  const markdown = invoked.value;
  const content = truncateUtf8ToBytes(markdown, MEMORY_CONTENT_MAX_BYTES);
  const title = input.title ?? extractDigestTitle(markdown);

  // 编译路由:命中既有知识页 → 调和更新;未命中 → 新增。
  const match = deps.matchKnowledge ?? defaultKnowledgeMatch;
  let matched: Result<MemoryEntry | null>;
  try {
    matched = await match({ title, content });
  } catch (cause) {
    matched = err(toLorraError(cause, 'digest-match-failed'));
  }
  if (matched.isErr()) {
    // 匹配失败不阻塞消化:退化为新增(fail-open,同召回纪律)。
    return proposeDigest({
      title,
      content,
      workspace: input.workspace,
      propose: deps.proposeMemory,
      invoke,
      linkKnowledge: deps.linkKnowledge,
    });
  }
  const candidate = matched.value;
  if (!candidate) {
    return proposeDigest({
      title,
      content,
      workspace: input.workspace,
      propose: deps.proposeMemory,
      invoke,
      linkKnowledge: deps.linkKnowledge,
    });
  }

  // 命中:调和旧页与新材料(第二次模型调用;失败退化为新提取物直接更新)。
  let merged = content;
  try {
    const reconciled = await invoke(composeReconcilePrompt(candidate, content));
    if (reconciled.isOk() && reconciled.value.trim() !== '') {
      merged = truncateUtf8ToBytes(reconciled.value, MEMORY_CONTENT_MAX_BYTES);
    }
  } catch {
    // 调和失败:新提取物为准,fail-open
  }
  const updateMemory = deps.updateMemory ?? defaultMemoryUpdate;
  const updated = await updateMemory(candidate.entryId, {
    title,
    content: merged,
    basis: candidate.basis ? `${candidate.basis}；素材消化编译更新` : '素材消化编译更新',
  });
  if (updated.isErr()) return updated;
  // 自动关联:提取主题短语 → 确定性建链;任何失败 fail-open,不改变返回。
  const linkKnowledge = deps.linkKnowledge ?? defaultLinkKnowledge;
  try {
    const phrases = await extractRelatedTopics(invoke, { title, content: merged });
    if (phrases.length > 0) {
      await linkKnowledge(updated.value.entryId, phrases);
    }
  } catch {
    // 建链失败不影响消化结果
  }
  return ok({ entryId: updated.value.entryId, compiled: true, matchedTitle: candidate.title });
}

/** 编译未命中 → 新增 knowledge 页(原消化语义)。 */
async function proposeDigest(input: {
  title: string;
  content: string;
  workspace: string;
  propose?: DigestDeps['proposeMemory'];
  invoke?: ModelInvoke;
  linkKnowledge?: DigestDeps['linkKnowledge'];
}): Promise<Result<DigestResult>> {
  const propose = input.propose ?? defaultMemoryPropose;
  const proposed = await propose({
    kind: 'knowledge',
    title: input.title,
    content: input.content,
    producer: 'material-digestion',
    source: 'material-digestion',
    scope: 'workspace',
    workspace: input.workspace,
    evidence: 'extracted',
    basis: '素材消化提取',
  });
  if (proposed.isErr()) return proposed;
  // 自动关联:提取主题短语 → 确定性建链;任何失败 fail-open,不改变返回。
  const invoke = input.invoke ?? createCompileModelInvoke();
  const linkKnowledge = input.linkKnowledge ?? defaultLinkKnowledge;
  try {
    const phrases = await extractRelatedTopics(invoke, {
      title: input.title,
      content: input.content,
    });
    if (phrases.length > 0) {
      await linkKnowledge(proposed.value.entryId, phrases);
    }
  } catch {
    // 建链失败不影响消化结果
  }
  return ok({ entryId: proposed.value.entryId });
}

/** 调和提示词:既有页 + 新材料 → 合并后的单一页面,矛盾标注。 */
function composeReconcilePrompt(candidate: MemoryEntry, extract: string): string {
  return [
    '你是知识页面合并助手。用户正在用新材料更新既有知识页。请把「既有页面」与「新材料」合并为一个更新后的页面：',
    '要求：',
    '- 保留既有页仍有价值的内容,吸收新材料的新要点；',
    `- 若新旧内容矛盾,以新材料为准,并在页内用「> 注：与旧版矛盾，以本条为准」标注；`,
    `- 总长度不超过 ${MEMORY_CONTENT_MAX_BYTES} 字节（约 700 汉字）；`,
    '- 只输出合并结果(markdown 页面形态),不要任何解释性前言。',
    '既有页面标题：',
    candidate.title,
    '既有页面内容：',
    candidate.content,
    '新材料：',
    extract,
  ].join('\n');
}

/** 相关主题提取提示词:从新页提取 3-8 个主题短语,每行一个,纯输出。 */
function composeRelatedTopicsPrompt(entry: { title: string; content: string }): string {
  return [
    '你是知识库整理助手(graybox organizer)。给定一个知识页面,提取 3-8 个「主题短语」',
    '——短名词短语,用于发现知识库里其他相关的页面。',
    '要求:每行一个短语,不要编号、不要解释、不要引号;短语本身不含换行。',
    '页面标题：',
    entry.title,
    '页面内容：',
    entry.content,
  ].join('\n');
}

/** 提取主题短语;invoke 失败/空输出 → 返回 [] (fail-open,不阻塞消化)。 */
async function extractRelatedTopics(
  invoke: (prompt: string) => Promise<Result<string>>,
  entry: { title: string; content: string },
): Promise<string[]> {
  try {
    const result = await invoke(composeRelatedTopicsPrompt(entry));
    if (result.isErr()) return [];
    return result.value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^[-*•]?\s*$/.test(s));
  } catch {
    return [];
  }
}

/** 编译匹配缺省实现:共享 MemoryStore 单例的 compileMatch。 */
async function defaultKnowledgeMatch(input: {
  title: string;
  content: string;
}): Promise<Result<MemoryEntry | null>> {
  const { getSharedMemoryStore } = await import('./shared-memory-store');
  const shared = getSharedMemoryStore();
  if (shared.isErr()) return err(shared.error);
  return shared.value.compileMatch(input);
}

/** 自动关联缺省实现:共享 MemoryStore 单例的 linkRelated。 */
async function defaultLinkKnowledge(fromId: string, phrases: string[]): Promise<Result<string[]>> {
  const { getSharedMemoryStore } = await import('./shared-memory-store');
  return getSharedMemoryStore().andThen((store) => store.linkRelated(fromId, phrases));
}

/** 就地更新缺省实现:共享 MemoryStore 单例。 */
async function defaultMemoryUpdate(
  entryId: string,
  patch: UpdatePatch,
): Promise<Result<MemoryEntry>> {
  const { getSharedMemoryStore } = await import('./shared-memory-store');
  const shared = getSharedMemoryStore();
  if (shared.isErr()) return err(shared.error);
  return shared.value.update(entryId, patch);
}

/**
 * 本地文件消化:readFileSync(≤ 200KB,超限拒绝;不存在 → not-found)→
 * 复用 digestMaterial。
 */
export async function digestFile(
  filePath: string,
  deps: DigestDeps & { workspace: string },
): Promise<Result<DigestResult>> {
  let text: string;
  try {
    const buf = readFileSync(filePath);
    if (buf.byteLength > DIGEST_INPUT_MAX_BYTES) {
      return err({
        code: 'input-too-long',
        message: `文件超过 ${DIGEST_INPUT_MAX_BYTES / 1024}KB 上限`,
      });
    }
    text = buf.toString('utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/enoent|not found|no such file/i.test(message)) {
      return err({ code: 'not-found', message: `文件不存在: ${filePath}` });
    }
    return err(toLorraError(cause, 'digest-file-read-failed'));
  }
  return digestMaterial({ text, workspace: deps.workspace }, deps);
}

/**
 * 用户主动结晶(会话内「记住这段」):content ≤ MEMORY_CONTENT_MAX_BYTES 校验 →
 * knowledge 候选(evidence=user-stated, source=user-crystallization, producer=user)。
 */
export async function crystallize(
  input: { content: string; title?: string; workspace: string },
  deps: DigestDeps = {},
): Promise<Result<DigestResult>> {
  if (input.content.trim() === '') {
    return err({ code: 'empty-input', message: '内容为空' });
  }
  if (Buffer.byteLength(input.content, 'utf8') > MEMORY_CONTENT_MAX_BYTES) {
    return err({
      code: 'content-too-long',
      message: `内容超过 ${MEMORY_CONTENT_MAX_BYTES} 字节上限`,
    });
  }
  const propose = deps.proposeMemory ?? defaultMemoryPropose;
  const proposed = await propose({
    kind: 'knowledge',
    title: input.title ?? firstLine(input.content),
    content: input.content,
    producer: 'user',
    source: 'user-crystallization',
    scope: 'workspace',
    workspace: input.workspace,
    evidence: 'user-stated',
    basis: '用户主动结晶',
  });
  if (proposed.isErr()) return proposed;
  return ok({ entryId: proposed.value.entryId });
}

/** 消化提示词:要求模型提取知识要点(≤ 2KB、markdown 页面形态、中文)。 */
function composeDigestPrompt(input: { text: string; title?: string }): string {
  return [
    '你是知识提炼助手。请从用户提供的素材中提取核心知识要点，输出为 markdown 页面形态（可用标题/列表/要点），使用中文。',
    '要求：',
    '- 只保留知识性要点，丢弃无关细节与寒暄；',
    `- 总长度不超过 ${MEMORY_CONTENT_MAX_BYTES} 字节（约 700 汉字）；`,
    '- 只输出提取结果，不要任何解释性前言。',
    input.title ? `素材标题：${input.title}` : '',
    '素材内容：',
    input.text,
  ].join('\n');
}

/** 消化产物标题:input.title 优先;缺失 → 提取产物首个 markdown 标题行;仍无 → 兜底。 */
function extractDigestTitle(markdown: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  if (heading) return heading[1].trim();
  return '素材消化';
}

/** 首行截断标题(结晶/报告标题共用风格):首行 + 60 字符上限。 */
function firstLine(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** 默认候选写入:共享 MemoryStore 单例(动态 import 是刻意的模块加载边界,
 * node:sqlite 不拉进 vitest client 测试图,review-generator 同款纪律)。 */
async function defaultMemoryPropose(input: ProposeInput): Promise<Result<MemoryEntry>> {
  const { getSharedMemoryStore } = await import('./shared-memory-store');
  const shared = getSharedMemoryStore();
  if (shared.isErr()) return err(shared.error);
  return shared.value.propose(input);
}

/**
 * invoke 已归类错误归一化:生产 invoke(review-model)超时返回 review-timed-out
 * → 消化层语义为 digest-timed-out;model-unavailable 原样直通;其余原样透传。
 */
function normalizeInvokeError(e: LorraError): LorraError {
  if (e.code === 'review-timed-out') {
    return { code: 'digest-timed-out', message: '素材消化超时，请重试' };
  }
  return e;
}

/** 原始异常归类(纯函数):超时/无模型/其他。 */
function mapDigestError(cause: unknown): LorraError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timed out|timeout exceeded|etimedout/i.test(message)) {
    return { code: 'digest-timed-out', message: '素材消化超时，请重试' };
  }
  if (/no model|no api key|authentication failed|login|credentials/i.test(message)) {
    return { code: 'model-unavailable', message };
  }
  return { code: 'digest-failed', message };
}
