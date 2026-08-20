---
name: find-skills
description: 帮用户发现并安装 agent 技能。当用户问「怎么做 X」「帮我找一个 X 相关的技能」「有没有 X 的技能」「你能做 X 吗」等表示想扩展能力、找工具/模板/工作流时使用；不适用于纯写代码、纯总结文档等普通问答。
---

# Find Skills - 发现与安装技能

本技能帮你从开放 agent 技能生态中发现并安装技能。

## 何时用

当用户：

- 问「怎么做 X」，而 X 可能是已有技能覆盖的常见任务
- 说「帮我找一个 X 相关的技能」「有没有 X 的技能」
- 说「你能做 X 吗」，其中 X 是某项专门能力
- 表示想扩展 agent 能力、找工具/模板/工作流
- 提到想在某领域（设计、测试、部署等）获得帮助

## 什么是 Skills CLI

`npx skills` 是开放 agent 技能生态的包管理器。技能是模块化的包，用专门知识、工作流和工具扩展 agent 能力。

**核心命令：**

- `npx skills find [query] [--owner <owner>]` - 按关键词搜索技能，可限定 GitHub owner
- `npx skills add <package>` - 从 GitHub 或其他来源安装技能
- `npx skills check` - 检查技能更新
- `npx skills update` - 更新所有已安装技能

**浏览技能：** https://skills.sh/

## 帮用户找技能的流程

### 第 1 步：弄清需求

先识别三件事：

1. 领域（如 React、测试、设计、部署）
2. 具体任务（如写测试、做动画、审 PR）
3. 是否足够常见、大概率已有对应技能

### 第 2 步：先看排行榜

搜索前先查 [skills.sh 排行榜](https://skills.sh/)，看该领域是否已有知名技能。排行榜按总安装量排序，优先呈现最流行、久经考验的选项。

例如 Web 开发的知名技能常来自：

- `vercel-labs/agent-skills` — React、Next.js、Web 设计（各 10 万+ 安装）
- `anthropics/skills` — 前端设计、文档处理（10 万+ 安装）

### 第 3 步：搜索技能

排行榜覆盖不到时，运行 find 命令：

```bash
npx skills find [query] [--owner <owner>]
```

示例：

- 用户问「怎么让 React 应用更快？」→ `npx skills find react performance`
- 用户问「能帮我审 PR 吗？」→ `npx skills find pr review`
- 用户说「我要生成 changelog」→ `npx skills find changelog`

### 第 4 步：推荐前先核验质量

**不要仅凭搜索结果就推荐。** 至少核验：

1. **安装量** — 优先 1K+ 安装的技能；100 以下谨慎对待。
2. **来源声誉** — 官方来源（`vercel-labs`、`anthropics`、`microsoft`）比匿名作者更可信。
3. **GitHub stars** — 查看源仓库；来自 <100 star 仓库的技能需谨慎。

### 第 5 步：向用户展示选项

找到相关技能后，向用户展示：

1. 技能名和它能做什么
2. 安装量与来源
3. 可直接运行的安装命令
4. 前往 skills.sh 进一步了解的链接

示例回复：

```
我找到一个可能帮到你的技能！"react-best-practices" 提供了
来自 Vercel Engineering 的 React 和 Next.js 性能优化指南。
(185K 安装)

安装命令：
npx skills add vercel-labs/agent-skills@react-best-practices

了解更多：https://skills.sh/vercel-labs/agent-skills/react-best-practices
```

### 第 6 步：主动提出安装

用户想继续时，可代为安装：

```bash
npx skills add <owner/repo@skill> -g -y
```

`-g` 表示全局（用户级）安装，`-y` 跳过确认提示。

## 常见技能类别

搜索时参考这些常见类别：

| 类别     | 示例查询                                 |
| -------- | ---------------------------------------- |
| Web 开发 | react, nextjs, typescript, css, tailwind |
| 测试     | testing, jest, playwright, e2e           |
| DevOps   | deploy, docker, kubernetes, ci-cd        |
| 文档     | docs, readme, changelog, api-docs        |
| 代码质量 | review, lint, refactor, best-practices   |
| 设计     | ui, ux, design-system, accessibility     |
| 生产力   | workflow, automation, git                |

## 高效搜索技巧

1. **用具体关键词**：「react testing」比「testing」更好
2. **试替代词**：「deploy」没结果时，试「deployment」或「ci-cd」
3. **查热门来源**：很多技能来自 `vercel-labs/agent-skills` 或 `ComposioHQ/awesome-claude-skills`

## 找不到技能时

没有相关技能时：

1. 说明没找到现有技能
2. 主动提出用通用能力直接帮用户完成
3. 建议用户用 `npx skills init` 自建技能

示例：

```
我搜了「xyz」相关技能，没找到匹配项。
不过我可以直接用通用能力帮你完成，需要我继续吗？

如果这是你经常做的事，可以自建技能：
npx skills init my-xyz-skill
```

---

Copyright (c) 2026 lorra · https://github.com/YHlorra/lorra-agent