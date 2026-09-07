# SFsmiths — Setup

Time: ~2 hours for the tooling, plus the Phase 0 spikes (≈3½ days, once) before the first real ticket.
Platform: macOS / Linux (Windows: Phase 4 — the hooks use `$HOME` and a POSIX shell).

## 0. Prerequisites

| Need | Version | Check |
|---|---|---|
| Node.js | ≥ 20.10 | `node --version` |
| Salesforce CLI | ≥ 2.86 (2.150.6 verified) with `plugin-flow`, `code-analyzer` | `sf --version`, `sf plugins` |
| git | any recent | `git --version` |
| python3 + jq | (used by the sf-skills plugin hooks) | `python3 --version`, `jq --version` |
| Claude Code | current | `claude --version` |
| Optional: Playwright 1.63.0 | UI layer | `npm i -D playwright@1.63.0 && npx playwright install chromium` |
| Optional: Docker | Hercules (Phase 3) | — |

Your **own admin production login must not be in the default sf keychain on this machine** — doctor #6 fails if it is.
Use `sf org logout -o <admin alias>` or a separate OS user for admin work.

## 1. Install

```bash
git clone <your-fork> sfsmiths && cd sfsmiths
npm ci && npm run build && npm test
npm run install:toolkit            # → ~/.sfsmiths/toolkit (installed copy) + ~/.sfsmiths/bin launchers + ~/.sfsmiths/engine (engine keychain HOME)
export PATH="$HOME/.sfsmiths/bin:$PATH"   # add to your shell profile
```

Why an installed copy? `.claude/settings.json` hooks call `~/.sfsmiths/bin/sfsmiths-hook`. Agents can edit files in the
repo they are allowed to touch, but they can never change the code that enforces the rules. After you change the toolkit
yourself: `npm run install:toolkit` again (doctor #9e warns when the versions differ).

## 2. Configure — `sfsmiths-human setup`

The wizard writes **your** `config/*.yaml` (gitignored; the tracked defaults live in `config/defaults/` and are used for any
file you have not personalised — all schema-validated; the UI edits the same files later). Enter keeps the shown default;
type `none` to skip an optional org. **A development-sandbox-only first run is supported** (preprod = `none`, production =
`none`, tracker `file`): baseline sync, the preprod deploy/QA stages and production verify are skipped and recorded as
such; add the other orgs later with `sfsmiths-human org add` + `org login` (or the UI → Orgs).

| File | What you decide |
|---|---|
| `orgs.yaml` | your three orgs (development / preprod / evidence), aliases, keychains, the read-only user; add more with `sfsmiths-human org add` or the UI |
| `tracker.yaml` | `jira` (read-only token via env `SFSMITHS_JIRA_EMAIL` / `SFSMITHS_JIRA_TOKEN`, base URL, project key, prior-art JQL) or `file` (inbox/) |
| `safety.yaml` | allowed test email domains, test tag field, canary recipient env (`SFSMITHS_CANARY_EMAIL` = **your** address), UI refusals |
| `models.yaml` | model alias per agent (opus/sonnet/haiku/fable/inherit) |
| `autonomy.yaml` | tier matrix (which stages ask you) + per-agent ask/auto |
| `budgets.yaml` | per-ticket tokens/USD/minutes, daily USD, pipeline budget |
| `naming.yaml`, `masking.yaml`, `policy.yaml`, `rewards.yaml`, `learning.yaml`, `notify.yaml`, `calendar.yaml`, `approvers.yaml` | defaults are sensible; review `masking.yaml` (which production fields agents may ever see) with whoever owns data privacy |

Secrets never go in config: `SFSMITHS_JIRA_TOKEN`, `SFSMITHS_SLACK_WEBHOOK`, `SFSMITHS_CANARY_EMAIL`, `ANTHROPIC_API_KEY` (pipeline mode only) are environment variables.

Run `sfsmiths-human sync` after any config change: it regenerates `.mcp.json` (dev-only `sf-dev` server), the compiled
hook policy, the `model:` line in each agent file, the alias + keychain deny rules in the gitignored `.claude/settings.local.json`
(`.claude/settings.json` itself is static and never rewritten), and the lessons skills.

## 3. The production read-only user (admin, once) — Spike A

SFsmiths reaches production only as this user. Its permissions ARE the boundary. Recipe in
`spikes/A-prod-readonly-user/RECIPE.md`: minimum-access profile, a permission set with object/field **Read** only on the
allowlisted objects/fields from `config/masking.yaml`, *View Setup and Configuration* (for Tooling metadata facts), API
enabled, login IP ranges. Then:

```bash
sfsmiths-human org login --alias Production --keychain agent      # log in AS the read-only user
sfsmiths-human doctor --p1 --fls                                  # #5 identity · #12 FLS vs masking
```

## 4. Keychains

Two sf keychains, deliberately:

| Keychain | HOME | Holds | Who uses it |
|---|---|---|---|
| **agent** | your normal `$HOME` | development sandbox (read-write) + production **read-only user** | agents (through MCP/CLI wrappers), you |
| **engine** | `~/.sfsmiths/engine` | preprod only | the toolkit's privileged steps (baseline retrieve, dry-run validate, preprod test runs) |

```bash
sfsmiths-human org login --alias DevSandbox --keychain agent
sfsmiths-human org login --alias PartialUAT --keychain engine
sfsmiths-human org list
```

Agents cannot switch keychains: `HOME=` / `SF_*` overrides, the engine path, `sf org login/logout` are denied by hooks and static rules.
Your default keychain usually holds more than the configured orgs (other sandboxes, an admin production login): the policy hook
refuses every `sf` target that is not the configured development alias, and `sfsmiths-human sync` writes matching static denies
for each of those orgs (alias + username) into the gitignored `.claude/settings.local.json` — re-run `sync` after any `sf org login/logout`.

## 5. Claude Code pieces

```
# inside a Claude Code session in the repo
/plugin marketplace add .
/plugin install salesforce-development@sfsmiths-pinned
/salesforce-development:setup
```

`sfsmiths-human doctor` checks the plugin is present; `.claude/settings.json` (hooks + permissions) and the agent files
ship with the repo. The three project MCP servers in the generated `.mcp.json` (`sf-dev`, `sfsmiths-evidence`, `sfsmiths-ui`) are
pre-approved by name (`enabledMcpjsonServers` in `.claude/settings.json`), so the first `claude` in the folder only asks the
workspace-trust question. If you ever answered an MCP dialog wrongly: `claude mcp reset-project-choices`. Auto memory stays on (agents keep notes in `.claude/agent-memory/<agent>/MEMORY.md` — unverified until
the coach confirms them).

## 6. Boot conditions — `sfsmiths-human doctor`

`start` refuses to launch while any of these fail: config valid · tools present · dev + evidence in the agent keychain,
preprod NOT there · preprod in the engine keychain · read-only identity (no create/edit/delete) · no admin prod login ·
no Blue Canvas remote reachable by agents · `.mcp.json` consistent · hooks wired + installed copy version · canary fresh
(when requested) · hook latency · FLS mirrors masking · oracle cache · package assets.

## 7. First run — the demo ticket

```bash
cp templates/inbox-ticket.md inbox/DEMO-101.md      # tracker.adapter: file
sfsmiths agent canary --org DevSandbox              # must PASS (NO_SINGLE_MAIL_PERMISSION or NO_MASS_MAIL_PERMISSION) — Setup → Email → Deliverability = No access / System only
sfsmiths-human start
> /ticket DEMO-101
```

Follow the conductor; approve at the gates; when it says deploy, deploy with your tool and mark it
(`sfsmiths-human deployed DEMO-101 --org preprod`). `sfsmiths-human ui` shows everything.

## Phase 0 spikes

Before the first real ticket, run the seven spikes in `spikes/` (README there). They settle every **[U]** in the design:

1. sf-skills coexistence (hard-denied commands vs `Skill` dispatch; SessionStart directive vs CLAUDE.md; LSP tool shape)
2. grounding residual (Tooling rights of the read-only user; describe/FieldDefinition shapes)
3. repro by hand on one old ticket (masking gaps, template fit, Flow test CLI flags)
4. baseline by hand (real drift patterns; engine `HOME` override)
5. email canary result shape in both sandboxes
6. (A) read-only user recipe verified by doctor
7. (B) live hook behaviour: SubagentStop block/cap, Stop cap, `PostToolUse(Agent)` token payload, `memory: project` × `disallowedTools`

Record findings as `spikes/<n>/findings-<date>.md` (gitignored) and decisions in `docs/DECISIONS.md`.

## Uninstall / reset

`rm -rf ~/.sfsmiths` removes the installed toolkit and the engine keychain (log out of preprod first: `HOME=~/.sfsmiths/engine sf org logout -o PartialUAT`).
Runtime state lives in `work/`, `.sfsmiths/`, `metrics/`, `org/.baseline/` — all gitignored.
