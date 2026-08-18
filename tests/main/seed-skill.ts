import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrSeedSkill } from '../../src/main/memory/review-generator';
import type { Result } from '../../src/shared/result';

/**
 * loadOrSeedSkill 的通用行为矩阵(2026-08-17 收敛):
 * 被 review-generator / memory-maintenance / skill-meta 共用,错误码统一为 seed-skill-failed。
 * 各具体 seed 文本的内容契约另写在各自 seed.test.ts(只断言种子文本本身的字段)。
 */

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

export interface SeedFixture {
  readonly name: string;
  readonly seed: string;
}

export function describeSeedSkillBehavior(label: string, fixture: SeedFixture): void {
  describe(`loadOrSeedSkill - ${label}`, () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'lorra-seed-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const TARGET = () => path.join(dir, '.lorra', 'skills', `${fixture.name}.md`);

    it('缺失时写入内置原文, 返回读到的原文', () => {
      const result = expectOk(loadOrSeedSkill(dir, fixture.name, fixture.seed));

      expect(existsSync(TARGET())).toBe(true);
      expect(readFileSync(TARGET(), 'utf8')).toBe(fixture.seed);
      expect(result).toBe(fixture.seed);
    });

    it('已存在不覆盖: 用户自定义内容原样保留', () => {
      const custom = `# 自定义 ${fixture.name}\n用户内容`;
      mkdirSync(path.dirname(TARGET()), { recursive: true });
      writeFileSync(TARGET(), custom, 'utf8');

      const result = expectOk(loadOrSeedSkill(dir, fixture.name, fixture.seed));

      expect(readFileSync(TARGET(), 'utf8')).toBe(custom);
      expect(result).toBe(custom);
    });

    it('幂等: 重复播种不覆写', () => {
      const first = expectOk(loadOrSeedSkill(dir, fixture.name, fixture.seed));
      const second = expectOk(loadOrSeedSkill(dir, fixture.name, fixture.seed));
      const third = expectOk(loadOrSeedSkill(dir, fixture.name, fixture.seed));

      expect(first).toBe(fixture.seed);
      expect(second).toBe(fixture.seed);
      expect(third).toBe(fixture.seed);
      expect(readFileSync(TARGET(), 'utf8')).toBe(fixture.seed);
    });

    it('播种失败（workspacePath 指向文件, 无法建目录）→ Err code seed-skill-failed', () => {
      const filePath = path.join(dir, 'not-a-dir');
      writeFileSync(filePath, 'occupied', 'utf8');

      const result = loadOrSeedSkill(filePath, fixture.name, fixture.seed);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('seed-skill-failed');
      }
    });
  });
}
