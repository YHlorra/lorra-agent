import { createClaudeCodeCollector } from './claude-code';
import type { BuiltinCollector } from './collector-core';
import { createOhMyPiCollector } from './oh-my-pi';
import { createOpencodeCollector } from './opencode';
import { createWorkbuddyCollector } from './workbuddy';

/**
 * 内置数据源汇总(step 4):设置开关(dataSources)按 runtime 名
 * 启用/停用;pi 恒开不在此列。
 */

export type DataSourceRuntime = 'claudeCode' | 'opencode' | 'ohMyPi' | 'workbuddy';

export const BUILTIN_DATA_SOURCES: ReadonlyArray<{
  runtime: DataSourceRuntime;
  collector: BuiltinCollector;
}> = [
  { runtime: 'claudeCode', collector: createClaudeCodeCollector() },
  { runtime: 'opencode', collector: createOpencodeCollector() },
  { runtime: 'ohMyPi', collector: createOhMyPiCollector() },
  { runtime: 'workbuddy', collector: createWorkbuddyCollector() },
];

/** 按设置开关取启用的内置适配器。 */
export function createBuiltinCollectors(dataSources: {
  claudeCode?: boolean;
  opencode?: boolean;
  ohMyPi?: boolean;
  workbuddy?: boolean;
}): BuiltinCollector[] {
  return BUILTIN_DATA_SOURCES.filter(({ runtime }) => dataSources[runtime] === true).map(
    ({ collector }) => collector,
  );
}
