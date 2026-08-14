import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendLog,
  dayConceptPath,
  listDayConceptFiles,
  memoryDocPath,
  ofkBundleRoot,
  readConcept,
  referencePath,
  refreshIndex,
  sessionConceptPath,
  writeConcept,
  writeConceptSync,
  wsSlugOf,
} from '../../src/main/ofk/ofk-bundle';
import { FACTS_SCHEMA_VERSION, factIdOf, type SessionFact } from '../../src/shared/facts-schema';

// Requirement(plan D1/D4):bundle 布局与写入纪律——路径拒绝 .. / 绝对路径、
// appendLog 幂等、refreshIndex 分节输出。ofk-bundle 只依赖 lorraConfigDir
// (调用时读 env),不依赖 electron;LORRA_E2E_USERDATA 指向 tmp 即隔离。

function makeFact(overrides: Partial<SessionFact> = {}): SessionFact {
  const content: Omit<SessionFact, 'factId'> = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    collector: 'pi-sdk',
    runtime: 'pi-sdk',
    agentId: 'pi-sdk',
    sessionRef: 'sess-abc123',
    workspace: 'C:\\work\\demo',
    scope: 'workspace',
    start: new Date(2026, 7, 8, 9).getTime(),
    end: new Date(2026, 7, 8, 9, 1).getTime(),
    activeMs: 60_000,
    title: 'Fix the flaky login test',
    summaryRef: null,
    tokens: 120,
    model: 'anthropic/claude-sonnet-4',
    tools: ['read', 'write'],
    unfinished: false,
    containsTodo: false,
    privacy: 'public_safe',
  };
  const merged = { ...content, ...overrides };
  return { factId: factIdOf(merged), ...merged };
}

describe('ofk-bundle', () => {
  let userdata: string;

  beforeEach(() => {
    userdata = mkdtempSync(path.join(tmpdir(), 'lorra-ofk-'));
    vi.stubEnv('LORRA_E2E_USERDATA', userdata);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(userdata, { recursive: true, force: true });
  });

  it('bundle 根 = <userdata>/.lorra/knowledge', () => {
    expect(ofkBundleRoot()).toBe(path.join(userdata, '.lorra', 'knowledge'));
  });

  describe('路径工具(plan D1)', () => {
    it('wsSlugOf: pi-sdk 源对 workspace 施加 lorraSessionDir 同款编码并剥首尾 --', () => {
      expect(wsSlugOf(makeFact({ collector: 'pi-sdk', workspace: 'C:\\work\\demo' }))).toBe(
        'C--work-demo',
      );
      expect(wsSlugOf(makeFact({ collector: 'pi-sdk', workspace: 'E:/work/demo' }))).toBe(
        'E--work-demo',
      );
      // POSIX 形态:去首 / 后把 / 换成 -
      expect(wsSlugOf(makeFact({ collector: 'pi-sdk', workspace: '/home/user/proj' }))).toBe(
        'home-user-proj',
      );
    });

    it('wsSlugOf: 非 pi 源取 workspace basename 清洗', () => {
      expect(wsSlugOf(makeFact({ collector: 'claude-code', workspace: 'E:/work/my proj' }))).toBe(
        'my-proj',
      );
      expect(wsSlugOf(makeFact({ collector: 'claude-code', workspace: 'E:/work/demo' }))).toBe(
        'demo',
      );
    });

    it('sessionConceptPath: sessions/<slug>/<YYYY>/<YYYY-MM-DD>/<sessionRef>.md(日期取 start 本地日)', () => {
      const fact = makeFact({
        sessionRef: 'sess-abc123',
        start: new Date(2026, 7, 8, 9).getTime(),
      });
      expect(sessionConceptPath(fact)).toBe(
        path.join('sessions', 'C--work-demo', '2026', '2026-08-08', 'sess-abc123.md'),
      );
    });

    it('dayConceptPath / referencePath / memoryDocPath 形态', () => {
      expect(dayConceptPath('C--work-demo', '2026-08-08')).toBe(
        path.join('days', 'C--work-demo', '2026-08-08.md'),
      );
      expect(referencePath('my-slug')).toBe(path.join('references', 'my-slug.md'));
      expect(memoryDocPath('entry-1')).toBe(path.join('memory', 'entry-1.md'));
    });
  });

  describe('写入纪律(D4)', () => {
    it('writeConcept 拒绝 .. 段与绝对路径 → Err(ofk-path-invalid),不落盘', async () => {
      const escaped = await writeConcept('../escape.md', '# x');
      expect(escaped.isErr()).toBe(true);
      expect(escaped.match({ ok: () => '', err: (e) => e.code })).toBe('ofk-path-invalid');

      const nested = await writeConcept('sessions/../x.md', '# x');
      expect(nested.isErr()).toBe(true);
      expect(nested.match({ ok: () => '', err: (e) => e.code })).toBe('ofk-path-invalid');

      const absolute = await writeConcept(path.resolve(userdata, 'outside', 'x.md'), '# x');
      expect(absolute.isErr()).toBe(true);
      expect(absolute.match({ ok: () => '', err: (e) => e.code })).toBe('ofk-path-invalid');

      // 空路径同样拒绝
      const empty = await writeConcept('', '# x');
      expect(empty.isErr()).toBe(true);

      // bundle 内未产生任何文件
      expect(existsSync(path.join(ofkBundleRoot(), 'escape.md'))).toBe(false);
      expect(existsSync(path.resolve(userdata, 'outside'))).toBe(false);
    });

    it('writeConcept 写入 + readConcept 读回;不存在 → Ok(null)', async () => {
      const rel = path.join('sessions', 'ws', '2026', '2026-08-08', 's.md');
      const res = await writeConcept(rel, '# hello');
      expect(res.isOk()).toBe(true);
      const read = await readConcept(rel);
      expect(read.isOk()).toBe(true);
      expect(read.unwrapOr(null)).toBe('# hello');
      const missing = await readConcept('sessions/ws/2026/2026-08-08/none.md');
      expect(missing.isOk()).toBe(true);
      expect(missing.unwrapOr('x')).toBeNull();
    });

    it('canonical ofkRef 形态(前导 /)与相对形态等价;穿越依旧拒绝', async () => {
      // :迁移/工具产出的指针带前导 /(/memory/<id>.md),读写原语必须接受
      const canonical = await writeConcept('/memory/c1.md', '# canonical');
      expect(canonical.isOk()).toBe(true);
      const canonicalRead = await readConcept('/memory/c1.md');
      expect(canonicalRead.isOk()).toBe(true);
      expect(canonicalRead.unwrapOr(null)).toBe('# canonical');
      // 相对形态读同一文件
      const relRead = await readConcept('memory/c1.md');
      expect(relRead.unwrapOr(null)).toBe('# canonical');
      // 剥掉前导斜杠后仍含穿越 → 拒绝
      const escaped = await writeConcept('/../escape.md', '# x');
      expect(escaped.isErr()).toBe(true);
      expect(escaped.match({ ok: () => '', err: (e) => e.code })).toBe('ofk-path-invalid');
      expect(existsSync(path.join(ofkBundleRoot(), 'escape.md'))).toBe(false);
      // 纯斜杠/空 → 拒绝
      expect((await writeConcept('/', '# x')).isErr()).toBe(true);
      expect((await writeConcept('//', '# x')).isErr()).toBe(true);
    });

    it('writeConceptSync 同款校验:拒绝 .. 段与绝对路径;合法写入落盘(原子写)', () => {
      const escaped = writeConceptSync('../escape.md', '# x');
      expect(escaped.isErr()).toBe(true);
      expect(escaped.match({ ok: () => '', err: (e) => e.code })).toBe('ofk-path-invalid');

      const nested = writeConceptSync('memory/../x.md', '# x');
      expect(nested.isErr()).toBe(true);

      const absolute = writeConceptSync(path.resolve(userdata, 'outside', 'x.md'), '# x');
      expect(absolute.isErr()).toBe(true);

      const empty = writeConceptSync('', '# x');
      expect(empty.isErr()).toBe(true);

      // 不落盘
      expect(existsSync(path.join(ofkBundleRoot(), 'escape.md'))).toBe(false);
      expect(existsSync(path.resolve(userdata, 'outside'))).toBe(false);

      // 合法路径写入 + 读回
      const written = writeConceptSync('memory/e1.md', '# doc');
      expect(written.isOk()).toBe(true);
      expect(readFileSync(path.join(ofkBundleRoot(), 'memory', 'e1.md'), 'utf8')).toBe('# doc');
    });

    it('appendLog 幂等:同日重复追加同文本行只落一次;新日期追加新分组', async () => {
      const entry = '**Creation**: [Fix the flaky login test](sessions/x.md)';
      await appendLog('2026-08-08', entry);
      await appendLog('2026-08-08', entry);
      const first = await readConcept('log.md');
      expect(first.unwrapOr('')).toContain('## 2026-08-08');
      expect((first.unwrapOr('') ?? '').match(/- \*\*Creation\*\*/g)).toHaveLength(1);

      await appendLog('2026-08-09', '**Creation**: [Another](sessions/y.md)');
      const second = await readConcept('log.md');
      expect(second.unwrapOr('')).toContain('## 2026-08-09');
      expect(second.unwrapOr('')).toContain('## 2026-08-08');
      // 幂等:再追加 08-08 的旧条目仍不重复
      await appendLog('2026-08-08', entry);
      const third = await readConcept('log.md');
      expect((third.unwrapOr('') ?? '').match(/- \*\*Creation\*\*/g)).toHaveLength(2);
    });

    it('refreshIndex: 按节输出会话/记忆文档,无文档节不出现;根 index 幂等重生成', async () => {
      const sessionRel = path.join('sessions', 'ws', '2026', '2026-08-08', 's1.md');
      await writeConcept(sessionRel, '---\ntype: Session\ntitle: 修登录\n---\nbody');
      const memoryRel = path.join('memory', 'e1.md');
      await writeConcept(
        memoryRel,
        '---\ntype: Memory\ntitle: 记忆条目\ndescription: 一段描述\n---\nbody',
      );

      const res = await refreshIndex();
      expect(res.isOk()).toBe(true);
      const index = await readConcept('index.md');
      expect(index.unwrapOr('')).toContain('## 会话');
      expect(index.unwrapOr('')).toContain('[修登录](sessions/ws/2026/2026-08-08/s1.md)');
      expect(index.unwrapOr('')).toContain('## 记忆');
      expect(index.unwrapOr('')).toContain('[记忆条目](memory/e1.md) - 一段描述');
      // 无文档节不出现
      expect(index.unwrapOr('')).not.toContain('## 参考资料');

      // 再刷一次内容一致(确定性)
      await refreshIndex();
      const again = await readConcept('index.md');
      expect(again.unwrapOr('')).toBe(index.unwrapOr(''));
    });

    it('listDayConceptFiles: 只回该本地日各工作区的 *.md(相对路径,正斜杠)', async () => {
      await writeConcept(path.join('sessions', 'C--work-demo', '2026', '2026-08-08', 'a.md'), 'x');
      await writeConcept(path.join('sessions', 'C--work-demo', '2026', '2026-08-08', 'b.md'), 'x');
      await writeConcept(path.join('sessions', 'C--work-demo', '2026', '2026-08-07', 'c.md'), 'x');
      await writeConcept(
        path.join('sessions', 'C--work-demo', '2026', '2026-08-08', 'note.txt'),
        'x',
      );
      const listed = await listDayConceptFiles('2026-08-08');
      expect(listed.isOk()).toBe(true);
      const paths = listed.unwrapOr([]);
      expect(paths).toHaveLength(2);
      expect(paths.every((p) => p.endsWith('.md') && !p.includes('\\'))).toBe(true);
    });
  });
});
