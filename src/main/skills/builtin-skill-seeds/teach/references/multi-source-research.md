# Multi-Source Research Guide

Step 2 of Bootcamp. The research method that grounds learning in real, current knowledge.

## Three-source parallel search

### 1. Web search

Tool: `mcp__MiniMax__web_search` (or any web search MCP)

Templates:
- `{领域} 学习路径 入门`
- `{领域} 核心概念 常见误区`
- `{领域} best resources 2026`

Extract: core concepts, learning path, common pitfalls, high-quality tutorial links.

### 2. GitHub search

Tool: `mcp__MiniMax__web_search` or `Bash gh`

Templates:
- `site:github.com {领域} awesome`
- `site:github.com {领域} getting started tutorial`
- `{领域} open source project stars:>100`

Filter criteria:
- Stars > 100 (entry projects may relax to 50)
- Updated within last 6 months (drop abandoned)
- Has README and docs (drop code-only repos)
- Prefer awesome lists (one link covers many resources)

Extract: project name, stars, one-line description, link, suitable learning stage.

### 3. Podcast search

Tool: `mcp__MiniMax__web_search`

Templates:
- `{领域} 播客 推荐`
- `{领域} podcast episodes beginner`
- `site:podcasts.apple.com {领域}`
- `{领域} 小宇宙 播客`

Extract: show name, platform, recommended episodes, recommendation reason.

## Result integration

Once three sources are in, integrate by:

1. **Cross-validate**: concepts mentioned in multiple sources = core concepts
2. **Complement**: GitHub = hands-on projects, podcast = deep discussion, web = systematic tutorials
3. **Deduplicate**: same resource across sources appears only once
4. **Layer**: arrange by learning stage (entry → intermediate → deep)

## Output format

Knowledge map given to the user:

```
## 核心概念
1. XX — one-sentence definition
2. XX — one-sentence definition

## 子领域
- A: what it does
- B: what it does

## 推荐学习路径
1. Learn XX first (why)
2. Then XX (why)

## 推荐 GitHub 项目
- [repo-name](url) — one-liner (N stars)

## 推荐播客
- [show name](url) — why

## 常见误区
1. XX (why it's wrong)
2. XX (why it's wrong)
```
