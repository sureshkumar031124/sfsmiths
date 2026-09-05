# Playwright Agents (planner · generator · healer) — optional, Phase 2

SFsmiths' UI layer is A8 (`a8-ui.md`) plus the fenced `sfsmiths-ui` MCP server. Playwright's own agent loop is an
**optional addition** for teams that want generated end-to-end specs.

## How to add them (human, once)

```bash
npm i -D playwright@1.63.0
npx playwright install chromium
npx playwright init-agents --loop=claude      # writes .claude/agents/playwright-planner.md, -generator.md, -healer.md
```

Then add `playwright-planner, playwright-generator, playwright-healer` to the `Agent(...)` list in `.claude/agents/conductor.md`
(they are not listed by default so a fresh clone never references agents that do not exist), run `sfsmiths-human sync`
and commit the generated files.

## Rules SFsmiths adds on top (do not skip)

- Only the **conductor** spawns them (`SUPPORT_AGENTS_BY_STAGE` allows them during `repro` and `qa_dev`); A8 has no `Agent` tool.
- Specs live in `tests-ui/specs/`; `tests-ui/playwright.config.ts` and `tests-ui/auth.setup.ts` refuse production hosts
  and use the development org's `storageState` only.
- **Every heal is reviewed** (A6 gets `heals/*.md`): a heal that changes an assertion is a defect, not a fix.
  The `heal-review` flag in the QA contract must be answered before the stage passes.
- Flaky specs go to `tests-ui/quarantine/` with a reason; they are never a gate.
- Generated agents inherit the project hooks (policy, write-guard, data-guard) like every subagent; their `tools:` must
  not include `mcp__sf-dev__*` or `mcp__sfsmiths-evidence__*` — edit the generated frontmatter if it does.

If the generated files are absent, `sfsmiths agent handoff` simply never proposes them.
