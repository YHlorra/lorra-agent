import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAndCheck } from '../../src/main/pi-sdk-driver/tool-safety/path-check';

describe('resolveAndCheck crash / edge cases', () => {
  it('non-existent path returns path-out-of-workspace (default-deny)', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'lorra-pc-'));
    const result = await resolveAndCheck(ws, path.join(ws, 'does-not-exist.md'));
    expect(result.ok).toBe(false);
  });

  it('symlink pointing outside workspace is rejected', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'lorra-pc-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'lorra-out-'));
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    const linkPath = path.join(ws, 'leak.md');
    try {
      await symlink(path.join(outside, 'secret.md'), linkPath);
    } catch {
      return;
    }
    const result = await resolveAndCheck(ws, linkPath);
    expect(result.ok).toBe(false);
  });

  it('relative path is resolved against workspace', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'lorra-pc-'));
    await writeFile(path.join(ws, 'inside.md'), 'inside');
    const result = await resolveAndCheck(ws, './inside.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.realpath.endsWith('inside.md')).toBe(true);
  });
});
