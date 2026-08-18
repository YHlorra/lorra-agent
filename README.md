<a id="readme-top"></a>

**[English](README.en.md) | [中文](README.md)**

<h1 align="center">lorra</h1>

<p align="center">
为深度工作而生的个人桌面工作台：本地文件编辑与 AI Agent 协作并排进行，每一次 AI 文件写入都经过分级审批。
</p>

<p align="center">
  <a href="https://github.com/YHlorra/lorra-agent/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
  <a href="https://github.com/YHlorra/lorra-agent"><img alt="Version" src="https://img.shields.io/badge/version-2.0.0-6c5ce7.svg"></a>
  <a href="https://github.com/YHlorra/lorra-agent/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YHlorra/lorra-agent/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/YHlorra/lorra-agent/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/YHlorra/lorra-agent.svg?style=social"></a>
  <a href="https://github.com/YHlorra/lorra-agent/issues"><img alt="Issues" src="https://img.shields.io/github/issues/YHlorra/lorra-agent.svg"></a>
</p>

---

## 目录

- [快速上手](#quick-start)
- [核心能力](#capabilities)
- [适用 / 不适用场景](#when-not-to-use)
- [模型配置](#model-configuration)
- [架构总览](#how-it-fits-together)
- [开发命令](#development-commands)
- [测试](#testing)
- [安全](#security)
- [许可证](#license)
- [Star 历史](#star-history)

<a id="quick-start"></a>

## 快速上手

> [!NOTE]
> 环境要求：**Windows**（Windows 优先，POSIX 辅助脚本均为 `.cmd`）、**Node.js >= 22.19**、**npm**（`package-lock.json` v3，不支持其他包管理器）。

```sh
npm install
npm start
```

**验证是否成功**：应用窗口打开，出现三栏工作台（可折叠图标栏 / 会话历史 + 文件树 / 阅读器 + Agent 对话窗格）。在右侧会话窗格向 Agent 提问；当 Agent 尝试写入文件时，写入会被挂起并弹出审批框（允许一次 / 始终允许 / 拒绝）。

<a id="capabilities"></a>

## 核心能力

| 能力 | 说明 |
|---|---|
| 工作区隔离 | 选择或创建本地工作区，各自持有独立文件、会话与技能，切换不串扰 |
| 三栏工作台 | 可折叠图标栏；会话历史 + 文件树；Markdown / PDF / EPUB 阅读器（块级就地 Markdown 编辑）+ 多轮 Agent 对话窗格 |
| 安全的 AI 文件编辑 | 工具写入被拦截并挂起，审批后才落地（允许一次 / 始终允许 / 拒绝），含路径校验、高危命令过滤与原子写入 |
| 模型提供商配置 | 界面内接入提供商；凭据经 SDK auth store 保存，绝不硬编码 |
| 网页搜索 | Agent 可将网页搜索作为一等工具使用 |
| 今日页 | 24 小时活动时间线（单轨道、按标签着色的甘特列、语义分段、增量 LLM 摘要），支持标签过滤、日历导航与 KPI 卡片 |
| 复盘引擎 | 由方法论文件（`daily-review.md` / `deep-review.md`）驱动生成日/周复盘，归档为可读 Markdown |
| 技能管理 | 五源技能发现、按工作区启用/停用、收藏，以及基于 Git 的安装与更新，全部集中在一个页面 |
| 设置与 i18n | 统一设置页（外观、工作区、数据源、标签、关于），中英文即时切换 |
| OFK 知识层 | 会话沉淀为可读 Markdown 概念文档；日摘要由此编译，时间线与复盘直接读取文档层 |

<a id="when-not-to-use"></a>

## 适用 / 不适用场景

**适合使用 ✅**

- 想要本地优先、文件完全可控的桌面 AI 工作区
- 需要为 AI 的每次文件写入把关（审批门控）的协作方式
- 希望把会话沉淀为 Markdown 知识、做日/周复盘的个人知识管理

**不适合使用 ❌**

- 只需要网页版或云端协作 —— 这是本地桌面应用
- 希望 AI 全自动写入、不需要审批门控
- 非 Windows 平台（当前未提供 macOS / Linux 构建）

<a id="model-configuration"></a>

## 模型配置

- 在设置页连接模型提供商；凭据经 SDK auth store 保存，不硬编码、不落盘明文
- Agent 可将网页搜索作为一等工具使用

<a id="how-it-fits-together"></a>

## 架构总览

- **技术栈**：Electron + React + TypeScript，Tailwind CSS 样式
- **Agent 内核**：通过自研适配器包装 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) / `pi-coding-agent` Agent SDK
- **构建与质量**：Electron Forge + Vite；Biome 检查；Vitest + Playwright 测试

<a id="development-commands"></a>

## 开发命令

前提：Node >= 22.19，npm（`package-lock.json` v3，不支持其他包管理器）。

| 命令 | 用途 |
|---|---|
| `npm install` | 安装依赖 |
| `npm start` | 运行应用（Electron Forge，开发模式） |
| `npm run dev:ui` | 仅渲染进程的 Vite 开发服务器（`127.0.0.1:5173`） |
| `npm run package` | 构建可分发包（Forge，Squirrel 安装器） |
| `npm run typecheck` | `tsc --noEmit`（严格模式） |
| `npm run check` | `biome check --write .`（lint + 格式化） |
| `npm test` | `vitest run` 全量测试（node + jsdom 两个项目） |
| `npm run test:watch` | `vitest` 监听模式 |
| `npm run test:e2e` | `playwright test`（需先产出 `.vite/build/main.js`） |
| `npx vitest run <file…>` | 定向测试（空格分隔文件列表） |
| `npx vitest run --config scripts/coverage-<side>.vitest.config.ts --coverage` | 覆盖率运行（按侧配置） |
| `scripts/gauntlet-ofk.cmd` / `scripts/gauntlet-skills.cmd` | 失败即关闭的证据门禁：typecheck → baseline → biome → 变异测试 → 残留扫描 → e2e |

<a id="testing"></a>

## 测试

CI 在每次推送到 `main` 时运行（GitHub Actions，`windows-latest`）：typecheck → lint → 单元/组件测试 → bundle 构建 → 真实 Electron e2e（隔离 profile）→ Squirrel 安装器。

<a id="security"></a>

## 安全

- 模型凭据经 SDK auth store 加密保存，代码中不硬编码

> [!WARNING]
> 切勿将 API 密钥、`.env` 或任何令牌提交进仓库

发现安全漏洞：通过 [GitHub Issues](https://github.com/YHlorra/lorra-agent/issues) 报告，并在公开内容中避免泄露漏洞细节。

<a id="license"></a>

## 许可证

<p>
  <a href="https://github.com/YHlorra/lorra-agent/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

基于 [MIT License](https://github.com/YHlorra/lorra-agent/blob/main/LICENSE) 发布。Copyright (c) 2026 YHlorra。

<a id="star-history"></a>

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=YHlorra/lorra-agent&type=Date)](https://star-history.com/#YHlorra/lorra-agent&Date)