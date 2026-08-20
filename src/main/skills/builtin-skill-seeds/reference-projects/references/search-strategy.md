# 4 源搜索策略

## 源 1：GitHub（开源项目）

**核心工具**：
- `gh search repos <query> --limit 20 --sort stars` - 找仓库
- `gh search code <query> --limit 20` - 找代码片段
- `gh_grep_searchGitHub(query, language)` - 跨仓库找用法

**Query 模板**：

```
# 主搜（仓库名 + 描述）
gh search repos "{关键词}" --limit 20

# 限定语言（已知技术栈时）
gh search repos "{关键词}" --language typescript --limit 15

# 找活跃项目（最近更新）
gh search repos "{关键词}" --sort updated --limit 15

# 找代码用法
gh search code "{具体技术点}" --language python --limit 10
```

**关键词扩展**（中→英）：
- 「笔记」→ note / notes / notebook / note-taking
- 「AI 助手」→ ai assistant / ai agent / copilot
- 「任务管理」→ task manager / todo / kanban

**过滤规则**：
- star < 10：除非是刚发布的新项目，否则忽略
- 最后更新 > 1 年：标记为「不活跃」，降权
- archived：标记为「已废弃」，进失败案例

**必读内容**：
- README 第一段（做什么）
- 最近 10 条 issue（用户痛点）
- Releases（版本节奏）

---

## 源 2：Web（媒体/博客）

**核心工具**：
- `websearch_web_search_exa` - 通用 web 搜索
- `webfetch(url, prompt)` - 读具体页面
- `MiniMax_web_search` - 备选

**Query 模板**：

```
# 产品发布/融资新闻
"{关键词}" launch OR announcement site:techcrunch.com OR site:36kr.com
"{关键词}" 融资 OR 发布 site:36kr.com OR site:huxiu.com

# 产品评测/对比
"{关键词}" review OR comparison
"{关键词}" 测评 OR 对比

# 行业趋势（仅 market-scan 阶段）
"{行业}" trends 2026 OR market report
"{行业}" 趋势 OR 行业报告
```

**过滤规则**：
- 优先近 1 年内容
- 优先一手来源（产品官网 > 媒体报道 > 转载）
- 排除明显 SEO 内容农场

---

## 源 3：社区（真实讨论）

**核心工具**：`agent-reach` skill，统一入口

**Query 模板（按平台）**：

| 平台 | Query 风格 | 适合找什么 |
|------|-----------|------------|
| V2EX | 「关键词 节点: 创造者」 | 中文独立开发、痛点讨论 |
| Hacker News | `"keyword" Show HN` | 海外新发布、评论质量高 |
| Reddit | `"keyword" site:reddit.com/r/XXX` | 用户真实抱怨、推荐 |
| 少数派 | `关键词 site:sspai.com` | 中文工具评测、生活方式 |
| 即刻 | `关键词` | 中文 PM/产品圈讨论 |
| 微博 | `关键词` | 大众认知、热度信号 |

**过滤规则**：
- 优先高赞/高评论内容
- 优先「我用过」「对比过」的实操帖，避开发水文
- 抱怨/推荐 = 痛点和亮点信号

---

## 源 4：商业产品库

**核心工具**：
- `webfetch(producthunt.com/...)` - Product Hunt
- `webfetch(apps.apple.com/...)` - App Store
- `webfetch(chromewebstore...)` - Chrome 扩展
- `webfetch(alternativeto.net...)` - 同类替代品

**Query 模板**：

```
# Product Hunt
site:producthunt.com "{关键词}"

# App Store
"{关键词}" site:apps.apple.com

# 同类替代品
"{竞品名}" alternatives
"{关键词}" alternatives
```

**必读内容**：
- 评分 + 评论数（粗估用户量）
- Top 3 好评 + Top 3 差评（找亮点和痛点）
- 定价页（商业模式）
- 更新日志（迭代节奏 = 团队活跃度）

---

## 跨源去重规则

- 同一项目在 2+ 源出现 → 加权
- 同一团队的多产品 → 标记关联
- 时间窗口：默认近 2 年，market-scan 阶段放宽到近 3 年

## 评分硬阈值

| 阈值 | 含义 |
|------|------|
| 相近度 < 3 | 抛弃，不进报告 |
| 成熟度 < 2 + 想法验证阶段 | 抛弃 |
| 成熟度 < 4 + 竞品对标阶段 | 仅作背景，不深扒 |
| star < 5 的 GitHub 仓库 | 仅在「早期信号」区提及 |

## 噪声处理

- 「关键词恰好撞名」的项目 → 看核心功能再判
- 「明显是课程/培训」类 → 不算项目
- 「明显是仿盘/克隆无差异化」→ 除非有大流量，否则进「失败案例」
