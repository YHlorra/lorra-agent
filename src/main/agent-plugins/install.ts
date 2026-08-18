import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shell } from 'electron';
import type { CreateAgentPluginResult, InstallAgentPluginResult } from '../../shared/plugins-api';
import { AGENT_PLUGINS_SCHEMA_V1_0_0 } from '../../shared/plugins-api';
import type { Result } from '../../shared/result';
import { err, ok, toLorraError } from '../../shared/result';
import { readAgentPluginManifest } from './manifest';

/**
 * agent-plugins 导入/脚手架（plan S4）。
 * 导入：本地文件夹 / 手工目录路径（校验 plugin.json 合法后复制到插件根）。
 * 失败回滚走 shell.trashItem（FM-8 红线：实体删除禁 rmSync/unlinkSync）。
 */

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

export interface InstallAgentPluginDeps {
  root: string;
}

export async function installAgentPluginFromFolder(
  source: string,
  deps: InstallAgentPluginDeps,
): Promise<Result<InstallAgentPluginResult>> {
  const src = path.resolve(source);
  if (!existsSync(path.join(src, 'plugin.json'))) {
    return err({ code: 'not-a-plugin', message: '该目录不是 agent-plugin（缺少 plugin.json）' });
  }
  const manifest = await readAgentPluginManifest(src);
  if (manifest.isErr()) {
    return err({
      code: 'not-a-plugin',
      message: 'plugin.json 校验失败：' + manifest.error.message,
    });
  }
  const target = path.join(deps.root, manifest.value.name);
  if (existsSync(target)) {
    return err({ code: 'plugin-exists', message: '同名插件已存在' });
  }
  try {
    await mkdir(deps.root, { recursive: true });
    await copyDir(src, target);
  } catch (cause) {
    // 复制失败回滚：部分产物走回收站（FM-8 红线，禁 rmSync）。
    await shell.trashItem(target).catch(() => {});
    return err(toLorraError(cause, 'agent-plugin-install-failed'));
  }
  return ok({ name: manifest.value.name, path: target, skillCount: 0, mcpCount: 0 });
}

export async function createAgentPluginScaffold(
  name: string,
  deps: InstallAgentPluginDeps,
): Promise<Result<CreateAgentPluginResult>> {
  const target = path.join(deps.root, name);
  if (existsSync(target)) return err({ code: 'plugin-exists', message: '同名插件已存在' });
  try {
    await mkdir(path.join(target, 'skills', name), { recursive: true });
    const pluginJson = JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_V1_0_0, name }, null, 2);
    await writeFile(path.join(target, 'plugin.json'), pluginJson + '\n', 'utf8');
    const skillMd =
      '---\nname: ' +
      name +
      '\ndescription: ' +
      name +
      ' 插件技能\n---\n\n描述该技能做什么、何时用。\n';
    await writeFile(path.join(target, 'skills', name, 'SKILL.md'), skillMd, 'utf8');
    await writeFile(
      path.join(target, 'mcp.json'),
      '{\n  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",\n  "mcpServers": {}\n}\n',
      'utf8',
    );
  } catch (cause) {
    return err(toLorraError(cause, 'agent-plugin-create-failed'));
  }
  return ok({ name, path: target });
}
