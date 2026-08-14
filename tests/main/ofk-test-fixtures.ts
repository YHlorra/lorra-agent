import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { RawSessionEntry } from '../../src/main/memory/cleanse';
import { dayConceptPath, sessionConceptPath, writeConcept } from '../../src/main/ofk/ofk-bundle';
import { buildSessionConcept } from '../../src/main/ofk/session-writer';
import { FACTS_SCHEMA_VERSION, factIdOf, type SessionFact } from '../../src/shared/facts-schema';
import type { SessionCategory } from '../../src/shared/ofk-schema';

/**
 * OFK 测试夹具(/P5 共用):往 LORRA_E2E_USERDATA 指向的 bundle
 * 播种概念/日摘要,供复盘组装、每日摘要、时间线等测试复用。
 * 日摘要的 generated.at 固定为 2099(far-future)→ ensureDayCompiled 判定
 * 不失效 → 不触发真实模型调用。
 */

export const FUTURE_GENERATED_AT = '2099-01-01T00:00:00.000Z';

/** 测试用 LORRA_E2E_USERDATA 临时目录(调用方 afterEach 清理)。 */
export function freshUserData(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lorra-ofk-fixture-'));
  vi.stubEnv('LORRA_E2E_USERDATA', dir);
  return dir;
}

export function makeFact(overrides: Partial<SessionFact> = {}): SessionFact {
  const content: Omit<SessionFact, 'factId'> = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: 'pi-sdk',
    runtime: 'pi-sdk',
    agentId: 'pi-sdk',
    sessionRef: 'sess-x',
    workspace: 'C:\\work\\demo',
    scope: 'workspace',
    start: new Date(2026, 7, 8, 9).getTime(),
    end: new Date(2026, 7, 8, 9, 30).getTime(),
    activeMs: 1_800_000,
    title: 'Fix the flaky login test',
    summaryRef: null,
    tokens: 1_000,
    model: 'claude-sonnet-4-5',
    tools: ['read'],
    unfinished: false,
    containsTodo: false,
    privacy: 'public_safe',
  };
  const merged = { ...content, ...overrides };
  return { factId: factIdOf(merged), ...merged };
}

/** 本地时区 2026-08-<day> <hour>:<minute>。 */
export function at(day: number, hour = 9, minute = 0): number {
  return new Date(2026, 7, day, hour, minute).getTime();
}

export function isoDay(day: number): string {
  return `2026-08-${String(day).padStart(2, '0')}`;
}

export interface SeedConceptOpts {
  day: string;
  workspace: string;
  sessionRef: string;
  title: string;
  category?: SessionCategory;
  start?: number;
  activeMs?: number;
  tokens?: number;
  model?: string;
  tools?: string[];
  unfinished?: boolean;
  containsTodo?: boolean;
  /** 首条 user 消息文本(question 来源);缺省 = title。 */
  userText?: string;
}

/** 播种一条会话概念(经 buildSessionConcept 真实文档形态)。 */
export async function seedConcept(opts: SeedConceptOpts): Promise<SessionFact> {
  // start 缺省 = 该 day 的本地 09:00(概念目录按 start 本地日落盘,须与 day 一致)。
  const dayNum = Number(opts.day.slice(8));
  const start = opts.start ?? at(dayNum, 9);
  const fact = makeFact({
    sessionRef: opts.sessionRef,
    workspace: opts.workspace,
    title: opts.title,
    start,
    end: start + 1_800_000,
    activeMs: opts.activeMs ?? 1_800_000,
    tokens: opts.tokens ?? 1_000,
    model: opts.model ?? 'claude-sonnet-4-5',
    tools: opts.tools ?? ['read'],
    unfinished: opts.unfinished ?? false,
    containsTodo: opts.containsTodo ?? false,
  });
  const sequence: RawSessionEntry[] | null = [
    {
      id: `${opts.sessionRef}-m1`,
      parentId: null,
      timestamp: fact.start,
      message: {
        role: 'user',
        content: [{ type: 'text', text: opts.userText ?? opts.title }],
      },
    },
  ];
  const doc = buildSessionConcept(fact, sequence, opts.category ?? 'uncategorized');
  const written = await writeConcept(sessionConceptPath(fact), doc);
  if (written.isErr()) throw new Error(`seedConcept failed: ${written.error.message}`);
  return fact;
}

/** 播种日摘要(generated.at 2099 → 编译不失效;缺省带 segments 块 → 重编译判定不触发)。 */
export interface DigestSegmentSeed {
  ref: string;
  category: SessionCategory;
  start: string;
  end: string;
  summary?: string;
}

export async function seedDigest(
  slug: string,
  day: string,
  digest: string,
  generatedAt: string = FUTURE_GENERATED_AT,
  /** undefined → 写缺省 segments 块;null → 不写(模拟存量摘要);数组 → 原样写。 */
  segments?: DigestSegmentSeed[] | null,
): Promise<void> {
  const segs: DigestSegmentSeed[] =
    segments === undefined
      ? [
          {
            ref: 'sess-x',
            category: 'work',
            start: new Date(2026, 7, 8, 9).toISOString(),
            end: new Date(2026, 7, 8, 9, 30).toISOString(),
          },
        ]
      : (segments ?? []);
  const doc = [
    '---',
    'type: Daily Digest',
    `title: ${day} 摘要`,
    `date: ${day}`,
    `workspace: ${slug}`,
    ...(segs.length > 0 ? ['segments:'] : []),
    ...segs.flatMap((s) => [
      `  - ref: ${s.ref}`,
      `    category: ${s.category}`,
      `    start: ${s.start}`,
      `    end: ${s.end}`,
      ...(s.summary !== undefined ? [`    summary: ${s.summary}`] : []),
    ]),
    `generated: { by: process:lorra-digest/1, at: ${generatedAt} }`,
    '---',
    '',
    digest,
  ].join('\n');
  const written = await writeConcept(dayConceptPath(slug, day), doc);
  if (written.isErr()) throw new Error(`seedDigest failed: ${written.error.message}`);
}
