import { realpathSync } from 'node:fs';
import { ipcMain } from 'electron';
import type { Result, SerializedResult } from '../../shared/result';
import { err, ok, toSerialized } from '../../shared/result';
import {
  type CollectResult,
  SKILLS_IPC,
  type SkillGitStatus,
  type SkillReadResult,
  type SkillXray,
} from '../../shared/skills-api';
import {
  checkUpdates,
  cleanDangling,
  collectSkills,
  getSkillXray,
  readSkillContent,
  resolveWorkspacePath,
  setSkillEnabled,
  setWorkspaceEnabled,
  updateAll,
} from '../skills/skill-manager';
import { readSettings } from '../workspace/settings';

/**
 * 技能管理 IPC（V1-8 + 2026-08-13 批 D9 + 2026-08-14 /skill 触发）：
 * xray / setEnabled / cleanDangling / collect / checkUpdates / updateAll /
 * setWsEnabled / read 八通道,通道名取 SKILLS_IPC 单一事实源(install 已迁移为
 * 会话内 install_skill 智能体工具,不再有前端安装通道)。
 *
 * - 信封:全部 SerializedResult({status:'ok',value} / {status:'error',error}),
 * 经 shared/result toSerialized 收口,不手写 try/catch(manager 全链 Result)。
 * - 参数校验(D9):
 * - xray:wsPath 可选(缺省回退当前工作区,manager resolveWorkspacePath 同口径)。
 * - setEnabled:name = 非空字符串;enabled = boolean(否则 invalid-enabled「启用状态无效」);
 * name ∈ 发现集合与系统种子拒绝在 manager 侧。
 * - setWsEnabled:name = 非空字符串;enabled = boolean;wsPath 可选(同 optionalWsPathArg)。
 * - install:gitUrl = 非空字符串(否则 invalid-git-url「请输入有效的 https 仓库地址」);
 * URL 合法性校验在 skills-git(https 协议 + host + 目录名)。
 * - collect:wsPath 可选(同 optionalWsPathArg)。
 * - checkUpdates / updateAll:无参。
 * - cleanDangling:wsPath 必填,realpath ∈ realpath(recentWorkspaces) 成员校验。
 * - 错误文案全部 PM 语域,code 留给日志。
 */
export function registerSkillsIpc(): void {
  ipcMain.handle(
    SKILLS_IPC.xray,
    async (_event, args?: { wsPath?: unknown }): Promise<SerializedResult<SkillXray>> => {
      const wsArg = await optionalWsPathArg(args);
      if (wsArg.isErr()) return toSerialized(err(wsArg.error));
      return toSerialized(await getSkillXray(wsArg.value));
    },
  );

  ipcMain.handle(
    SKILLS_IPC.setEnabled,
    async (
      _event,
      args?: { name?: unknown; enabled?: unknown },
    ): Promise<SerializedResult<void>> => {
      if (typeof args?.name !== 'string' || args.name.trim() === '') {
        return toSerialized(err({ code: 'invalid-skill-name', message: '技能名称无效' }));
      }
      if (typeof args?.enabled !== 'boolean') {
        return toSerialized(err({ code: 'invalid-enabled', message: '启用状态无效' }));
      }
      return toSerialized(await setSkillEnabled(args.name, args.enabled));
    },
  );

  ipcMain.handle(
    SKILLS_IPC.setWsEnabled,
    async (
      _event,
      args?: { name?: unknown; enabled?: unknown; wsPath?: unknown },
    ): Promise<SerializedResult<void>> => {
      if (typeof args?.name !== 'string' || args.name.trim() === '') {
        return toSerialized(err({ code: 'invalid-skill-name', message: '技能名称无效' }));
      }
      if (typeof args?.enabled !== 'boolean') {
        return toSerialized(err({ code: 'invalid-enabled', message: '启用状态无效' }));
      }
      const wsArg = await optionalWsPathArg(args);
      if (wsArg.isErr()) return toSerialized(err(wsArg.error));
      return toSerialized(await setWorkspaceEnabled(args.name, args.enabled, wsArg.value));
    },
  );

  ipcMain.handle(
    SKILLS_IPC.collect,
    async (_event, args?: { wsPath?: unknown }): Promise<SerializedResult<CollectResult>> => {
      const wsArg = await optionalWsPathArg(args);
      if (wsArg.isErr()) return toSerialized(err(wsArg.error));
      return toSerialized(await collectSkills(wsArg.value));
    },
  );

  ipcMain.handle(
    SKILLS_IPC.checkUpdates,
    async (): Promise<SerializedResult<Record<string, SkillGitStatus>>> => {
      return toSerialized(await checkUpdates());
    },
  );

  ipcMain.handle(
    SKILLS_IPC.updateAll,
    async (): Promise<SerializedResult<{ updated: string[]; skipped: string[] }>> => {
      return toSerialized(await updateAll());
    },
  );

  ipcMain.handle(
    SKILLS_IPC.cleanDangling,
    async (_event, args?: { wsPath?: unknown }): Promise<SerializedResult<{ cleaned: number }>> => {
      if (typeof args?.wsPath !== 'string' || args.wsPath.trim() === '') {
        return toSerialized(err({ code: 'invalid-workspace-path', message: '工作区路径无效' }));
      }
      const wsRes = await resolveWorkspacePath(args.wsPath);
      if (wsRes.isErr()) return toSerialized(err(wsRes.error));
      // D9 成员校验:wsPath ∈ realpath(recentWorkspaces)。settings.json 可篡改,
      // realpath 二次校验;stale 条目 realpath 失败不判为已知工作区。
      const known = await knownWorkspaceRealpaths();
      if (!known.has(wsRes.value)) {
        return toSerialized(err({ code: 'unknown-workspace', message: '未知工作区' }));
      }
      return toSerialized(await cleanDangling(wsRes.value));
    },
  );

  ipcMain.handle(
    SKILLS_IPC.read,
    async (_event, args?: { name?: unknown }): Promise<SerializedResult<SkillReadResult>> => {
      if (typeof args?.name !== 'string' || args.name.trim() === '') {
        return toSerialized(err({ code: 'invalid-skill-name', message: '技能名称无效' }));
      }
      return toSerialized(await readSkillContent(args.name.trim()));
    },
  );
}

/** xray/collect/setWsEnabled 的可选 wsPath 类型守卫:缺省 → undefined(manager 回退当前工作区)。 */
async function optionalWsPathArg(args?: { wsPath?: unknown }): Promise<Result<string | undefined>> {
  if (args === undefined || args.wsPath === undefined) return ok(undefined);
  if (typeof args.wsPath !== 'string' || args.wsPath.trim() === '') {
    return err({ code: 'invalid-workspace-path', message: '工作区路径无效' });
  }
  return ok(args.wsPath);
}

/** recentWorkspaces 的 realpath 集合(存在性 best-effort,stale 条目剔除)。 */
async function knownWorkspaceRealpaths(): Promise<Set<string>> {
  const settings = await readSettings();
  const known = new Set<string>();
  for (const p of settings.recentWorkspaces) {
    try {
      known.add(realpathSync(p));
    } catch {
      // stale 条目:不可 realpath → 不判为已知工作区。
    }
  }
  return known;
}
