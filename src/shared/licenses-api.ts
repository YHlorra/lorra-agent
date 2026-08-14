/**
 * 开源项目页契约(设置页「关于」组)。
 * 单一事实源:通道常量 + 数据类型同文件,main IPC / preload bridge / renderer
 * 声明三侧同源防漂移(对齐 skills-api 模式)。
 */

export const LICENSES_CHANNEL = 'lorra.app.licenses';

/** 单个开源项目条目(构建期由 scripts/generate-licenses.mjs 生成)。 */
export interface OpenSourceProject {
  name: string;
  version: string;
  license: string;
  homepage: string | null;
  repository: string | null;
}
