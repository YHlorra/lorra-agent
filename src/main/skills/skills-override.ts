import path from 'node:path';

/**
 * /D6 共享技能剔除合并(勘误 4:统一走 lorra AppSettings + skillsOverride,
 * 不采用 SDK settings.json 技能数组第二套真相源)。
 *
 * 返回 skillsOverride 最终剔除清单,条目语义二义归一:
 * - 技能名:精确匹配 skill.name(daily-review/deep-review 复盘种子经
 * existingExclusions 传入、disabledSkills、workspaceSkillOverrides[wsPath]);
 * - 前斜杠路径前缀:边界匹配 skill.filePath(<wsRealpath>/.pi 项目技能源,由 wsPath 派生)。
 * 消费方对每条 entry 做 `name === entry || filePath === entry ||
 * filePath.startsWith(entry + '/')` 判定(路径前缀带分隔符边界,不误伤
 * `.pi` 段工作区路径)。
 *
 * wsPath 应为工作区 realpath:.pi 前缀派生与 workspaceSkillOverrides 键查找都
 * 依赖真实路径(overrides 以 realpath 为键写入)。
 * 去重(Set)+ 保序:输出顺序 = .pi 前缀 → existingExclusions → disabledSkills
 * → workspaceSkillOverrides[wsPath]。
 *
 * 2026-08-13(技能收集批):workspaceSkillOverrides 升级为「按工作区停用名单」,
 * **恒合并**(移除 workspaceOptInSkills 模式 gate——newmax 式行内开关的数据层)。
 */
export interface BuildSkillsOverrideInput {
  /** 工作区 realpath。 */
  wsPath: string;
  /** 全局隐藏名单(AppSettings.disabledSkills,软禁用:只从提示清单剔除,不防读)。 */
  disabledSkills: string[];
  /** 按工作区停用名单(AppSettings.workspaceSkillOverrides,key = 工作区 realpath,恒合并)。 */
  workspaceSkillOverrides: Record<string, string[]>;
  /** 既有剔除名单(复盘种子等,调用方按自己的源集传入;缺省空)。 */
  existingExclusions?: string[];
}

export function buildSkillsOverride(input: BuildSkillsOverrideInput): string[] {
  const { wsPath, disabledSkills, workspaceSkillOverrides, existingExclusions = [] } = input;
  const merged = [
    // 项目技能统一 .lorra 单源:排除 SDK 默认 <ws>/.pi 技能源(前缀锚定,
    // 边界由消费方 `entry + '/'` 判定保证,不误伤用户路径含 .pi 段的工作区)。
    path.join(wsPath, '.pi').replace(/\\/g, '/'),
    ...existingExclusions,
    ...disabledSkills,
    // 按工作区停用(升级):workspaceSkillOverrides 恒合并(无 opt-in gate)。
    ...(workspaceSkillOverrides[wsPath] ?? []),
  ];
  return [...new Set(merged)];
}
