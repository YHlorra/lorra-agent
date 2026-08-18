import path from 'node:path';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';

/**
 * agent-plugins 根目录（plan S2）：~/.lorra/plugins/agent-plugins/<name>/。
 * 与 OFK 数据源采集器（~/.lorra/plugins/collectors/）平级但独立，避免同名冲突。
 * 测试注入走 LORRA_E2E_USERDATA（lorraConfigDir 单一事实源）。
 */
export function agentPluginsRoot(): string {
  return path.join(lorraConfigDir(), 'plugins', 'agent-plugins');
}

/** 跳过名单（隐藏目录/模板不加载）。 */
export const AGENT_PLUGIN_SKIP_NAMES = new Set(['_template']);
