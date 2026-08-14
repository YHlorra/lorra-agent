import os from 'node:os';
import path from 'node:path';
import { type BuiltinCollector, createJsonlCollector } from './collector-core';

/**
 * Oh My Pi 数据源:扫描 Oh My Pi 产品自身会话目录
 * `~/.omp/agent/sessions/`(2026-08-13 实证:该目录含 91 个顶层会话 jsonl;
 * 目录结构与 pi-sdk 同款 `<ws-slug>/<timestamp>_<uuid>.jsonl`)。
 * 目录区分:`.omp` = Oh My Pi 产品(本数据源);`.omc` = oh-my-claudecode
 * (Claude Code 编排层,非本源——原实现误用 .omc 导致开关开启后时间线无会话);
 * `~/.lorra/sessions` = lorra 自身会话(pi 恒开链路已收集,不在此列)。
 * 只收集顶层会话文件(maxDepth=2):嵌套任务子转录(T*.jsonl,真实目录 114 个)
 * 是父会话的子转录,排除以免时间线碎片化。
 * workspace 取会话头 cwd(真实路径,collector-core 内实现:entries 中
 * type:'session' 且带非空 cwd 的行优先;workspaceOf 仅作无头格式的回退,
 * 如 claude-code)。目录/格式不存在 → Ok([]) fail-open。
 */

export const OH_MY_PI_RUNTIME = 'oh-my-pi';

export function createOhMyPiCollector(): BuiltinCollector {
  return createJsonlCollector({
    name: OH_MY_PI_RUNTIME,
    runtimePrefix: 'oh-my-pi',
    root: () => path.join(os.homedir(), '.omp', 'agent', 'sessions'),
    workspaceOf: (file) => path.basename(path.dirname(file)),
    // 只取 <root>/<ws-slug>/*.jsonl;更深层是嵌套任务子转录,排除
    maxDepth: 2,
  });
}
