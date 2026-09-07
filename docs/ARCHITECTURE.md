# SFsmiths — Architecture

## 1. Three parts, three responsibilities

| Part | Decides | Never decides |
|---|---|---|
| **Claude Code layer** (conductor + 11 specialists, skills, rules, commands, hooks wiring) | *how* a stage's work is done: reading, reasoning, writing files, calling tools | what happens next, whether a stage passed, whether something is safe |
| **Toolkit** (`src/` → `sfsmiths`, `sfsmiths-human`, `sfsmiths-hook`, MCP servers, UI) | state machine, gates, keychains, masking, baseline sync, rewards, approvals bookkeeping | anything that needs judgement about Salesforce |
| **Human** | approvals at gates, deploys, remediation, lesson approval, org/model/budget config | nothing is done *for* the human that they did not ask for |

The conductor runs on the main thread (`claude --agent conductor`) and calls `sfsmiths agent handoff <KEY>` in a loop.
The toolkit answers with exactly one action (SPAWN / WAIT_HUMAN / RUN_TOOLKIT / HOLD / ESCALATED / PARKED / DONE) and,
for SPAWN, the rendered prompt for exactly one subagent. Hooks make everything else impossible.

## 2. Stage machine (`src/core/state-machine.ts`)

```
open ─ prior_art(a1) ─ intake(a1)·gate ─ baseline(a0b) ─ cartography(a0) ─ repro(a2) ─ plan(a3)·gate ─ develop(a4)
     ─ qa_dev(a5) ─ review(a6)·gate ─ comms(a9) ─ deploy_uat(HUMAN) ─ qa_uat(a5) ─ deploy_prod(HUMAN)
     ─ prod_verify(toolkit) ─ remediation(HUMAN, optional) ─ learn(a7 coach) ─ done
```

Every stage has `gates[]` (mechanical, run by the SubagentStop hook), optionally a `human_gate` key (looked up in
`config/autonomy.yaml` by tier: LOW/MEDIUM/HIGH → ask/auto; a per-agent `ask` overlay wins), and `always_human` for the
deploy/remediation stages. `manifest.yaml` is the single source of truth per ticket; a `.state.json` sidecar lets the
zero-dependency hooks read status without parsing YAML.

**Bounce ladders** (`bounceTarget`): qa fail → develop (1) → plan (2) → escalate (3); repro: 2 tries then honest escalation;
every other agent stage: one retry with the gate report, then escalate. **Rejection** (`/reject … --reason`) re-runs the
rejected stage with the reason in its prompt (the reason also becomes a lesson candidate). **Support flow**: a specialist
that ends with "UI observation requested" (after writing `ui-request.md`) stops cleanly; the next handoff spawns `a8-ui`,
then re-spawns the specialist on the same attempt — no bounce, no penalty. **Blocks**: a SubagentStop can block the same
agent up to 3 times per attempt; then the stage is marked failed and handoff bounces/escalates. **Budget**: over the
per-ticket tokens/USD → `parked` (resumable). **Human gates**: `waiting_human` with a typed `waiting.kind`
(approval | deploy | remediation | question | budget | baseline | canary).

## 3. Gates (`src/gates/`)

| Gate | Reads | Passes when |
|---|---|---|
| contract-check | `NN-*.json` vs `schemas/contracts/*.schema.json` | valid schema; evidence refs that look like files exist |
| risk-floor | `01-intake.json` | computes tier floor (Apex/permissions → HIGH; flow/VR → MEDIUM); agent may only raise |
| baseline-check | `00b-baseline.json` | every in-scope component equal to preprod after sync or explicitly excluded |
| email-guard | changed files + artifacts | no address outside `safety.allowed_test_emails` |
| naming-lint | new component/test names, data tags | `config/naming.yaml` patterns; no ticket-number names |
| assertion-referee | `02-repro.json` + `validations/tests-<phase>.json` | repro: failing FAIL + inverse PASS; dev/uat: all PASS + distribution holds |
| plan-lint | `03-plan.json` (or repro/implementation) vs `.sfsmiths/cache/{describe,metadata}` | every api_name resolves; new names only with `action: create` |
| semantic-check | plan fields/flows/api_version | writable fields, no managed edits, before-save flow rules, api version consistent with `sfdx-project.json` |
| checklist | plan `checklist_answers` vs `knowledge/checklists/*.yaml` | every applicable item answered (n/a needs a note) |
| comment-lint | changed `.cls/.trigger/*-meta.xml/lwc` | header doc, method docs, mod-log with ticket, `<description>` |
| deploy-report | `validations/deploy-dev.json`, `uat-validate.json` | succeeded, 0 errors, file hashes still current |
| test-quality | changed test classes + report | assertion in every method, no SeeAllData |
| security | changed Apex + `06-review.json` | ruleset clean; crud_fls + sharing stated |
| comms-lint | `10-comms/*.md` | audience header; no forbidden terms/secrets/envelopes in client drafts |
| analyzer | `validations/analyzer.json` | Code Analyzer findings ≤ threshold |

Outcomes are `passed | failed | unavailable`; **unavailable is never passed**. Every outcome is persisted to
`validations/<stage>-<gate>.json`, recorded in the manifest with an artifact hash, and emitted as an event (with
`first_try` for the reward ledger).

## 4. Hooks (`src/hooks/`, wired in `.claude/settings.json`)

| Event | Hook | Behaviour |
|---|---|---|
| PreToolUse Agent | `agent-gate` (fast, ≤50 ms) | deny agents not in `next_allowed_stages`, denied names, when waiting/on hold/parked/done |
| PreToolUse Bash | `policy` (fast) | R1 human verbs · R2 HOME/SF_* / engine home · R3 git push / Blue Canvas · R4 nested claude · R5 direct HTTP to Salesforce · R6 protected paths (write targets only) · R7 sf targets (any explicit target that is not a configured development alias is denied — reads included, bare usernames included; preprod/prod get specific messages; writes need an explicit dev target; org login deny) |
| PreToolUse Edit/Write/… | `write-guard` (fast) | write areas only; own ticket vault; own agent memory; role exceptions (a0 → docs/org-map, a7 → lessons/PENDING) |
| PreToolUse mcp__sf-dev__.* | `data-guard` (fast) | side-effect tools need a fresh PASS email canary |
| PostToolUse Agent | `tokens` | per agent/model/ticket accounting (payload shape defensive; transcript fallback) |
| — | (design note) | loops are bounded by SFsmiths' own persisted counters (≤3 gate blocks per attempt, 8 consecutive stop blocks per session, reset on every new human prompt); `stop_hook_active` is deliberately not relied upon |
| PostToolUse Edit/Write | `post-edit` | advisory comment/naming feedback |
| SubagentStop (our agents) | `stage-gate` | run the stage's gates → mark done or `{"decision":"block"}` (≤3) |
| Stop | `stop-guard` | conductor may not stop mid-ticket (8-block cap → waiting_human + notify) |
| UserPromptSubmit | `prompt-router` | `/ticket` binding (conductor only); `/approve /reject /hold /resume /feedback` recorded as HUMAN actions; pasted text → inbox evidence |
| SessionStart / PreCompact | `session-start` / `precompact` | state + P7 reminders as context |

Fast deny hooks are zero-dependency (node:fs/path only) and fail **closed** on internal errors; a timed-out hook renders
no decision in Claude Code, so speed is safety and the hard cases are duplicated as static `permissions.deny` rules.
`SFSMITHS_HOOKS_OFF=1` is the documented human escape hatch.

## 5. Engines (`src/engines/`)

- **lifecycle** — open (tracker fetch → envelope-wrapped `ticket.md`, manifest, prior-art index), hold/resume (tracker
  re-fetch, diff classification NONE/COMMENTS_ONLY/DESCRIPTION_AC/SCOPE_CHANGED/CANCELLED_DONE, sandbox-refresh detection,
  baseline re-check, locks), deploy marks, read-only production verify.
- **baseline** — 3-way classification (IDENTICAL / UAT-NEWER / DEV-NEWER / BOTH-CHANGED / UNKNOWN / MISSING-*) with an
  ancestor from fingerprints or Tooling dates; snapshot + git commit; policy from `config/policy.yaml → baseline_sync`;
  human decisions via `sfsmiths-human baseline decide` or `/approve … --answer "keep-dev:… take-uat:…"`.
- **evidence** — SOQL parser (SELECT-only, no subqueries), allowlist + field-type refusal, row cap, masking, logging to
  `.sfsmiths/evidence.log.jsonl`, vault copies; Tooling allowlist; describe.
- **privileged** — canary (`Messaging.sendEmail(allOrNothing=false)` → pass only on `NO_SINGLE_MAIL_PERMISSION` / `NO_MASS_MAIL_PERMISSION`), test runs
  (Apex + SOQL assertions + Flow tests) with hashes, preprod dry-run (engine), dev deploy, anonymous Apex with email scan,
  Code Analyzer, oracle cache refresh.
- **priorart, learn, tokens, approvals, notify, sync, setup, orgmap, mirror, conventions, golden, pipeline** — see the
  file headers; each is a plain module with no LLM calls.

## 6. Two keychains, one direction

```
agent keychain ($HOME)              engine keychain (~/.sfsmiths/engine)
  DevSandbox  (read-write)            PartialUAT (retrieve · validate-only · run tests)
  Production  (read-only user) ──────── never here
        ▲                                   │
   agents (MCP / wrappers)          toolkit privileged verbs only
```

Direction of metadata is always preprod → dev (baseline) and dev → (human) → preprod → (human) → production.

## 7. Data flow of a ticket vault (`work/<KEY>/`)

`ticket.json/.md` · `00-inbox/` · `00b-baseline.*` · `00c-prior-art.*` · `00d-cartography.*` · `01-intake.*` · `02-repro.*`
· `03-plan.*` · `04-implementation.*` · `05-test-report.*` · `06-review.*` + `06b-deploy-brief.md` · `07-uat-report.*`
· `08-prod-verify.md` · `09-retro.*` · `10-comms/` · `artifacts/` · `evidence/` · `ui/` · `validations/` · `approvals/`
· `events.jsonl` · `facts.md` · `manifest.yaml` · `.state.json` · `history/`.
Toolkit-owned: manifest, state, events, validations, approvals. Agents own the rest of their ticket's vault.

## 8. Learning loop

events → `computeRewards` (weights in `config/rewards.yaml`) → `metrics/rewards.json` + digest → candidates
(`knowledge/lessons/PENDING/`) from repeated failures, rejections, escalations, coach notes → human approve/reject/promote
(CLI or UI) → `learnSync` writes `.claude/skills/lessons-<agent>/SKILL.md` (capped, ranked) → agents preload them.
Golden Ticket Replay (`benchmarks/`) guards against drift after model/plugin/prompt changes.

## 9. Configuration is the product surface

Everything a team would change lives in `config/` (14 YAML files, schemas in `schemas/config/`): tracked defaults in
`config/defaults/`, a user's personal copies in `config/*.yaml` (gitignored; read first, default otherwise — see
`config/README.md`). `sfsmiths-human sync` propagates config into generated files (`.mcp.json`, compiled policy, agent model
lines, `.claude/settings.local.json` deny blocks); the UI is an editor over the same files. `scripts/hardcode-lint.mjs` fails
CI if anything company-specific leaks into tracked files — `config/defaults/` included.
