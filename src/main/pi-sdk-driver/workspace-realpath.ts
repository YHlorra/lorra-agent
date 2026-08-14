import { realpath } from 'node:fs/promises';

export async function readWorkspaceRealpath(p: string): Promise<string> {
  return await realpath(p);
}
