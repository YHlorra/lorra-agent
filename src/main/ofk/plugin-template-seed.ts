import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';

/**
 * 插件目录播种(step 2):~/.lorra/plugins/ 下的 README + 模板插件。
 * write-if-missing(用户已有插件/改过模板不覆写);main.ts 启动调用,
 * 失败静默(同 seedMemoryMaintenanceSkill 纪律)。
 */

const PLUGINS_DIR_RELATIVE = 'plugins';
const PLUGIN_TEMPLATE_NAME = '_template';

export function pluginsRoot(): string {
  return path.join(lorraConfigDir(), PLUGINS_DIR_RELATIVE);
}

export const PLUGINS_README = `# lorra 数据源插件

自定义数据源:把本机其他 AI 工具的会话记录接入 lorra 时间线与知识库。

## 目录结构

\`\`\`
~/.lorra/plugins/
  README.md
  collectors/
    <name>/            # 插件名: /^[A-Za-z0-9._-]{1,40}$/
      plugin.json      # { name, runtime, description, main: 'index.mjs' }
      index.mjs        # export async function collect()
\`\`\`

## 插件契约

\`index.mjs\` 必须 \`export async function collect()\`,返回 \`PluginFact[]\`
(纯 JSON 对象数组,无类实例)。PluginFact = SessionFact 去掉
factId/schemaVersion/collector/runtime/agentId 六个字段,其余字段由插件填齐:

| 字段 | 要求 |
|------|------|
| sessionRef | 来源会话唯一标识(如 \`claude-code-<文件名>\`;跨运行唯一即可,无格式要求) |
| scope | \`user\` / \`workspace\` / \`project\` / \`agent\` 之一 |
| summaryRef | null 或字符串 |
| privacy | \`public_safe\` / \`local_private\` / \`private_pointer\` 之一 |
| workspace | 会话所属项目路径(必填非空) |
| start / end | ISO 字符串(首末消息时间戳) |
| activeMs / tokens | 有限数字(未知填 0) |
| title | 会话标题(首条 user 文本截断 ≤60 字符) |
| model | 未知填空串 |
| tools | 字符串数组(可空) |
| unfinished / containsTodo | 布尔 |

加载方补全: schemaVersion / collector=<插件名> / runtime=<插件名> /
agentId=<插件名> / factId=内容哈希。非法字段的条目会被剔除并告警。

## 安全提示

插件是**本机执行的代码**,信任边界 = 你自己写的脚本;不要放入来源不明的
插件。collect 失败不会影响 lorra 主流程(fail-open)。
`;

const PLUGIN_TEMPLATE_PLUGIN_JSON = `{
  "name": "my-collector",
  "runtime": "my-runtime",
  "description": "我的自定义数据源",
  "main": "index.mjs"
}
`;

const PLUGIN_TEMPLATE_INDEX_MJS = `// 数据源插件模板(契约)
// collect 必须返回 PluginFact[](纯 JSON 对象数组):
//   Omit<SessionFact, 'factId'|'schemaVersion'|'collector'|'runtime'|'agentId'>
// 必需字段: sessionRef / scope / summaryRef / privacy / workspace /
//   start(ISO) / end(ISO) / activeMs / tokens / title / model / tools /
//   unfinished / containsTodo
// 未知值: activeMs/tokens=0, model='', tools=[], summaryRef=null,
//   privacy='public_safe', scope='workspace'

export async function collect() {
  // 示例:从你的工具会话目录读 jsonl,每会话合成一条 PluginFact。
  // const facts = [];
  // for (const file of listSessionFiles()) {
  //   facts.push({
  //     sessionRef: 'my-collector-' + fileStem(file),
  //     scope: 'workspace',
  //     summaryRef: null,
  //     privacy: 'public_safe',
  //     workspace: projectPathOf(file),
  //     start: firstEntryTimestamp(file).toISOString(),
  //     end: lastEntryTimestamp(file).toISOString(),
  //     activeMs: 0,
  //     tokens: 0,
  //     title: firstUserText(file),
  //     model: '',
  //     tools: [],
  //     unfinished: false,
  //     containsTodo: false,
  //   });
  // }
  // return facts;
  return [];
}
`;

/** 播种插件目录(README + 模板);write-if-missing,失败静默。 */
export function seedPluginTemplate(): void {
  try {
    const root = pluginsRoot();
    const templateDir = path.join(root, 'collectors', PLUGIN_TEMPLATE_NAME);
    const files: Array<[string, string]> = [
      [path.join(root, 'README.md'), PLUGINS_README],
      [path.join(templateDir, 'plugin.json'), PLUGIN_TEMPLATE_PLUGIN_JSON],
      [path.join(templateDir, 'index.mjs'), PLUGIN_TEMPLATE_INDEX_MJS],
    ];
    for (const [file, content] of files) {
      if (existsSync(file)) continue;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
  } catch {
    // 播种失败静默(不阻塞启动)
  }
}
