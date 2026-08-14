import { shell } from 'electron';

export async function trashDelete(absPath: string): Promise<void> {
  await shell.trashItem(absPath);
}
