---
name: teach
description: 教用户系统学习一个新领域。Bootcamp 一次性 5 步引导建 mission，Camp 多会话持续教学（最近发展区 / 间隔练习 / 检索回忆），多 mission 经 workspaces/ 并行、个性化经 user.json 跨任务共享。当用户说「我想学××」「怎么学××」「learn ××」「继续学」「教我」或 /teach 时使用；不处理具体技术报错求助、内容写作、文章总结等非学习意图。
argument-hint: "[new topic] | continue [mission-slug] | list"
---

# Teach

> lorra 内置版（目录形技能，SKILL.md + references/ + formats/ 多文件）。学习状态统一落在
> 状态根目录 `~/.lorra/teach/`（与技能库 `~/.lorra/skills/teach/` 隔离），不放在 SKILL.md 旁边。

## On startup

1. Read `~/.lorra/teach/user.json` for personalization. If absent, use empty defaults and create the file lazily.
2. Scan `~/.lorra/teach/workspaces/*/MISSION.md` to find missions.
3. Decide phase based on argument and current state:
   - `list` → show all missions with their status
   - `continue <slug>` → Camp for that mission
   - No mission + no arg → ask which subject to start, or pick arg if given
   - New topic → **Bootcamp**
   - Existing mission + no arg → ask "continue <most-recent> or new?"

Apply `~/.lorra/teach/user.json` throughout. Honor `prefers.language` and `learningStyle.*`.

## Bootcamp — 1-shot 5-step onboarding

Progressive disclosure: each step ends with user confirmation before next. See `references/progressive-disclosure.md`.

### Step 1: Why
3 questions to converge "I want to learn X" into a concrete goal:
- What life/state do you want this to support?
- What person do you need to become to get there?
- What project in 6-12 weeks advances that?

Output: one-sentence goal + project direction. If user can't articulate, push back via Socratic questions; don't fabricate.

### Step 2: Multi-source research
Parallel search: web + GitHub + podcast. See `references/multi-source-research.md` for templates and standards.
Output: knowledge map (core concepts, sub-domains, recommended path, common pitfalls, GitHub + podcast recs).
Ask: matches your understanding? Adjustments?

### Step 3: Project decomposition
3-5 stages, 2-3 weeks each. Per stage: goal, skills, resources, output.
Ask: pacing reasonable?

### Step 4: Start inertia (齐加尼克效应)
Where are you stuck? 3 actions doable in 15 min each. Concrete: "open X, do Y".

### Step 5: Rhythm
Daily/weekly cadence: deep work (1-2h), supplemental (30-60min), reflection (15-30min). Concrete weekly template.

### Bootcamp output
Create `~/.lorra/teach/workspaces/<slug>/` with:
- `MISSION.md` (see `formats/MISSION-FORMAT.md`)
- `RESOURCES.md` (see `formats/RESOURCES-FORMAT.md`)
- `NOTES.md` (empty)

Then auto-suggest: "Bootcamp done. Run `/teach continue <slug>` to start Camp."

## Camp — stateful multi-session teaching

Each session:
1. Read `~/.lorra/teach/workspaces/<slug>/{MISSION,RESOURCES,NOTES}.md` + last 5 learning-records
2. Apply `~/.lorra/teach/user.json` preferences (pace, depth, language, terminology)
3. Determine the next lesson in the user's ZPD (between what they know and what mission needs)
4. Write lesson to `~/.lorra/teach/workspaces/<slug>/lessons/NNNN-<slug>.html` (Tufte aesthetic, self-contained, ≤ 1 screen)
5. Open lesson via `start <abs-path>` (Windows) / `open` (macOS) / `xdg-open` (Linux)
6. Wait for user response, then:
   - If demonstrated understanding → write `~/.lorra/teach/workspaces/<slug>/learning-records/NNNN-<slug>.md`
   - If surfaced preference → append to `~/.lorra/teach/workspaces/<slug>/NOTES.md`; consider promoting to `~/.lorra/teach/user.json` next session
   - If new trusted source → add to `~/.lorra/teach/workspaces/<slug>/RESOURCES.md`
   - If user-disclosed prior knowledge → add to `~/.lorra/teach/user.json.priorKnowledge`

### Lesson design rules
- One tightly-scoped thing tied to mission
- Short, completable in < 15 min, one tangible win
- HTML anchors linking to other lessons + reference
- Recommend one primary high-trust source
- Distinguish knowledge (low difficulty) vs skills (high difficulty, retrieval-heavy)
- Apply: ZPD, retrieval practice, spaced repetition, interleaving (skills only), desirable difficulty
- End with: reminder to ask the agent follow-up questions

### Learning record triggers
Write `~/.lorra/teach/workspaces/<slug>/learning-records/NNNN-<slug>.md` when any is true:
1. User demonstrated genuine understanding (not just exposure)
2. User disclosed prior knowledge
3. A misconception was corrected
4. Mission shifted in response to learning (cross-link `~/.lorra/teach/workspaces/<slug>/MISSION.md`)

Do NOT write for: material merely covered; anything already in glossary; session activity logs.

### Wisdom handoff
If a user question is wisdom-level (judgment, real-world tradeoff), attempt to answer, then delegate to a community surfaced in `~/.lorra/teach/workspaces/<slug>/RESOURCES.md > Wisdom`. Respect any user opt-out noted there.

## Multi-mission management
- `~/.lorra/teach/workspaces/<slug>/` per mission; one slug at a time
- `~/.lorra/teach/user.json` shared — patterns from one mission's `NOTES.md` and `learning-records/` may promote to user.json (cross-mission prior knowledge, etc.)
- Mark mission complete: prepend `Status: completed (YYYY-MM-DD)` to `~/.lorra/teach/workspaces/<slug>/MISSION.md`; do NOT delete records

## Language
Default Chinese for all generated artifacts. If `prefers.language` = "en" in `~/.lorra/teach/user.json`, switch. External resource titles (web, GitHub, podcast) keep original language.

## Boundaries

Do not:
- Decide what the user should learn
- Solve in-flight technical questions (defer to other skills)
- Recommend paid courses
- Guarantee learning outcomes

Do:
- Multi-source research (web + GitHub + podcast)
- Progressive disclosure (don't dump)
- Concrete plans down to "do X for 15 min"
- Surface and apply `~/.lorra/teach/user.json` preferences
- Cross-mission learning via `~/.lorra/teach/user.json`

---

Copyright (c) 2026 lorra · https://github.com/YHlorra/lorra-agent
