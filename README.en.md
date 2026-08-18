<a id="readme-top"></a>

**[English](README.en.md) | [中文](README.md)**

<h1 align="center">lorra</h1>

<p align="center">
A personal deep-work desktop workspace: local file editing and AI agent collaboration side by side, with graded approval gates on every AI file write.
</p>

<p align="center">
[![License][license-badge]][license-url] [![Version][version-badge]][version-url] [![CI][ci-badge]][ci-url] [![Stars][stars-badge]][stars-url] [![Issues][issues-badge]][issues-url]
</p>

---

## Table of Contents

- [Quick Start](#quick-start)
- [Capabilities](#capabilities)
- [When (Not) to Use](#when-not-to-use)
- [Model Configuration](#model-configuration)
- [How It Fits Together](#how-it-fits-together)
- [Development Commands](#development-commands)
- [Testing](#testing)
- [AI Coding Agent Setup](#ai-coding-agent-setup)
- [Security](#security)
- [License](#license)
- [Star History](#star-history)

## Quick Start

> [!NOTE]
> Requirements: **Windows** (Windows-first; POSIX helpers are `.cmd`), **Node.js >= 22.19**, **npm** (`package-lock.json` v3 — no other package manager).

```sh
npm install
npm start
```

**Verification**: the app window opens with the 3-pane workbench (collapsible icon bar / session history + file tree / reader + agent chat). Ask the agent a question in the chat pane; when the agent tries to write a file, the write is suspended until you approve it (allow once / allow always / deny).

## Capabilities

| Capability | Description |
|---|---|
| Workspace isolation | Pick or create local workspaces; each keeps its own files, sessions, and skills, and switching never carries state across |
| 3-pane workbench | Collapsible icon bar; session history + file tree; Markdown / PDF / EPUB reader with block-level in-place Markdown editing, plus a passive multi-turn agent chat pane |
| Safe AI file editing | Tool writes are intercepted and suspended until approval (allow once / allow always / deny), with path checks, high-risk command filtering, and atomic writes |
| Model provider configuration | Connect providers through the UI; credentials are stored via the SDK auth store, never hardcoded |
| Web search | Agent can search the web as a first-class tool |
| Today page | 24-hour timeline of agent activity (single track, tag-colored gantt columns, semantic segments, incremental LLM summaries) with tag filtering, calendar navigation, and KPI cards |
| Review engine | Methodology files (`daily-review.md` / `deep-review.md`) drive model-generated day/week reviews, archived as readable Markdown |
| Skill management | Five-source skill discovery, per-workspace enable/disable, collection, and Git-based install/update, all from one page |
| Settings & i18n | Unified settings page (appearance, workspace, data sources, tags, about) with instant Chinese/English switching |
| OFK knowledge layer | Sessions settle as readable Markdown concept docs; daily summaries compile from them; timeline and review read directly from the document layer |

## When (Not) to Use

**Use it ✅**

- You want a local-first desktop AI workspace where files stay fully under your control
- You want an approval gate on every AI file write
- You want sessions to settle into Markdown knowledge for day/week reviews

**Don't use it ❌**

- You need web or cloud collaboration only — this is a local desktop app
- You want fully automatic writes with no approval gate
- You're not on Windows (no macOS / Linux builds yet)

## Model Configuration

- Connect model providers in the settings page; credentials are stored via the SDK auth store, never hardcoded or written in plaintext
- The agent can use web search as a first-class tool

## How It Fits Together

- **Stack**: Electron + React + TypeScript, styled with Tailwind CSS
- **Agent core**: custom adapter wrapping the [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) / `pi-coding-agent` agent SDK
- **Build & quality**: Electron Forge + Vite; Biome checks; Vitest + Playwright tests

## Development Commands

Prerequisite: Node >= 22.19, npm (`package-lock.json` v3; no other package manager).

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm start` | Run the app (Electron Forge, dev mode) |
| `npm run dev:ui` | Vite renderer-only dev server (`127.0.0.1:5173`) |
| `npm run package` | Build distributable (Forge, Squirrel installer) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run check` | `biome check --write .` (lint + format) |
| `npm test` | `vitest run` — full suite (node + jsdom projects) |
| `npm run test:watch` | `vitest` watch mode |
| `npm run test:e2e` | `playwright test` — requires built bundle `.vite/build/main.js` first |
| `npx vitest run <file…>` | Targeted tests (space-separated file list) |
| `npx vitest run --config scripts/coverage-<side>.vitest.config.ts --coverage` | Coverage run (per-side config) |
| `scripts/gauntlet-ofk.cmd` / `scripts/gauntlet-skills.cmd` | Fail-closed evidence gates: typecheck → baseline → biome → mutation → residual scan → e2e |

## Testing

CI runs on every push to `main` (GitHub Actions, `windows-latest`): typecheck → lint → unit/component tests → bundle build → real-Electron e2e (isolated profile) → Squirrel installer.

## AI Coding Agent Setup

> [!NOTE]
> This repository does not currently ship agent instruction files / MCP config / skills.
> <!-- TODO: document AI coding agent (Claude Code / Codex, etc.) setup here once provided -->

## Security

- Model credentials are encrypted via the SDK auth store; nothing is hardcoded

> [!WARNING]
> Never commit API keys, `.env`, or any tokens to the repository

Found a vulnerability? Report it via [GitHub Issues](https://github.com/YHlorra/lorra-agent/issues) without disclosing exploit details publicly.

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/YHlorra/lorra-agent/blob/main/LICENSE)

Released under the [MIT License](https://github.com/YHlorra/lorra-agent/blob/main/LICENSE). Copyright (c) 2026 YHlorra.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=YHlorra/lorra-agent&type=Date)](https://star-history.com/#YHlorra/lorra-agent&Date)

[license-badge]: https://img.shields.io/badge/License-MIT-yellow.svg
[license-url]: https://github.com/YHlorra/lorra-agent/blob/main/LICENSE
[version-badge]: https://img.shields.io/badge/version-2.0.0-6c5ce7.svg
[version-url]: https://github.com/YHlorra/lorra-agent
[ci-badge]: https://github.com/YHlorra/lorra-agent/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/YHlorra/lorra-agent/actions/workflows/ci.yml
[stars-badge]: https://img.shields.io/github/stars/YHlorra/lorra-agent.svg?style=social
[stars-url]: https://github.com/YHlorra/lorra-agent/stargazers
[issues-badge]: https://img.shields.io/github/issues/YHlorra/lorra-agent.svg
[issues-url]: https://github.com/YHlorra/lorra-agent/issues
