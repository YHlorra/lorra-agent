import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkOkfDocument } from '../../src/main/ofk/okf-checker';
import type { Result } from '../../src/shared/result';

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lorra-okf-check-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('checkOkfDocument', () => {
  it('缺少 frontmatter 时返回最小健康提示，不抛错', async () => {
    const target = path.join(dir, 'plain.md');
    writeFileSync(target, '# 纯正文\n\n没有 frontmatter', 'utf8');

    const result = expectOk(await checkOkfDocument(target));

    expect(result.path).toBe(target);
    expect(result.type).toBeNull();
    expect(result.generated).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-frontmatter', level: 'warn' }),
        expect.objectContaining({ code: 'missing-type', level: 'warn' }),
        expect.objectContaining({ code: 'unverified', level: 'info' }),
        expect.objectContaining({ code: 'missing-freshness', level: 'info' }),
        expect.objectContaining({ code: 'missing-lifecycle', level: 'info' }),
      ]),
    );
  });

  it('frontmatter 完整时返回通过结果，不追加多余问题', async () => {
    const target = path.join(dir, 'skill.md');
    writeFileSync(
      target,
      [
        '---',
        'type: Skill',
        'sources:',
        '  - resource: memory:entry-1',
        'generated:',
        '  by: lorra-test',
        '  at: 2026-08-17T00:00:00.000Z',
        'verified: true',
        'freshness: fresh',
        'lifecycle: active',
        '---',
        '',
        '# Skill',
      ].join('\n'),
      'utf8',
    );

    const result = expectOk(await checkOkfDocument(target));

    expect(result).toEqual({
      path: target,
      type: 'Skill',
      generated: true,
      verified: true,
      issues: [],
    });
  });

  it('目标不存在时返回 not-found', async () => {
    const result = await checkOkfDocument(path.join(dir, 'missing.md'));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('not-found');
    }
  });
});
