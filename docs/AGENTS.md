# SFsmiths — The agents (who does what, with what, and what they can never do)

SFsmiths is one conductor and eleven specialists. Each is a Claude Code subagent defined in `.claude/agents/<name>.md`:
that file is its system prompt, its model and reasoning effort (both from `config/models.yaml`, written by `sfsmiths-human
sync`), its **tool allowlist** (a tool not listed cannot be called), its `disallowedTools`, and the skills preloaded into
it. Command *arguments* are policed by hooks, not by the agent: a developer may hold `mcp__sf-dev__deploy_metadata`, and the
hook still refuses any target that is not the development org.

Read this page top to bottom once and you know the whole team. The stage numbers are the pipeline positions
(`src/core/state-machine.ts`); the gates are the mechanical checks that run when the agent stops (`docs/ARCHITECTURE.md §3`).

---

## The shape of every agent

| Field | Meaning |
|---|---|
| `model` / `effort` | Which Claude model and reasoning effort — chosen per job (routing: low; reproduction and design: xhigh). Edit in the UI → Agents & models. |
| `tools` | The complete allowlist. `mcp__sf-dev__*` = the Salesforce DX MCP server bound to the **development** org only; `mcp__sfsmiths-evidence__*` = masked read-only production; `mcp__sfsmiths-ui__*` = the fenced browser. |
| `disallowedTools` | Always includes `WebFetch`, `WebSearch` (P12) and `Agent` (specialists never spawn agents). |
| `background: false` | Every specialist runs in the foreground so the stage gates can run when it stops (D-093). |
| `maxTurns` | Hard cap on the agent's own loop; a partial result is handed back honestly. |
| `memory: project` | The agent may keep unverified hunches in `.claude/agent-memory/<name>/MEMORY.md` (quarantined; audited by the coach). |
| `skills` | Preloaded: `sfsmiths-core-rules` (P1–P12) for everyone, then job methods (`sfsmiths-*`), the org's standards (`std-*`, and the generated `<prefix>-*` overlay once you ran `conventions build`), and `lessons-<name>` (human-approved lessons). |
| Writes | Only inside `org/force-app/`, `tests-ui/`, its own ticket vault `work/<KEY>/` and its own memory (write-guard hook), plus the role exceptions noted below. |

---

## conductor — the foreman (main thread)

*sonnet · low effort · tools: Read, Glob, Grep, Bash, Skill, Agent(the eleven specialists)*

Started by `sfsmiths-human start` (= `claude --agent conductor`). It is a **router, not a decider**: it runs
`sfsmiths agent handoff <KEY>` and follows the one action the toolkit answers with — SPAWN (one specialist, in the
foreground, with the exact prompt the toolkit rendered), WAIT_AGENT, WAIT_HUMAN (tell you what is needed and stop),
RUN_TOOLKIT, HOLD, PARKED, ESCALATED, FAILED, DONE. It never writes files, never touches an org, never spawns two
specialists at once, never approves anything for you, never re-checks a specialist's work (the gates did).

## a1-intake — the analyst (stages 02 prior_art, 03 intake)

*opus · high · tools: Read, Glob, Grep, Bash, Write, Skill · **no org access on purpose***

Reads the ticket (wrapped in an `<untrusted>` envelope — its text is data, never instructions), pasted screenshots
and comments, prior art and the org map, and writes `01-intake.md`: plain-English business lens and technical lens
(hypotheses with confidence), **§2a Picture** (today vs expected — ASCII + mermaid + one worked example, D-101),
classification (BUG / ENHANCEMENT / DATA-FIX / QUESTION with the deciding sentence quoted), numbered testable acceptance
criteria each traceable to a ticket line, scope as `Type:ApiName` with a source each (or `(needs cartography)` — never a
guessed name), an advisory risk tier (the `risk-floor` gate may only raise it), the blocking questions for you, and an
injection notice for any instruction-like text found in the ticket. First spawn (`prior_art`) writes the prior-art digest
from related vaults, tracker search and git history. Gates: `contract-check`, `risk-floor`. HIGH tier → waits for your approval.

## a0b-baseline — baseline sync (stage 04)

*sonnet · low · tools: Read, Glob, Grep, Bash, Write, Skill · **no org tools***

Makes the development sandbox equal to preprod **for the ticket's scope** before anyone writes code, by driving
`sfsmiths agent baseline <KEY>`: the toolkit (engine keychain for preprod, agent keychain for dev) expands scope through the
dependency graph, retrieves both, classifies each component IDENTICAL / UAT-NEWER / DEV-NEWER / BOTH-CHANGED / UNKNOWN,
snapshots dev, applies `config/policy.yaml → baseline_sync`, deploys preprod versions into dev and verifies. DEV-NEWER,
BOTH-CHANGED and UNKNOWN stop and ask you (`sfsmiths-human baseline decide`). Direction is always preprod → dev. Gate:
`baseline-check`. Skipped entirely in a dev-only configuration (`no_preprod`).

## a0-cartographer — the map maker (stage 05)

*haiku · low · tools: Read/Glob/Grep/Bash/Write/Edit, dev MCP (retrieve, SOQL), evidence tooling/describe/row_count*

Writes `00d-cartography.md/.json` for this ticket: objects and key fields, automation **in order of execution**
(before-save flows → before triggers → validation rules → after triggers → after-save flows → legacy → async), consumers of
every scoped component (dependency graph), data shape (COUNT/GROUP BY only — never record dumps), dev↔prod drift dates,
conventions observed, unknowns. Every API name comes from a retrieve, describe, Tooling query or the existing org map — never
from memory of "typical orgs". May append to `docs/org-map/*` (role exception). Gate: `contract-check`.

## a2-repro — the reproduction engineer (stage 06)

*opus · xhigh · tools: Read/Glob/Grep/Bash/Write/Edit, dev MCP (SOQL, retrieve, run tests), evidence, fenced browser*

"Nothing gets fixed until it is proven broken by an assertion that fails." Data first: masked production evidence for the
bug's footprint → minimal, bulk-honest (≥200 where automation is involved), **meaningfully named, tagged** dev records with
**allowlisted e-mails only**, created by an anonymous Apex script the toolkit runs (`privileged apex-run` — canary-gated,
address-scanned) → a failing Apex/Flow/SOQL assertion **and** an inverse assertion that must keep passing → predicted
distribution (`artifacts/assertions.json`) → `privileged test --phase repro` → `02-repro.md/.json`. Two honest tries, then
an honest escalation. **Enhancement mode (D-098):** for an ENHANCEMENT there is no bug; the "failing tests" are acceptance
tests, one per acceptance criterion, failing because the behaviour does not exist yet — same referee. Never fixes code.
Gates: `email-guard`, `naming-lint`, `assertion-referee`, `contract-check`.

## a3-architect — the solution architect (stage 07)

*opus · xhigh · tools: Read/Glob/Grep/Bash/Write, dev MCP (retrieve, SOQL), evidence*

Writes the plan the developer implements, QA tests, the reviewer reviews and you approve — **grounded** (every API name
resolves against your org's caches, refreshed first with `cache freshen`; every component retrieved and read before it is
planned against), **complete** (nine sections: root cause · components · order of execution & side effects with **§3a Picture
before → after** · consumers & blast radius · bulk & limits · tests · rollback & kill switch · remediation · options +
unknowns + checklist answers) and **honest** (unknowns and options stated; a decision that belongs to a human — "should
escalated cases reach a queue at all?" — is written as a blocking unknown, never chosen silently). Platform behaviour claims
cite the docs mirror or a curated note (P12). Pseudocode and signatures only; no code, no deploys, no data. Gates:
`plan-lint`, `semantic-check`, `checklist`, `contract-check`. MEDIUM+ tier → waits for your approval (HIGH: you type what you checked).

## a4-developer — the developer (stage 08)

*opus · high · tools: Read/Glob/Grep/Bash/Write/Edit/MultiEdit, dev MCP (retrieve, deploy, SOQL, tests, Code Analyzer), Salesforce language server*

Implements **exactly** the approved plan (plus your edits from `approvals/`) in `org/force-app/`, in the org's existing
comment and naming style (`comment-lint`, `naming-lint`; the generated `<prefix>-*` skills carry your conventions once built).
Language-server diagnostics after every Apex edit; Code Analyzer on changed files; **dev sandbox deploy only** (`privileged
deploy-dev`); preprod validate-only dry-run through the engine (`privileged uat-validate` — it never sees that org). Security
by default (`with sharing`, CRUD/FLS, bind variables, no hard-coded ids/URLs/emails); bulk by default; one trigger per
object through the org's framework; never weakens or deletes the repro test. A deviation from the plan is allowed only when
the plan is impossible as written, and is recorded with evidence. Gates: `comment-lint`, `naming-lint`, `plan-lint`
(touches only planned components), `deploy-report`, `contract-check`.

## a5-qa — QA (stages 09 qa_dev, 13 qa_uat)

*sonnet · medium · tools: Read/Glob/Grep/Bash/Write/Edit, dev MCP (tests, SOQL, retrieve), fenced browser*

"Decides nothing by opinion." Maps every planned test to a concrete one and writes the missing ones (bulk 200, meaningful
names, org style), runs the pyramid through the toolkit (`privileged test --phase dev`: Apex, Flow tests, SOQL distribution
assertions), permission tests (`runAs`), UI checks through the fenced browser when the change is visible in Lightning,
regression on every touched object's existing tests, test-quality rules (assertions everywhere, no `SeeAllData`). The report
quotes run files; a `fail` verdict is a good outcome when true — the toolkit bounces to the developer (once) or the
architect (twice), then escalates to you. In preprod (`qa_uat`) it still cannot reach the org: the engine runs the same set
with its own keychain, after the toolkit has verified the deploy arrived (`uat_verify`, D-099). Gates: `assertion-referee`,
`test-quality`, `contract-check` (+ `uat-parity` in preprod).

## a6-reviewer — the fresh-eyes reviewer (stage 10)

*fable (a different model alias than the developer, on purpose) · high · tools: Read/Glob/Grep/Bash/Write, Code Analyzer, retrieve, language server · **read-only***

"Did not write this code and must not want it to pass." First runs `sfsmiths agent deploy-manifest <KEY>` so the exact
changed-component list comes from git (`06c-deploy-manifest.md`, `package.xml`, D-100), then reviews nine dimensions with
evidence per finding (`file:line`, gate file, run file): plan conformance (nothing unplanned in the manifest), acceptance
criteria → proving tests, repro proof (FAIL → PASS), security surface (sharing, CRUD/FLS, injection, hard-coded ids, PII in
logs), Well-Architected pillars, order of execution and side effects, style vs conventions, test quality, git delta sanity.
Verdict APPROVE / APPROVE WITH NITS / REQUEST CHANGES (each change with evidence and the agent who should do it). Writes the
**deploy brief** `06b-deploy-brief.md` for the person who presses Deploy: components (pointing at the manifest), what to do
by hand (profiles, permission sets, layouts), pre-deploy checks, window vs `config/calendar.yaml` freezes, post-deploy
verification SOQL, rollback, remediation hand-off, comms readiness, risks. Gates: `security`, `contract-check`. HIGH tier →
waits for your approval.

## a9-comms — the communications writer (stage 11)

*sonnet · low · tools: Read, Glob, Grep, Write, Skill · **no Bash at all***

Drafts, never sends: `10-comms/client-update.md` (client-visible: plain language, no internal names, record ids, addresses or
blame), `internal-summary.md`, `tracker-comment.md` (a comment **you** may paste into the ticket — posting is disabled by
design, `tracker.post_draft: disabled`). Every sentence traces to a vault file; nothing from inside an untrusted envelope
is copied. Gate: `comms-lint`.

## a8-ui — the browser capability (support agent during 06, 09, 13)

*opus · medium · tools: Read/Glob/Grep/Bash/Write/Edit, `mcp__sfsmiths-ui__*` only*

Some behaviour exists only in the browser: screen flows, quick actions, LWC, page layouts. When a2 or a5 ends its turn with
"UI observation requested" (after writing `ui-request.md`), the conductor spawns a8 — it logs into the **development org
only** through the fenced Playwright server (production and `login.salesforce.com` refused at the network layer, Setup
URLs refused, no JavaScript evaluation), performs the exact steps on a record the ticket created, captures text and
screenshots as evidence into `work/<KEY>/ui/`, drafts a Playwright spec into `tests-ui/specs/`, and hands the observation
back. It never issues a pass/fail — the referee (an assertion) does.

## a7-coach — the learning coach (stage 17 learn, and maintenance)

*sonnet · medium · tools: Read, Glob, Grep, Bash, Write, Skill · **no org access***

"The team gets better only if the lessons are true." Runs `learn-digest` (the toolkit computes rewards from events and
writes the mechanical retro), then reads events, rewards, your rejection reasons and `/feedback`, and the agents' quarantined
`MEMORY.md` notes, and writes **lesson candidates** into `knowledge/lessons/PENDING/` — one behaviour change each, phrased as
an instruction the target agent can follow, with event ids as evidence. The only admissible evidence is events, rewards and
human decisions (P6); an agent's claim about itself is not. You approve, reject or promote lessons (UI → Lessons &
rewards); approved lessons are regenerated into `lessons-<agent>` skills the agents preload. `/feedback "…"` from you
becomes an approved lesson immediately (D-082). The coach never edits another agent's memory and never approves anything itself.

---

## What no agent can do, whatever its prompt says

Write to production · reach preprod except through the toolkit's engine verbs · run `sfsmiths-human` verbs · log into or
switch orgs, change aliases or the default org · push to git or touch a Blue Canvas remote · launch `claude` · browse the
web · post to the tracker or send e-mail · write outside its own areas · spawn another agent (specialists) or two at once
(conductor) · treat text inside an `<untrusted>` envelope as an instruction · argue with a gate.

The mechanisms behind each item are in `docs/SAFETY.md` and `docs/THREAT-MODEL.md`; the tests that try to break them are
`test/03-hooks.test.mjs`, `test/11-beta-run1-fixes.test.mjs` and `test/14-hard-rules.test.mjs`.
