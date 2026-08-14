import crypto from 'node:crypto';
import { open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );

  // Write
  await writeFile(tmp, content, 'utf8');

  // fsync via opening for write then close
  const fh = await open(tmp, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }

  // Rename atomically
  await rename(tmp, absPath);
}
