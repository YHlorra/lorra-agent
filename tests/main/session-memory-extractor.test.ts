import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/main/memory/memory-store';
import type { ModelInvoke } from '../../src/main/memory/review-generator';
import {
  type ExtractionCandidate,
  type ExtractorStore,
  runExtraction,
} from '../../src/main/memory/session-memory-extractor';
import type { MemoryKind } from '../../src/shared/memory-schema';
import type { Result } from '../../src/shared/result';
import { err, ok } from '../../src/shared/result';

/**
 * 会话记忆提取器测试（三场景用例, TDD）。
 *
 * 场景 1 博客: 用户贴博客全文 + agent 回答 → knowledge + soft_preference 落库。
 * 场景 2 仓库: GitHub 仓库评估 → working_context 落库;零候选批次 → 零写入、水位仍推进。
 * 场景 3 量化: 多轮增量 —— 写脚本 → 纠正（update supersedes 链）→ 经验 + topics 跨 kind 建链。
 *
 * 不碰真实模型:注入假 invoke（分调用返回不同候选）;store 用真实 MemoryStore
 * （mkdtemp 临时库, 断言 entry_links/event_log/supersedes 需要真落库）。
 * jsonl 用临时目录写文件, 测试后清理（照 memory-store.test.ts 清理纪律）。
 */

const storeRegistry: Array<{ close(): void }> = [];

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function expectErr<T>(result: Result<T>): { code: string; message: string } {
  expect(result.isErr()).toBe(true);
  return result.match({
    ok: () => {
      throw new Error('expected Err, got Ok');
    },
    err: (e) => e,
  });
}

interface MessageLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** 组装一行 pi-sdk jsonl 消息记录（最小字段面, 提取器只消费 type/message）。 */
function messageLine(line: MessageLine): string {
  return JSON.stringify({
    type: 'message',
    id: line.id,
    parentId: null,
    timestamp: Date.now(),
    message: { role: line.role, content: line.text },
  });
}

function writeSession(file: string, lines: MessageLine[]): void {
  writeFileSync(file, lines.map(messageLine).join('\n'), 'utf8');
}

function appendSession(file: string, lines: MessageLine[]): void {
  appendFileSync(file, `\n${lines.map(messageLine).join('\n')}`, 'utf8');
}

function candidate(over: Partial<ExtractionCandidate>): ExtractionCandidate {
  return {
    action: 'create',
    kind: 'knowledge',
    title: '默认标题',
    content: '默认内容',
    scope: 'user',
    evidence: 'extracted',
    reason: '测试依据',
    ...over,
  };
}

function activeTitles(store: MemoryStore, kind?: MemoryKind): string[] {
  return expectOk(store.listActive(kind)).map((e) => e.title);
}

/** 从 buildPrompt 输出中切出 nonce 包裹的增量文本(纪律段也含 nonce 标签,
 * 必须取最后一个开标签——包裹增量的那个)。 */
function incrementalOf(prompt: string): string {
  const start = prompt.lastIndexOf('<untrusted-session-');
  const contentStart = prompt.indexOf('\n', start) + 1;
  const end = prompt.lastIndexOf('</untrusted-session-');
  return prompt.slice(contentStart, end - 1);
}

describe('session-memory-extractor（三场景用例 + 失败路径）', () => {
  let dir: string;
  let store: MemoryStore;
  let invoke: ReturnType<typeof vi.fn<ModelInvoke>>;
  let emitted: Array<{ entryId: string; title: string; kind: string; evidence: string }>;

  function deps(): Parameters<typeof runExtraction>[1] {
    return {
      invoke,
      getStore: () => store,
      emitRecorded: (payload) => emitted.push(payload),
      workspace: 'C:\\work\\quant',
      minUserTurnsBetweenExtractions: 1,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lorra-extract-'));
    store = expectOk(MemoryStore.open(path.join(dir, 'memory.db')));
    storeRegistry.push(store);
    invoke = vi.fn<ModelInvoke>();
    emitted = [];
  });

  afterEach(() => {
    for (const s of storeRegistry.splice(0)) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 场景 1 博客:贴博客全文 → knowledge + soft_preference 双落库
  // -------------------------------------------------------------------------

  it('场景 1 博客:增量含博客全文 → knowledge + soft_preference 落库, 水位推进, emitRecorded 两次', async () => {
    const sessionFile = path.join(dir, 'sess-blog.jsonl');
    writeSession(sessionFile, [
      { id: 'm1', role: 'user', text: '这篇博客讲 Rust 内存模型, 我贴全文: ...(全文)...' },
      {
        id: 'm2',
        role: 'assistant',
        text: '核心要点:所有权/借用/生命周期。另外建议技术文章先结论后细节。',
      },
    ]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: 'Rust 内存模型要点',
              content: '- 所有权: 同一时刻一个值只有一个所有者\n- 借用: &T 共享 / &mut T 独占',
              scope: 'user',
              evidence: 'extracted',
              reason: '用户贴的博客全文, agent 归纳',
            }),
            candidate({
              action: 'create',
              kind: 'soft_preference',
              title: '技术文章先结论后细节',
              content: '用户偏好: 技术文章/回答先给结论, 再展开细节。',
              scope: 'user',
              evidence: 'user-stated',
              reason: 'agent 回答中的建议被用户采纳',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 2, updated: 0, retired: 0, skipped: 0 });

    const knowledge = expectOk(store.listActive('knowledge'));
    expect(knowledge.map((e) => e.title)).toContain('Rust 内存模型要点');
    expect(knowledge[0].scope).toBe('user');
    expect(knowledge[0].source).toBe('session-extraction');
    expect(knowledge[0].evidence).toBe('extracted');
    const pref = expectOk(store.listActive('soft_preference'));
    expect(pref.map((e) => e.title)).toContain('技术文章先结论后细节');
    expect(pref[0].evidence).toBe('user-stated');

    // 水位推进: 重跑同一文件 → 增量空 → invoke 不再被调用, 零摘要。
    expectOk(await runExtraction(sessionFile, deps()));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBeGreaterThan(0);
    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => e.kind).sort()).toEqual(['knowledge', 'soft_preference']);
  });

  // -------------------------------------------------------------------------
  // 场景 2 仓库:仓库评估 → working_context;零候选批次 → 零写入、水位推进
  // -------------------------------------------------------------------------

  it('场景 2 仓库:create working_context(workspace scope);零候选批次零写入且水位推进', async () => {
    const sessionFile = path.join(dir, 'sess-repo.jsonl');
    writeSession(sessionFile, [
      { id: 'm1', role: 'user', text: '看看这个 GitHub 仓库 XX 量化库, 评估一下能不能用' },
      { id: 'm2', role: 'assistant', text: '这个库 API 简洁, 回测引擎完整, 值得引入。' },
    ]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'working_context',
              title: 'XX 量化库评估',
              content: 'XX 量化库: API 简洁, 回测引擎完整, 值得引入。',
              scope: 'workspace',
              evidence: 'extracted',
              reason: '会话中的仓库评估结论',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 1, updated: 0, retired: 0, skipped: 0 });
    const ctx = expectOk(store.listActive('working_context'));
    expect(ctx[0].title).toBe('XX 量化库评估');
    expect(ctx[0].scope).toBe('workspace');
    expect(ctx[0].workspace).toBe('C:\\work\\quant');

    // 零候选批次: 追加新行, 模型返回空 candidates → 零写入, 水位仍推进。
    appendSession(sessionFile, [
      { id: 'm3', role: 'user', text: '好的, 那就先集成试试' },
      { id: 'm4', role: 'assistant', text: '已记录, 下一步先跑通回测。' },
    ]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));
    const zero = expectOk(await runExtraction(sessionFile, deps()));
    expect(zero).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    expect(expectOk(store.listActive('working_context'))).toHaveLength(1);
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 场景 3 量化(核心):写脚本 → 纠正(update supersedes 链) → 经验 + 跨 kind 建链
  // -------------------------------------------------------------------------

  it('场景 3 量化:轮 1 双落库(scope 路由) → 轮 2 纠正 supersedes → 轮 3 经验 + 跨 kind 图谱边', async () => {
    const sessionFile = path.join(dir, 'sess-quant.jsonl');
    // 轮 1:写脚本。
    writeSession(sessionFile, [
      { id: 'q1', role: 'user', text: '帮我写一个双均线策略的回测脚本' },
      { id: 'q2', role: 'assistant', text: '已生成回测脚本, 使用 SMA20/SMA60 交叉信号。' },
    ]);
    invoke.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '双均线策略框架',
              content: '双均线策略: SMA20/SMA60 交叉信号, 金叉买入死叉卖出。',
              scope: 'workspace',
              evidence: 'extracted',
              reason: '会话中完成的双均线回测脚本',
            }),
            candidate({
              action: 'create',
              kind: 'user_profile',
              title: '用户从事量化开发',
              content: '用户在写双均线量化策略回测脚本, 关注滑点与收益口径。',
              scope: 'user',
              evidence: 'extracted',
              reason: '多轮对话观察',
            }),
          ],
        }),
      ),
    );

    const round1 = expectOk(await runExtraction(sessionFile, deps()));
    expect(round1).toEqual({ created: 2, updated: 0, retired: 0, skipped: 0 });
    const oldKnowledge = expectOk(store.listActive('knowledge'))[0];
    expect(oldKnowledge.title).toBe('双均线策略框架');
    expect(oldKnowledge.scope).toBe('workspace'); // 项目内容 → workspace 路由
    const profile = expectOk(store.listActive('user_profile'))[0];
    expect(profile.title).toBe('用户从事量化开发');
    expect(profile.scope).toBe('user'); // 个人档案 → user 路由

    // 轮 2:纠正「年化要用对数收益」→ update 定位旧知识页。
    appendSession(sessionFile, [
      { id: 'q3', role: 'user', text: '不对, 年化收益要用对数收益计算, 改成这个' },
      { id: 'q4', role: 'assistant', text: '已修改为对数收益口径。' },
    ]);
    invoke.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'update',
              kind: 'knowledge',
              title: '双均线策略框架',
              content: '双均线策略: SMA20/SMA60 交叉信号, 金叉买入死叉卖出。年化用对数收益口径。',
              targetTitle: '双均线策略框架',
              scope: 'workspace',
              evidence: 'user-stated',
              reason: '用户纠正: 年化要用对数收益',
            }),
          ],
        }),
      ),
    );

    const round2 = expectOk(await runExtraction(sessionFile, deps()));
    expect(round2).toEqual({ created: 0, updated: 1, retired: 0, skipped: 0 });
    const active = expectOk(store.listActive('knowledge'));
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe('双均线策略框架');
    expect(active[0].supersedes).toBe(oldKnowledge.entryId); // supersedes 指向旧页
    expect(active[0].evidence).toBe('extracted'); // 证据不因写入而改变: update 继承原值
    expect(active[0].basis).toBe('用户纠正: 年化要用对数收益');
    const archived = expectOk(store.listArchived());
    expect(archived.find((e) => e.entryId === oldKnowledge.entryId)?.lifecycle).toBe('superseded');
    // event_log 有 edited 事件(新条目)。
    const events = expectOk(store.listEvents(active[0].entryId));
    expect(events.map((e) => e.event)).toContain('edited');

    // 轮 3:查滑点 → 经验教训 + topics → 跨 kind 建链(经验 ↔ 知识页)。
    appendSession(sessionFile, [
      { id: 'q5', role: 'user', text: '回测结果比实盘好太多, 是不是滑点问题' },
      { id: 'q6', role: 'assistant', text: '对, 回测必须包含滑点与手续费, 否则结果虚高。' },
    ]);
    invoke.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'procedural_experience',
              title: '回测必须含滑点与手续费',
              content: '回测必须包含滑点与手续费, 否则结果虚高; 年化用对数收益口径。',
              scope: 'workspace',
              evidence: 'extracted',
              topics: ['双均线', '回测'],
              reason: '回测与实盘差异排查结论',
            }),
          ],
        }),
      ),
    );

    const round3 = expectOk(await runExtraction(sessionFile, deps()));
    expect(round3).toEqual({ created: 1, updated: 0, retired: 0, skipped: 0 });
    const experience = expectOk(store.listActive('procedural_experience'))[0];
    expect(experience.title).toBe('回测必须含滑点与手续费');
    // 跨 kind 边:经验页 → 知识页(主题短语命中知识页标题)。
    const links = expectOk(store.listLinks());
    const crossKind = links.find(
      (l) => l.fromId === experience.entryId && l.toId === active[0].entryId,
    );
    expect(crossKind).toBeDefined();

    // 最终水位 = 总行数;重跑幂等(增量空 → 零写入、水位不变)。
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(6);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // 失败路径:invoke Err / JSON 非法 → 不推水位;compaction 重置;未命中降级 create
  // -------------------------------------------------------------------------

  it('失败路径:invoke 返回 Err → 整体 Err, 水位不推进(再跑水位仍为原值)', async () => {
    const sessionFile = path.join(dir, 'sess-fail.jsonl');
    writeSession(sessionFile, [
      { id: 'f1', role: 'user', text: '帮我看看这个策略' },
      { id: 'f2', role: 'assistant', text: '策略信号过于频繁, 需要加过滤。' },
    ]);
    invoke.mockResolvedValue(err({ code: 'model-unavailable', message: '未配置可用模型' }));

    const failed = expectErr(await runExtraction(sessionFile, deps()));
    expect(failed.code).toBe('model-unavailable');
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(0);

    // 再跑一次(补提语义): 水位仍 0, 无写入。
    const again = expectErr(await runExtraction(sessionFile, deps()));
    expect(again.code).toBe('model-unavailable');
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(0);
    expect(expectOk(store.listActive())).toHaveLength(0);
  });

  it('失败路径:候选 JSON 非法(含代码围栏剥除失败) → 不推水位', async () => {
    const sessionFile = path.join(dir, 'sess-badjson.jsonl');
    writeSession(sessionFile, [{ id: 'b1', role: 'user', text: '记住这个结论' }]);
    invoke.mockResolvedValue(ok('这不是 JSON'));

    const failed = expectErr(await runExtraction(sessionFile, deps()));
    expect(failed.code).toBe('extraction-parse-failed');
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(0);
    expect(expectOk(store.listActive())).toHaveLength(0);
  });

  it('JSON 代码围栏剥除: ```json 围栏包裹的输出正常解析', async () => {
    const sessionFile = path.join(dir, 'sess-fenced.jsonl');
    writeSession(sessionFile, [{ id: 'c1', role: 'user', text: '记住: 回测数据要复权' }]);
    invoke.mockResolvedValue(
      ok(
        '```json\n{"candidates":[{"action":"create","kind":"knowledge","title":"回测数据复权","content":"回测数据必须前复权。","scope":"user","evidence":"user-stated","reason":"用户明说"}]}\n```',
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result.created).toBe(1);
    expect(activeTitles(store, 'knowledge')).toContain('回测数据复权');
  });

  it('compaction:水位 > 行数 → force 重置 0 全量重提, 重复候选层内查重幂等', async () => {
    const sessionFile = path.join(dir, 'sess-compact.jsonl');
    writeSession(sessionFile, [
      { id: 'd1', role: 'user', text: '写个动量策略' },
      { id: 'd2', role: 'assistant', text: '已生成动量策略框架。' },
    ]);
    // 预置一个超过行数的水位(模拟 jsonl 被 compaction 重写变小)。
    expectOk(store.setExtractionWatermark(sessionFile, 10));
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '动量策略框架',
              content: '动量策略: 过去 N 日涨幅排序, 取头部。',
              scope: 'workspace',
              evidence: 'extracted',
              reason: '会话产物',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result.created).toBe(1);
    const entries = expectOk(store.listActive('knowledge'));
    expect(entries).toHaveLength(1);
    // 水位回到实际行数。
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(2);

    // 全量重提幂等: 同内容再提 → 层内查重命中既有 active → skipped, 不产生第二份。
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '动量策略框架',
              content: '动量策略: 过去 N 日涨幅排序, 取头部。',
              scope: 'workspace',
              evidence: 'extracted',
              reason: '会话产物',
            }),
          ],
        }),
      ),
    );
    expectOk(store.setExtractionWatermark(sessionFile, 10));
    const rerun = expectOk(await runExtraction(sessionFile, deps()));
    expect(expectOk(store.listActive('knowledge'))).toHaveLength(1);
    expect(rerun.created).toBe(0); // 幂等命中既有条目,不重复落库
    expect(rerun.skipped).toBeGreaterThanOrEqual(1); // 命中计 skipped
  });

  it('update targetTitle 未命中 → skipped, 不降级 create(C4)', async () => {
    const sessionFile = path.join(dir, 'sess-downgrade.jsonl');
    writeSession(sessionFile, [
      { id: 'e1', role: 'user', text: '记住: 选股先看流动性' },
      { id: 'e2', role: 'assistant', text: '已记录。' },
    ]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'update',
              kind: 'knowledge',
              title: '选股先看流动性',
              content: '选股先看流动性, 排除成交额过低的标的。',
              targetTitle: '不存在的旧标题',
              scope: 'workspace',
              evidence: 'user-stated',
              reason: '用户规则',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 1 });
    expect(activeTitles(store, 'knowledge')).not.toContain('选股先看流动性');
    expect(expectOk(store.listActive())).toHaveLength(0);
  });

  it('候选非法(枚举越界/超长) → 计 skipped, 其余候选正常落库, 水位推进', async () => {
    const sessionFile = path.join(dir, 'sess-skip.jsonl');
    writeSession(sessionFile, [{ id: 'g1', role: 'user', text: '两个候选, 一个非法' }]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'bogus_kind' as unknown as ExtractionCandidate['kind'], // 非法 kind
              title: '非法候选',
              content: 'x',
              scope: 'user',
              evidence: 'extracted',
              reason: 'r',
            }),
            {
              action: 'create',
              kind: 'knowledge',
              title: '合法候选',
              content: 'x'.repeat(3000), // 超 2048 字节
              scope: 'user',
              evidence: 'extracted',
              reason: 'r',
            },
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '正常条目',
              content: '正常内容',
              scope: 'user',
              evidence: 'extracted',
              reason: 'r',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 1, updated: 0, retired: 0, skipped: 2 });
    expect(activeTitles(store, 'knowledge')).toEqual(['正常条目']);
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(1);
  });

  it('retire 候选:targetTitle 命中 → 条目 retired;未命中 → skipped', async () => {
    const sessionFile = path.join(dir, 'sess-retire.jsonl');
    const seeded = expectOk(
      store.propose({
        kind: 'hard_policy',
        title: '旧规则: 每天收盘前清仓',
        content: '每日收盘前清空仓位。',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'user',
        workspace: null,
        evidence: 'user-stated',
        basis: '用户曾明说',
      }),
    );
    writeSession(sessionFile, [{ id: 'h1', role: 'user', text: '那条清仓规则以后不要了' }]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'retire',
              kind: 'hard_policy',
              title: '旧规则: 每天收盘前清仓',
              content: 'x',
              targetTitle: '旧规则: 每天收盘前清仓',
              scope: 'user',
              evidence: 'user-stated',
              reason: '用户作废',
            }),
            candidate({
              action: 'retire',
              kind: 'hard_policy',
              title: '不存在的规则',
              content: 'x',
              targetTitle: '不存在的规则',
              scope: 'user',
              evidence: 'user-stated',
              reason: 'r',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 0, retired: 1, skipped: 1 });
    const archived = expectOk(store.listArchived());
    expect(archived.find((e) => e.entryId === seeded.entryId)?.lifecycle).toBe('retired');
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2026-08-11 记忆管道修复回归(C1-C4 + H1-H3 + 同根 MEDIUM)
  // -------------------------------------------------------------------------

  it('撕裂行: 文件尾半行 → 水位停在最后成功行, 增量不含坏行; 补全后重试恢复', async () => {
    const sessionFile = path.join(dir, 'sess-torn.jsonl');
    writeSession(sessionFile, [
      { id: 't1', role: 'user', text: '记住: 撕裂行前的消息' },
      { id: 't2', role: 'assistant', text: '已记录。' },
    ]);
    appendFileSync(sessionFile, '\n{"type": "mess'); // 半行(append 与读取重叠/崩溃截断)
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    // 水位 = 最后成功解析行(2), 不越过撕裂行
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(2);
    expect(invoke.mock.calls[0][0]).not.toContain('{"type": "mess');

    // 撕裂行被补全 → 下次活动重试该行, 增量含它, 水位推进
    appendFileSync(
      sessionFile,
      'age", "id": "t3", "parentId": null, "timestamp": 123, "message": {"role": "user", "content": "补全的消息"}}',
    );
    const retried = expectOk(await runExtraction(sessionFile, deps()));
    expect(retried).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0]).toContain('[user] 补全的消息');
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(3);
  });

  it('compaction 摘要行: 追加到增量尾部参与提取(头部裁剪不牺牲它)', async () => {
    const sessionFile = path.join(dir, 'sess-compact-line.jsonl');
    writeSession(sessionFile, [{ id: 'c1', role: 'user', text: '早期消息' }]);
    appendFileSync(
      sessionFile,
      `\n${JSON.stringify({ type: 'compaction', id: 'c2', parentId: null, timestamp: Date.now(), summary: '旧消息汇总: 用户做了 A 决定' })}`,
    );
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    const prompt = invoke.mock.calls[0][0];
    expect(prompt).toContain('[会话压缩摘要] 旧消息汇总: 用户做了 A 决定');
    // 摘要行在增量尾部: 消息行在前, 摘要行在后(裁剪时尾部保留)
    expect(prompt.indexOf('[会话压缩摘要]')).toBeGreaterThan(prompt.indexOf('[user] 早期消息'));
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(2);
  });

  it('增量上限: 多行合计超 64KB → 头部裁剪保留尾部(最近内容优先)', async () => {
    const sessionFile = path.join(dir, 'sess-big.jsonl');
    writeSession(sessionFile, [
      { id: 'b1', role: 'user', text: 'X'.repeat(40_000) }, // 单行 < 64KB
      { id: 'b2', role: 'assistant', text: 'Y'.repeat(40_000) }, // 合计 > 64KB
    ]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    const incremental = incrementalOf(invoke.mock.calls[0][0]);
    expect(Buffer.byteLength(incremental, 'utf8')).toBeLessThanOrEqual(64_000);
    expect(incremental).toContain(`[assistant] ${'Y'.repeat(40_000)}`); // 尾部完整
    expect(incremental).not.toContain(`[user] ${'X'.repeat(40_000)}`); // 头部被裁
    // 水位照常推进(被裁内容不重提)
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(2);
  });

  it('增量上限: 单行超限 → 行内按字节从尾部截断, 不整行丢弃', async () => {
    const sessionFile = path.join(dir, 'sess-single-big.jsonl');
    writeSession(sessionFile, [{ id: 's1', role: 'user', text: 'Z'.repeat(100_000) }]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    const incremental = incrementalOf(invoke.mock.calls[0][0]);
    expect(Buffer.byteLength(incremental, 'utf8')).toBeLessThanOrEqual(64_000);
    // 以消息文本结尾(尾部保留, 前缀 [user] 被裁)
    expect(incremental.endsWith('Z'.repeat(1000))).toBe(true);
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(1);
  });

  it('层内查重: 同批重复候选 + 命中既有 active → skipped 不落库', async () => {
    const sessionFile = path.join(dir, 'sess-dedup.jsonl');
    expectOk(
      store.propose({
        kind: 'soft_preference',
        title: '既有偏好',
        content: '已有内容',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'user',
        workspace: null,
        evidence: 'user-stated',
        basis: '先前会话',
      }),
    );
    writeSession(sessionFile, [
      { id: 'v1', role: 'user', text: '记住这条规则' },
      { id: 'v2', role: 'assistant', text: '已记录。' },
    ]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'soft_preference',
              title: '既有偏好',
              content: '已有内容',
              scope: 'user',
              evidence: 'user-stated',
              reason: 'r',
            }), // 命中既有 active → skip
            candidate({
              action: 'create',
              kind: 'soft_preference',
              title: '既有偏好',
              content: '已有内容',
              scope: 'user',
              evidence: 'user-stated',
              reason: 'r',
            }), // 批内重复 → skip
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '新知识',
              content: '新内容',
              scope: 'user',
              evidence: 'extracted',
              reason: 'r',
            }), // 新内容 → create
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 1, updated: 0, retired: 0, skipped: 2 });
    expect(activeTitles(store, 'soft_preference')).toEqual(['既有偏好']); // 无重复
    expect(activeTitles(store, 'knowledge')).toEqual(['新知识']);
    expect(emitted).toHaveLength(1); // 幂等命中不 emitRecorded
  });

  it('层内查重跨工作区: 同内容不同 workspace → 不误吞(两条独立记忆)', async () => {
    const sessionFile = path.join(dir, 'sess-ws.jsonl');
    writeSession(sessionFile, [{ id: 'w1', role: 'user', text: '工作区绑定内容' }]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '绑定条目',
              content: '工作区专用内容',
              scope: 'workspace',
              evidence: 'extracted',
              reason: 'r',
            }),
          ],
        }),
      ),
    );

    const first = expectOk(await runExtraction(sessionFile, deps()));
    expect(first.created).toBe(1);

    appendSession(sessionFile, [{ id: 'w2', role: 'user', text: '换工作区再提一次' }]);
    const second = expectOk(
      await runExtraction(sessionFile, { ...deps(), workspace: 'D:\\other' }),
    );
    expect(second.created).toBe(1); // 另一工作区同内容 → 新条目, 不被查重吞掉
    const entries = expectOk(store.listActive('knowledge'));
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.workspace).sort()).toEqual(['C:\\work\\quant', 'D:\\other']);
  });

  it('update 预比对: title/content/kind 全同 → skipped, 不建 supersede 链', async () => {
    const sessionFile = path.join(dir, 'sess-precompare.jsonl');
    const seeded = expectOk(
      store.propose({
        kind: 'hard_policy',
        title: '每日复盘',
        content: '每天收盘后做复盘。',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'user',
        workspace: null,
        evidence: 'user-stated',
        basis: '用户曾明说',
      }),
    );
    writeSession(sessionFile, [{ id: 'p1', role: 'user', text: '重申一下那条规则' }]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'update',
              kind: 'hard_policy',
              title: '每日复盘',
              content: '每天收盘后做复盘。', // 与既有完全一致
              targetTitle: '每日复盘',
              scope: 'user',
              evidence: 'user-stated',
              reason: '用户重申',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 1 });
    expect(expectOk(store.listActive())).toHaveLength(1);
    const archived = expectOk(store.listArchived());
    expect(archived.find((e) => e.entryId === seeded.entryId)?.lifecycle).toBeUndefined();
  });

  it('update 预比对: 内容相同仅 reason 不同(basis 入哈希) → 仍 skip(m6)', async () => {
    const sessionFile = path.join(dir, 'sess-reason.jsonl');
    const seeded = expectOk(
      store.propose({
        kind: 'soft_preference',
        title: '回答要简洁',
        content: '用户偏好简洁回答。',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'user',
        workspace: null,
        evidence: 'user-stated',
        basis: '旧依据',
      }),
    );
    writeSession(sessionFile, [{ id: 'r1', role: 'user', text: '还是简洁点好' }]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'update',
              kind: 'soft_preference',
              title: '回答要简洁',
              content: '用户偏好简洁回答。', // title/content/kind 全同, 仅 reason 措辞不同
              targetTitle: '回答要简洁',
              scope: 'user',
              evidence: 'user-stated',
              reason: '用户今天重申的措辞',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 1 });
    expect(expectOk(store.listActive())).toHaveLength(1);
    const archived = expectOk(store.listArchived());
    expect(archived.find((e) => e.entryId === seeded.entryId)?.lifecycle).toBeUndefined();
  });

  it('update 传 kind: 候选 kind 与既有不同 → 更新后条目 kind 改变', async () => {
    const sessionFile = path.join(dir, 'sess-kind.jsonl');
    expectOk(
      store.propose({
        kind: 'knowledge',
        title: '量化框架',
        content: '旧内容。',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'user',
        workspace: null,
        evidence: 'user-stated',
        basis: '旧依据',
      }),
    );
    writeSession(sessionFile, [{ id: 'k1', role: 'user', text: '把这个归到工作上下文' }]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'update',
              kind: 'working_context',
              title: '量化框架',
              content: '量化框架: 用户正在推进的新内容。',
              targetTitle: '量化框架',
              scope: 'user',
              evidence: 'user-stated',
              reason: '用户重新归类',
            }),
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 1, retired: 0, skipped: 0 });
    const wc = expectOk(store.listActive('working_context'));
    expect(wc).toHaveLength(1);
    expect(wc[0].title).toBe('量化框架');
    expect(expectOk(store.listActive('knowledge'))).toHaveLength(0); // 原 kind 下已无
  });

  it('scope 过滤(H2): 跨工作区/跨 scope 的 targetTitle → 未命中 skipped', async () => {
    const sessionFile = path.join(dir, 'sess-scope.jsonl');
    expectOk(
      store.propose({
        kind: 'knowledge',
        title: '本区条目',
        content: '本工作区内容。',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'workspace',
        workspace: 'C:\\work\\quant',
        evidence: 'user-stated',
        basis: 'b',
      }),
    );
    expectOk(
      store.propose({
        kind: 'knowledge',
        title: '别区条目',
        content: '别的工作区内容。',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'workspace',
        workspace: 'D:\\other',
        evidence: 'user-stated',
        basis: 'b',
      }),
    );
    writeSession(sessionFile, [{ id: 's1', role: 'user', text: '改一下记忆' }]);
    invoke.mockResolvedValue(
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'update',
              kind: 'knowledge',
              title: 'x',
              content: '新内容',
              targetTitle: '本区条目',
              scope: 'workspace',
              evidence: 'user-stated',
              reason: 'r',
            }), // 本工作区 → 命中
            candidate({
              action: 'update',
              kind: 'knowledge',
              title: 'y',
              content: '新内容',
              targetTitle: '别区条目',
              scope: 'workspace',
              evidence: 'user-stated',
              reason: 'r',
            }), // 另一工作区 → 未命中
            candidate({
              action: 'update',
              kind: 'knowledge',
              title: 'z',
              content: '新内容',
              targetTitle: '本区条目',
              scope: 'user',
              evidence: 'user-stated',
              reason: 'r',
            }), // user 候选打 workspace 条目 → 未命中
          ],
        }),
      ),
    );

    const result = expectOk(await runExtraction(sessionFile, deps()));
    expect(result).toEqual({ created: 0, updated: 1, retired: 0, skipped: 2 });
  });

  it('提示词边界(H1): nonce 包裹增量 + 不可信纪律 + 清单 scope 标注(M5)', async () => {
    const sessionFile = path.join(dir, 'sess-prompt.jsonl');
    expectOk(
      store.propose({
        kind: 'knowledge',
        title: '用户条目',
        content: '个人知识。',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'user',
        workspace: null,
        evidence: 'user-stated',
        basis: 'b',
      }),
    );
    expectOk(
      store.propose({
        kind: 'working_context',
        title: '工作区条目',
        content: '工作区内容。',
        producer: 'pi-sdk',
        source: 'agent-proposal',
        scope: 'workspace',
        workspace: 'C:\\work\\quant',
        evidence: 'user-stated',
        basis: 'b',
      }),
    );
    writeSession(sessionFile, [{ id: 'n1', role: 'user', text: '记住这个' }]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));

    await runExtraction(sessionFile, deps());
    const prompt = invoke.mock.calls[0][0];
    expect(prompt).toContain('<untrusted-session-');
    expect(prompt).toContain('</untrusted-session-');
    expect(prompt).toContain('不可信内容纪律');
    // M5: 既有清单行含 [user]/[workspace] scope 标注(供模型给出可寻址 targetTitle)
    expect(prompt).toMatch(/\[knowledge\]\[user\]/);
    expect(prompt).toMatch(/\[working_context\]\[workspace\]/);
  });

  // -------------------------------------------------------------------------
  // 2026-08-11 记忆提取效率:轮次节流(行为 2)+ 提取纪律负清单(行为 3)+ 清单截断(行为 4)
  // -------------------------------------------------------------------------

  it('轮次节流:首次提取(水位 0)不受门槛限制,1 条 user 消息即提取', async () => {
    const sessionFile = path.join(dir, 'sess-throttle-first.jsonl');
    writeSession(sessionFile, [{ id: 't1', role: 'user', text: '记住: 回测用前复权' }]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));

    const result = expectOk(
      await runExtraction(sessionFile, { ...deps(), minUserTurnsBetweenExtractions: 5 }),
    );
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    expect(invoke).toHaveBeenCalledTimes(1); // 水位 0 无条件提取
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(1);
  });

  it('轮次节流:水位>0 且用户消息不足门槛 → 跳过,零摘要、不调模型、水位不变', async () => {
    const sessionFile = path.join(dir, 'sess-throttle-skip.jsonl');
    writeSession(sessionFile, [{ id: 't1', role: 'user', text: '第一条' }]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));
    expectOk(await runExtraction(sessionFile, deps())); // 首次(水位 0)提取, 水位 = 1
    expect(invoke).toHaveBeenCalledTimes(1);

    // 追加 4 行:2 user + 2 assistant(增量内 user 轮数 = 2 < 5)
    appendSession(sessionFile, [
      { id: 't2', role: 'user', text: '第二条' },
      { id: 't3', role: 'assistant', text: '回 A' },
      { id: 't4', role: 'user', text: '第三条' },
      { id: 't5', role: 'assistant', text: '回 B' },
    ]);
    const result = expectOk(
      await runExtraction(sessionFile, { ...deps(), minUserTurnsBetweenExtractions: 5 }),
    );
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    expect(invoke).toHaveBeenCalledTimes(1); // 未调模型
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(1); // 水位不推

    // 再追加 3 条 user → 增量内累计 5 轮 → 提取, 水位推进到总行数
    appendSession(sessionFile, [
      { id: 't6', role: 'user', text: '第四条' },
      { id: 't7', role: 'user', text: '第五条' },
      { id: 't8', role: 'user', text: '第六条' },
    ]);
    const done = expectOk(
      await runExtraction(sessionFile, { ...deps(), minUserTurnsBetweenExtractions: 5 }),
    );
    expect(done).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(8); // 总行数
  });

  it('轮次节流:compaction 摘要行不计入用户轮数(1 摘要 + 1 user 仍跳过)', async () => {
    const sessionFile = path.join(dir, 'sess-throttle-compact.jsonl');
    writeSession(sessionFile, [{ id: 't1', role: 'user', text: '第一条' }]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));
    expectOk(await runExtraction(sessionFile, deps()));
    expect(invoke).toHaveBeenCalledTimes(1);

    appendFileSync(
      sessionFile,
      `\n${JSON.stringify({ type: 'compaction', id: 't2', parentId: null, timestamp: Date.now(), summary: '旧消息汇总: 用户做了 A 决定' })}`,
    );
    appendSession(sessionFile, [{ id: 't3', role: 'user', text: '第二条' }]);

    const result = expectOk(
      await runExtraction(sessionFile, { ...deps(), minUserTurnsBetweenExtractions: 5 }),
    );
    expect(result).toEqual({ created: 0, updated: 0, retired: 0, skipped: 0 });
    expect(invoke).toHaveBeenCalledTimes(1); // 摘要行不算轮次 → 仍跳过
    expect(expectOk(store.getExtractionWatermark(sessionFile))).toBe(1);
  });

  it('提取纪律(行为 3):prompt 含「禁止提取」负清单(环境依赖失败等)', async () => {
    const sessionFile = path.join(dir, 'sess-discipline.jsonl');
    writeSession(sessionFile, [{ id: 'd1', role: 'user', text: '记住这个' }]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));
    await runExtraction(sessionFile, deps());

    const prompt = invoke.mock.calls[0][0];
    expect(prompt).toContain('禁止提取');
    expect(prompt).toContain('环境依赖失败');
    expect(prompt).toContain('负面断言');
    expect(prompt).toContain('未解决的失败');
  });

  it('既有清单截断(行为 4):seed 25 条 → prompt 清单仅前 20 条', async () => {
    const sessionFile = path.join(dir, 'sess-list20.jsonl');
    for (let i = 0; i < 25; i++) {
      expectOk(
        store.propose({
          kind: 'knowledge',
          title: `既有条目 ${i}`,
          content: `内容 ${i}`,
          producer: 'pi-sdk',
          source: 'agent-proposal',
          scope: 'user',
          workspace: null,
          evidence: 'user-stated',
          basis: 'seed',
        }),
      );
    }
    writeSession(sessionFile, [{ id: 'l1', role: 'user', text: '记住这个' }]);
    invoke.mockResolvedValue(ok(JSON.stringify({ candidates: [] })));
    await runExtraction(sessionFile, deps());

    const prompt = invoke.mock.calls[0][0];
    const listLines = prompt.match(/^- \S+ \[[a-z_]+\]\[[a-z_]+\] /gm) ?? [];
    expect(listLines).toHaveLength(20); // 80 → 20 截断生效
    expect(prompt).toContain('既有记忆清单(前 20 条');
    // 清单行全部来自 25 条 seed(listActive 按 updated_at DESC, 具体哪 20 条不锁定)
    const seededTitles = prompt.match(/既有条目 \d+/g) ?? [];
    expect(seededTitles).toHaveLength(20);
  });
});

/** 类型面断言:MemoryStore 结构上满足 ExtractorStore(测试契约)。 */
void (null as unknown as (s: ExtractorStore) => void);

describe('session-memory-extractor ofkRef（）', () => {
  it('候选带 ofkRef → propose 入参透传,条目落库带指针', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lorra-extract-ofk-'));
    const store = expectOk(MemoryStore.open(path.join(dir, 'memory.db')));
    const invoke = vi.fn<ModelInvoke>(async () =>
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '长文档知识页',
              content: '摘要内容',
              scope: 'user',
              evidence: 'extracted',
              reason: 'r',
              ofkRef: '/memory/long1.md',
            }),
          ],
        }),
      ),
    );
    const sessionFile = path.join(dir, 'sess-ofk.jsonl');
    writeSession(sessionFile, [{ id: 'g1', role: 'user', text: '贴了一篇长文并让我记住要点' }]);

    const result = expectOk(
      await runExtraction(sessionFile, {
        invoke,
        getStore: () => store,
        workspace: 'C:\\work\\demo',
      }),
    );
    expect(result.created).toBe(1);
    const entry = expectOk(store.listActive()).find((e) => e.title === '长文档知识页');
    expect(entry).toBeDefined();
    if (!entry) throw new Error('entry missing');
    expect(entry.ofkRef).toBe('/memory/long1.md');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('候选 ofkRef 非法(不在白名单形态/含穿越段) → 忽略该字段(不落指针)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lorra-extract-ofk2-'));
    const store = expectOk(MemoryStore.open(path.join(dir, 'memory.db')));
    const invoke = vi.fn<ModelInvoke>(async () =>
      ok(
        JSON.stringify({
          candidates: [
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '无指针条目',
              content: '内容',
              scope: 'user',
              evidence: 'extracted',
              reason: 'r',
              ofkRef: 'bad-ref',
            }),
            candidate({
              action: 'create',
              kind: 'knowledge',
              title: '穿越段条目',
              content: '内容 2',
              scope: 'user',
              evidence: 'extracted',
              reason: 'r',
              ofkRef: '/memory/a/../escape.md',
            }),
          ],
        }),
      ),
    );
    const sessionFile = path.join(dir, 'sess-ofk2.jsonl');
    writeSession(sessionFile, [{ id: 'g1', role: 'user', text: '记住这段' }]);

    const result = expectOk(
      await runExtraction(sessionFile, {
        invoke,
        getStore: () => store,
        workspace: 'C:\\work\\demo',
      }),
    );
    expect(result.created).toBe(2);
    for (const title of ['无指针条目', '穿越段条目']) {
      const entry = expectOk(store.listActive()).find((e) => e.title === title);
      expect(entry).toBeDefined();
      if (!entry) throw new Error(`entry missing: ${title}`);
      expect(entry.ofkRef).toBeNull();
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
