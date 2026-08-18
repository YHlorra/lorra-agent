import type { Result } from '../../shared/result';
import { loadOrSeedSkill } from '../memory/review-generator';

/**
 * lorra 元技能(lorra-meta-skill)播种 —— 吸收 qiaomu(meta-skill) 的「工作流→技能」生成管线、
 * hermes 的「用真实会话回放自我进化技能」loop;发布鉴权只走 gh CLI(技能自身不负责登录)。
 *
 * 走 review-generator.loadOrSeedSkill 通用入口;应用启动/工作区激活时播种到
 * <workspace>/.lorra/skills/lorra-meta-skill.md —— 缺失才写内置原文, 存在原样用(用户可改即时生效)。
 * 该 .md 被 SDK 当技能发现(additionalSkillPaths), 可经 `/skill lorra-meta-skill` 显式调用,
 * 与复盘种子(生成链路内读取、按名剔除)定位不同, 刻意保留为可发现。
 * 播种失败返回 Err(code seed-skill-failed,2026-08-17 收敛);调用方应静默忽略, 不阻塞工作区激活。
 *
 * 品牌卫生: 本技能不在正文硬编码任何作者名/标语/赞赏链接/博客链接; 发布时从
 * 本技能自身文件夹的 meta.yaml 真源读取,拷贝到被发布的目标技能文件夹;缺字段省略区块。
 * 本地使用不强求 meta.yaml。
 */

/** 内置原文: 目标缺失时原样写入（不得改写）。 */
export const LORRA_META_SKILL_SEED = `---
name: lorra-meta-skill
description: 把工作流/想法/脚本/SOP 收敛成可复用、可验证、可发布的 SKILL，并可用会话记录自我进化技能文本；发布到 GitHub 时从本技能 meta.yaml（标语/作者/主页/赞赏）拷到目标技能，本地使用不强求。
---

# lorra 元技能（lorra-meta-skill）

## 定位（系统内，不是通用内容）

本 skill 是 lorra 的第一方「造技能」指南：把一句话流程、SOP、聊天记录、旧 skill、
脚本或一个模糊想法，变成**可被发现、可稳定触发、可通过校验、可发布到 GitHub** 的 SKILL。
产出落在 \`.lorra/skills/\` 生态（用户可改、改即时生效），不是与 lorra 无关的通用知识库搭建指南。

本技能自身文件夹下的 \`meta.yaml\` 是发布品牌的**唯一真源**（用户首次配置时落一次，终身复用）。
发布时把这份 \`meta.yaml\` 拷贝到目标技能文件夹，让发布后的 GitHub 仓库自包含；本地使用
完全不依赖它——不创建、不读取、不要求。

## 一、生成一个新技能（create）

1. **需求收敛**：一次问清「输入 → 期望触发行为 → 边界 → 产出」，不反复追问。
2. **同类检索**：先查已装载技能（\`~/.agents/skills\` 收集根、\`.lorra/skills\`）是否有等价物——
   有则直接指路，避免重复造一个更差的轮子。
3. **设计**：产出 \`<name>/SKILL.md\`。name 用小写 a-z0-9 连字符；\`description\` ≤1024
   且不宽不窄（太宽会到处误触发、太窄永远叫不出来）。
4. **触发评测**：写 \`trigger_cases.json\`，列「应触发 / 不应触发」样例各若干条。
5. **格式校验**：确保有合法 frontmatter（\`name\` + \`description\`），否则 SDK 拒载该技能。
6. **本地验证**：放进技能目录试跑。**本地使用到此为止，不强求 meta.yaml。**
7. **（可选）准备发布**：把本技能自身的 \`meta.yaml\` 拷过去，渲染 README，再用 \`gh\` 推。

## 二、品牌 yaml（schema，位于本技能自身文件夹，全局唯一真源）

**位置**：\`<ws>/.lorra/skills/lorra-meta-skill/meta.yaml\`（与本 SKILL.md 同目录，全局唯一一份）。

\`\`\`yaml
branding:
  slogan: ''   # readme 顶部标语
  author: ''   # 作者名/署名
  homepage: '' # 博客/主页链接
  donate: ''   # 赞赏/赞助链接
\`\`\`

- **真源 = 本技能文件夹下这一份**：用户首次配置时问四个字段并落盘，所有技能共用同一份配置；
  改一次终身生效（下次发布任何技能都自动应用）。
- **发布时拷过去**：目标技能文件夹 \`<target>/meta.yaml\` 由本 SKILL 在 publish 时拷贝而来，
  让发布后的 GitHub 仓库**自包含**——clone 下来的人无需依赖 \`lorra-meta-skill\` 路径也能看到作者/主页/赞赏。
- **规则**：字段有值 → 填入 README；缺省 → 省略对应区块（全空也能发，只带技能名 + 描述）。
- **本地使用**：忽略、不创建、不读取。
- **红线**：绝不把示例里的 lorra/任何固定作者名、链接、标语写死进生成的技能或 README。

## 三、发布到 GitHub（可选，文档级 + gh CLI）

1. **鉴权（本技能不负责）**：依次 \`gh --version\`、\`gh auth status\`。
   未安装或未登录 → 不代用户输入任何令牌，直接引导用户交互 \`gh auth login\`，完成后继续。
2. **步骤**（每个待发布目标技能走一遍）：
   1. 拷贝 \`<ws>/.lorra/skills/lorra-meta-skill/meta.yaml\` → \`<target>/meta.yaml\`
      （让发布产物自包含；目标技能已有 \`meta.yaml\` 时提示用户「保留本地版本还是覆盖」）。
   2. 从 \`<target>/meta.yaml\` 读品牌，按缺失省略 README 对应区块，渲染 \`<target>/README.md\`。
   3. \`cd <target>\` → \`git init\` → \`git add\` → \`git commit\` →
      \`gh repo create <owner>/<name> --public --source . --push\` → 推送 →
      可 \`gh release create vX.Y.Z\`。
3. **发布前三查**：⚠️ meta.yaml 已拷到目标技能文件夹且字段已填 → README 无遗留占位 →
   无密钥泄露（token/.env 不入库）。

## 四、自我进化（evolve，用真实会话回放）

- **素材**：解析 \`~/.lorra/sessions/\` 下的已有 JSONL（零新增埋点），抽取触发过/错过
  该技能的真实会话与工具调用。
- **步骤**：抽 trace → 反推「为何触发/未触发、哪里不贴合用户预期」→ 生成候选
  SKILL.md 修订 → 用 \`trigger_cases.json\` 回归确认不劣化 → 护栏（正文 ≤15KB、保留原意、
  不中途改会话行为）→ 采纳最佳变体并落盘。
- 无该技能触发记录 → **静默跳过，不报错**。

## 护栏（优先级最高）

- name/description 满足 SDK 规则（小写 a-z0-9 连字符 / ≤1024）；
- 技能正文 ≤15KB，保留原意，进化不劣化已通过的触发案例；
- 发布前过「品牌 yaml（从本技能拷过去）→ README → 密钥泄露」三查；
- 全程无品牌硬编码；本技能文件夹的 \`meta.yaml\` 是发布品牌**唯一真源**，本地使用不依赖它。
`;

/** 播种 + 读取:目标缺失 → 写入内置原文;存在 → 原样使用。幂等,可重复调用。 */
export function seedLorraMetaSkill(workspacePath: string): Result<string> {
  return loadOrSeedSkill(workspacePath, 'lorra-meta-skill', LORRA_META_SKILL_SEED);
}
