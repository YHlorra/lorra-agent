<a id="readme-top"></a>

**[English](README.md) | [中文](README.zh-CN.md)**

<h1 align="center">lorra</h1>

<p align="center">面向深度工作的 Windows 桌面 AI Agent 工作台。</p>

<p align="center">
 [![License: MIT][license-shield]](LICENSE)
 [![Version][version-shield]](https://github.com/YHlorra/lorra-agent/releases)
 [![Stars][stars-shield]](https://github.com/YHlorra/lorra-agent/stargazers)
 [![Issues][issues-shield]](https://github.com/YHlorra/lorra-agent/issues)
</p>

lorra 是一个 Windows 优先的 Electron 工作台，把
[pi agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
封装进三栏编辑器：你在文件编辑和 AI Agent 协作之间并排工作。每一次有副作用的
AI 动作——写文件、安装技能、调用 MCP——都会停在权限卡前等你裁决。会话沉淀为
本地 Markdown 知识层，喂给每日时间线与自动生成的复盘。

<!-- TODO: 添加主截图（docs/demo.png，width="720"）。建议截三栏工作台 + 审批卡弹出状态。 -->

## 快速上手

安装时无需任何 API key——首次启动后在设置中连接模型供应商即可。

环境要求：**Windows**（Windows 优先）、**Node.js >= 22.19**、**npm**
（仓库使用 `package-lock.json` v3，不支持其他包管理器）。

```sh
npm install
npm start
```

**验证可用：** 工作台窗口以三栏布局打开。新建或选择一个工作区，在
**设置 → 模型** 中连接供应商，然后在聊天窗格发一条消息——Agent 会回复，
它尝试的任何文件写入都会挂起等待你的审批。

> [!NOTE]
> 项目处于活跃开发期。`npm run package` 可产出 Squirrel 安装包；
> 目前还没有正式发布的安装包。

## 核心能力

| 能力 | 作用 |
|---|---|
| **三栏工作台** | 可折叠图标栏、会话历史 + 文件树、Markdown/PDF/EPUB 阅读器（支持块级就地编辑 Markdown），以及被动式多轮 Agent 聊天窗格。 |
| **分级审批门** | 文件写入、编辑、技能安装与 MCP 调用会挂起，直到你选择**允许一次 / 总是允许 / 拒绝**；会话内注册表对相同工具 + 目标跳过重复询问。 |
| **今日页** | 24 小时 Agent 活动时间线——标签着色的非重叠甘特块、带增量 LLM 摘要的语义分段、标签过滤、日历导航与 KPI 卡片。 |
| **复盘引擎** | 方法论文件（`daily-review.md` / `deep-review.md`）驱动模型生成日/周复盘，归档为可读 Markdown。 |
| **OFK 知识层** | 会话沉淀为可读 Markdown 概念文档；每日摘要由此编译；时间线与复盘直接读取文档层。 |
| **技能管理** | 五来源技能发现、按工作区启用/禁用、采集与基于 Git 的安装/更新，全部集中在一页。 |
| **模型供应商与联网搜索** | 通过 UI 连接任意供应商——凭据存在 SDK 认证存储中，绝不硬编码——Agent 可把联网搜索作为一等工具使用。 |
| **设置与国际化** | 统一设置页（外观、工作区、数据源、标签、关于），中英文即时切换。 |

## 架构总览

- **Electron 主进程**承载 pi Agent 驱动——会话注册表、事件映射、编辑历史，以及拦截每一次工具调用的安全拦截器。
- **渲染进程**是工作台：三栏布局、审批模态、今日页、复盘侧栏、技能页与设置，通过类型化 IPC 与主进程相连。
- **OFK 文档层**把会话 JSONL 经内置收集器（Claude Code、OpenCode、WorkBuddy、Oh My Pi）与数据源插件转换为可读 Markdown 概念文档；今日页与复盘引擎读取它。
- **记忆层**从会话中抽取工作记忆、记录你要求记住的内容，并把召回上下文注入回 Agent。

## 安全

**Agent 绝不会自行改动你的文件。** 每一次有副作用的工具调用——写入、编辑、
技能安装、MCP 工具、工作区外读取——都会先被默认拒绝的拦截器挂起，直到你批准。
审批为三态（允许一次 / 本次会话总是允许 / 拒绝），且精确限定到工具 + 目标；
读写执行前会先做工作区根目录包含性检查。每次获批的编辑前都会记录文件原内容，
保证变更可追溯。供应商凭据存放在 SDK 认证存储中，绝不进配置文件或代码。

> [!CAUTION]
> 请保护你的模型供应商密钥——lorra 仅本地保存、绝不上传。报告安全漏洞请
> 开 GitHub issue 并加 `security` 标签，或直接联系维护者。

## 适用场景

**适合：**
- ✅ Windows 上带人工介入的单人深度工作
- ✅ 与编码 Agent 在真实文件上协作，每个动作都要审批
- ✅ 把会话沉淀为可检索的 Markdown 知识库
- ✅ 基于自己的 Agent 活动生成日/周复盘

**不适合：**
- ❌ 多用户团队或共享工作区（设计上为单人操作）
- ❌ 以 macOS/Linux 为主平台（Windows 优先；POSIX 辅助脚本为 `.cmd`）
- ❌ 完全无人值守的自动化（设计上 Agent 会等待审批）

## 环境要求

- **Windows**（Windows 优先；POSIX 辅助脚本为 `.cmd`）
- **Node.js >= 22.19**
- **npm**（`package-lock.json` v3，不支持其他包管理器）

## 开发

| 命令 | 用途 |
|---|---|
| `npm install` | 安装依赖 |
| `npm start` | 运行应用（Electron Forge，开发模式） |
| `npm run dev:ui` | 仅渲染进程的 Vite 开发服务器（`127.0.0.1:5173`） |
| `npm run package` | 构建可分发包（Forge，Squirrel 安装器） |
| `npm run typecheck` | `tsc --noEmit`（严格模式） |
| `npm run check` | `biome check --write .`（lint + 格式化） |
| `npm test` | `vitest run` — 全量测试（node + jsdom 工程） |
| `npm run test:e2e` | `playwright test` — 需要先构建 `.vite/build/main.js` |
| `npm run licenses` | 重新生成 `THIRD_PARTY_LICENSES.md` |
| `scripts/gauntlet-ofk.cmd` / `scripts/gauntlet-skills.cmd` | 失败即关闭的证据门禁：typecheck → 基线 → biome → 变异 → 残留扫描 → e2e |

> [!NOTE]
> 目前没有 CI 流水线——提 PR 前请在本地运行门禁脚本。

## 测试

| 命令 | 用途 |
|---|---|
| `npm test` | `vitest run` — 单元、渲染进程、主进程与集成测试套件 |
| `npm run test:watch` | `vitest` 监听模式 |
| `npm run test:e2e` | `playwright test` — 端到端用例（需先构建 `.vite/build/main.js`） |
| `npx vitest run <file…>` | 定向测试（空格分隔的文件列表） |
| `npx vitest run --config scripts/coverage-<side>.vitest.config.ts --coverage` | 分侧覆盖率运行 |

> [!NOTE]
> 目前没有 CI 流水线——提 PR 前请在本地运行 `scripts/gauntlet-ofk.cmd` 与
> `scripts/gauntlet-skills.cmd`（typecheck → 基线 → biome → 变异 → 残留扫描 → e2e）。

## Star 历史

<a href="https://star-history.com/#YHlorra/lorra-agent&Date">
  <img src="https://api.star-history.com/svg?repos=YHlorra/lorra-agent&type=Date" alt="Star History"/>
</a>

## 贡献指南

欢迎贡献。Fork、创建功能分支、提交 PR。

1. 运行 `npm run typecheck` 与 `npm test`——必须通过。
2. 提 PR 前运行 `scripts/gauntlet-ofk.cmd` 与 `scripts/gauntlet-skills.cmd`。
3. 用户可见的变更请在 changelog 中登记。

## 许可证

基于 [MIT License](LICENSE) 发布。Copyright (c) 2026 YHlorra。

<!-- MARKDOWN LINKS & IMAGES -->
[license-shield]: https://img.shields.io/github/license/YHlorra/lorra-agent?style=flat-square
[version-shield]: https://img.shields.io/github/v/tag/YHlorra/lorra-agent?style=flat-square
[stars-shield]: https://img.shields.io/github/stars/YHlorra/lorra-agent?style=flat-square
[issues-shield]: https://img.shields.io/github/issues/YHlorra/lorra-agent?style=flat-square
