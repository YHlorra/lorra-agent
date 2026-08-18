import type { SessionFact } from '../../../shared/facts-schema';
import type { LorraError, Result } from '../../../shared/result';

/**
 * Collector 插件接口(spec Collector 插件接口):
 * 收集清洗层支持注册多个 collector,每个负责一种来源的原始记录清洗。
 * 任一 collector 失败 MUST NOT 阻塞其他 collector(fail-open),
 * 且不得进入会话交互热路径。
 *
 * collect 的 ok 值携带 { facts, errors }:
 * - facts:清洗成功的事实
 * - errors:逐文件非致命错误(损坏行/缺头等)的 LorraError 列表,不中断其余文件
 * (spec「损坏文件退化」要求记录 LorraError)
 * err 仅用于 collector 整体性失败(目录不可读等)。
 */

/** collect 的产出:清洗成功的事实 + 本次跳过/失败记录的非致命错误。 */
export interface CollectorOutput {
  facts: SessionFact[];
  errors: LorraError[];
}

export interface Collector {
  readonly name: string;
  collect(): Promise<Result<CollectorOutput>>;
}
