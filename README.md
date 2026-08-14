# lorra

Personal deep-work desktop workspace.

lorra is a Windows-first Electron + React + TypeScript desktop app that wraps the
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) / `pi-coding-agent`
agent SDK through a custom adapter. It gives you a 3-pane workbench where you edit files and
collaborate with an AI agent side by side — with graded approval gates on every AI file write.

## Features

### v1

- **Workspace isolation** — pick or create local workspaces; each workspace keeps its own files, sessions, and skills, and switching never carries state across.
- **3-pane workbench** — collapsible icon bar, session history + file tree, Markdown/PDF/EPUB reader with block-level in-place Markdown editing, and a passive multi-turn agent chat pane.
- **Safe AI file editing** — tool writes are intercepted and suspended until you approve (`allow once` / `allow always` / `deny`), with path checks, high-risk command filtering, and atomic writes.
- **Model provider configuration** — connect providers through the UI; credentials are stored via the SDK auth store, never hardcoded.
- **Web search** — agent can search the web as a first-class tool.

### v2

- **Today page** — 24-hour timeline of your agent activity (per-workspace colored blocks, semantic segments, stacking), calendar navigation, and KPI cards.
- **Review engine** — methodology files (`daily-review.md` / `deep-review.md`) drive model-generated day/week reviews, archived as readable Markdown.
- **Skill management** — five-source skill discovery, per-workspace enable/disable, collection, and Git-based install/update, all from one page.
- **Settings & i18n** — unified settings page (appearance, workspace, about) with instant Chinese/English switching.
- **OFK knowledge layer** — sessions settle as readable Markdown concept docs; daily summaries compile from them; the timeline and review read directly from the document layer.

## Requirements

- **Windows** (Windows-first; POSIX helpers are `.cmd`)
- **Node.js >= 22.19**
- **npm** (`package-lock.json` v3 — no other package manager)

## Quick Start

```sh
npm install
npm start
```

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

No CI pipeline exists — run the gauntlets locally before release.

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Released under the [MIT License](LICENSE). Copyright (c) 2026 YHlorra.
