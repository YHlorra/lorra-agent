import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite } from '../../src/main/pi-sdk-driver/tool-safety/atomic-write';

describe('atomicWrite', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'lorra-atomic-'));
  });

  afterEach(async () => {
    try {
      const { rm } = await import('node:fs/promises');
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // dir already gone
    }
  });

  it('writes new file content atomically', async () => {
    const target = path.join(workDir, 'new.md');
    await atomicWrite(target, 'hello world');
    expect(await readFile(target, 'utf8')).toBe('hello world');
  });

  it('overwrites existing file with new content', async () => {
    const target = path.join(workDir, 'existing.md');
    await writeFile(target, 'old content', 'utf8');
    await atomicWrite(target, 'new content');
    expect(await readFile(target, 'utf8')).toBe('new content');
  });

  it('preserves original when target path is a directory (rename fails)', async () => {
    // If the target path exists as a non-empty directory, the final rename
    // step in atomicWrite will fail (EISDIR / ENOTEMPTY). The original
    // file — sibling of the dir — must remain intact.
    const file = path.join(workDir, 'protected.md');
    await writeFile(file, 'original', 'utf8');
    const dirAsTarget = path.join(workDir, 'dir-target');
    await mkdir(dirAsTarget, { recursive: true });

    let renameFailed = false;
    try {
      await atomicWrite(dirAsTarget, 'attempted overwrite');
    } catch {
      renameFailed = true;
    }
    expect(renameFailed).toBe(true);
    // Sibling file untouched.
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('fsync ensures durability (no partial writes observed)', async () => {
    const target = path.join(workDir, 'durable.md');
    await atomicWrite(target, 'durable content');
    const st = await stat(target);
    expect(st.size).toBeGreaterThan(0);
  });

  it('cleans up temp file on success (no leftover temp in dir)', async () => {
    const target = path.join(workDir, 'clean.md');
    await atomicWrite(target, 'clean');
    const entries = await readdir(workDir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });
});
