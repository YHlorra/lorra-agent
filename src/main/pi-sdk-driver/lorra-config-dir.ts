import os from 'node:os';
import path from 'node:path';

// 单一来源：模型配置目录（~/.lorra）。ModelConfigAdapter.create 与
// session-persistence 建会话的 agentDir 都用它，保证「配置页设的默认模型」与
// 「新会话读默认」同源（design D13）。e2e 时 LORRA_E2E_USERDATA 设了则落到隔离
// 目录，不碰真实 ~/.lorra；用 || 使空串也回退 homedir。
export function lorraConfigDir(): string {
  return path.join(process.env.LORRA_E2E_USERDATA || os.homedir(), '.lorra');
}
