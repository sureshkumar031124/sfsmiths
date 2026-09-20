# SFsmiths — Runbook (daily operations)

## A normal day

```
sfsmiths-human doctor                 # 30 s — green? go
sfsmiths-human start                  # conductor session
> /ticket PROJ-123                    # …intake → you approve (HIGH) → … plan → you approve with --answer → …
> /status
sfsmiths-human ui                     # in another terminal: watch, approve, edit config
```

When the conductor says **WAIT_HUMAN**:

| It says | You do |
|---|---|
| approval at `intake` / `plan` / `review` | read the file it names (`work/KEY/01-intake.md`, `03-plan.md`, `06-review.md`), then `/approve KEY [--answer "what you checked"]` or `/reject KEY --reason "…"` (UI buttons do the same) |
| baseline decision | `sfsmiths-human baseline decide KEY --keep-dev Type:Name --take-uat Type:Name` (or `--all-take-uat`) |
| deploy to preprod | read `06b-deploy-brief.md`, select **exactly** the components in `06c-deploy-manifest.md` (`artifacts/package.xml`) in Blue Canvas / your tool, deploy, then `sfsmiths-human deployed KEY --org preprod`. The toolkit then retrieves those components from preprod and compares fingerprints (`07a-uat-parity.md`). MISSING / DIFFERENT → it comes back to you with the list: fix the set and run `deployed` again. NOT VERIFIED (retrieve failed) → fix the cause and run `deployed` again, or — if you verified the deploy another way — `sfsmiths-human parity KEY --accept-all --reason "…"` (recorded) |
| deploy to production | same, `--org production`; the toolkit then runs the read-only verification queries from the plan |
| remediation | run `work/KEY/artifacts/remediation/*.apex` yourself in production, then `sfsmiths-human verify KEY --remediation` |
| question / escalation | read the ESCALATION block in the stage file; answer in the session, or `/hold`, or `/resume KEY --restart-from <stage>` |

`/hold KEY --reason "…"` pauses (locks released). `/resume KEY` re-fetches the tracker, classifies the change
(comments only → continue; description/AC changed → intake re-runs; scope changed → restart from baseline; cancelled → archive),
detects a sandbox refresh, re-checks the baseline.

## Weekly

- `sfsmiths-human learn` (or nightly cron) → `knowledge/DIGEST-<date>.md`; `sfsmiths-human lessons review` → approve/reject with reasons.
- `sfsmiths-human rewards --tokens` — points and spend per agent; the Agents screen in the UI shows the same.
- `sfsmiths-human memory audit` — flags agent notes that contradict events.
- `sfsmiths-human orgmap` (nightly) refreshes `docs/org-map/` (gitignored — it carries your org id and every component name); review `CONVENTIONS.md` once, then `sfsmiths-human conventions build --prefix <yourorg>` generates the org-specific comment/naming skills **and wires them into the agents** (D-096; `sync` keeps them wired).
- `sfsmiths-human mirror` refreshes the official docs mirror (grounding L2) — trusted Salesforce domains only (P12). Notes from MVPs / practitioners: file them in `knowledge/curated/` with the provenance frontmatter (`knowledge/curated/README.md`).
- UI → **Safety**: review the allowed test e-mail list and the delivery mode; the last canary and, in `allowlist_only` mode, the census counts are shown there.

## When something is wrong

| Symptom | Where to look | Fix |
|---|---|---|
| `start` refuses | doctor output | fix the named boot condition; `--force` is for emergencies only |
| an agent is denied constantly (`policy.denied` events) | `work/KEY/events.jsonl`, UI → Safety tile | it is trying the wrong thing; read the reason; if a legitimate path is missing, add a toolkit verb — never widen the hook |
| stage keeps failing gates | `work/KEY/validations/<stage>-<gate>.json` | the reason is mechanical; fix the artifact or the config the gate reads |
| conductor loops / stops early | Stop hook blocks (8-cap → `waiting_human`) | `sfsmiths agent handoff KEY` by hand to see the state; `/resume` |
| handoff keeps saying `WAIT_AGENT` | `work/KEY/manifest.yaml → stages.<stage>.agent_waits` | the stage's agent has not reported back. Normal while it works; after 8 waits the stage fails honestly. If it never reports, the agent was spawned in the background (denied since D-093) or died — `/resume KEY` first: if its gates now pass, the stage is recovered without a re-run |
| a stage failed but its output looks complete | `work/KEY/validations/` | `/resume KEY` re-runs that stage's gates; all passing means the stage is marked done with no agent re-run (D-093 recovery). `--restart-from` skips recovery and forces the re-run |
| budget parked | `manifest.yaml → budget` | raise `config/budgets.yaml` or `/resume KEY --allow-budget` |
| canary FAIL | `.sfsmiths/canary/<org>.json`, UI → Safety | `blocked` mode: Setup → Email → Deliverability → *No access* (or *System email only*); rerun `sfsmiths agent canary`. `allowlist_only` mode: the census found addresses outside the allowlist — the UI shows which fields and how many; scrub them (or switch to `blocked`) |
| canary stale (doctor #10 WARN) | UI → Safety | a PASS older than `canary_max_age_minutes` is not accepted by the data-guard hook — rerun `sfsmiths agent canary --org <dev>` before a2/a5 create data |
| `uat_verify` keeps sending the ticket back | `work/KEY/07a-uat-parity.md` | the deploy set in your tool does not match `06c-deploy-manifest.md`; a cosmetic DIFFERENT (e.g. the tool rewrote the api version) can be accepted with `sfsmiths-human parity KEY --accept Type:Name --reason "…"` |
| doctor #17 FAIL (knowledge sources) | `knowledge/mirror/sources.yaml` | a mirror source is not on a Salesforce documentation domain — remove it; expert articles go to `knowledge/curated/` with `source_url`, `author`, `trust` |
| preprod validate fails | `validations/uat-validate.json` | usually drift preprod↔dev outside scope → widen scope (`sfsmiths agent scope set`) and rerun baseline |
| hooks not firing | `claude --debug`, `sfsmiths-human doctor` #9 | installed copy missing/outdated → `npm run install:toolkit`; PATH |
| UI shows config errors | Config tab | fix YAML; every save is schema-validated |

Escape hatches (human, documented, audited): `SFSMITHS_HOOKS_OFF=1` disables the SFsmiths hooks for a session;
`claude --settings disableAllHooks` disables all hooks; both leave the identity-level protections (read-only user,
keychain split) in place.

## Maintenance procedures

### Editing the allowed test e-mails / delivery mode (D-102)
UI → Safety: add or remove addresses and patterns, pick `blocked` (default — the canary must prove the org refuses to send)
or `allowlist_only` (delivery may be ON; the canary's census must find no address outside the list in `email_census_fields`).
Saving writes `config/safety.yaml` (schema-validated). Agents read the list on their next data step; the mode applies on the
next `sfsmiths agent canary` run.

### Adding an org
UI → Orgs → Add, or `sfsmiths-human org add --alias X --role development|preprod|evidence` → `org login` → `doctor`.
Preprod orgs always live in the engine keychain; evidence orgs need a read-only user.

### Changing models, reasoning effort or gate modes
UI → Agents, or edit `config/models.yaml` / `config/autonomy.yaml` → `sfsmiths-human sync`. Takes effect in the next session.
Run the golden set after a model **or effort** change: `sfsmiths-human golden list|score`.

**Effort** (D-095) is `low | medium | high | xhigh | max | inherit` per agent. `sync` writes it into the `effort:` line of
each agent file (`inherit` removes the line, so the session level applies). One gotcha worth knowing:
`CLAUDE_CODE_EFFORT_LEVEL` in your environment **overrides agent frontmatter** — if it is set, every per-agent value is
ignored. `sfsmiths-human doctor` #15 reports the effective levels and warns about that variable; `sfsmiths-human start
--effort <level>` sets one for the conductor session only. Effort is recorded with every run in
`metrics/agent-runs.jsonl`, so a token or cost number can be interpreted afterwards.

### Reading token and cost numbers
`tokens` in the manifest is the raw total **including cache reads**; `fresh_tokens` (input + output + cache_creation) is
what the per-ticket token budget is judged on, because a cache read is a re-read of context already paid for at roughly a
tenth of the price (D-094). The UI shows both columns. Costs come from `config/budgets.yaml → prices`
(or `metrics/prices.json`, which overrides it) — review those numbers against your own plan; doctor #16 warns when a
model you actually run has no price entry, because such runs record no cost at all.

### Bumping the sf-skills pin
See `.claude-plugin/README.md`. Read the upstream diff, run Spike 1, update `sha` + `version`, `/plugin update`, `doctor`, note in `docs/DECISIONS.md`.

### Upgrading the toolkit
`git pull` → `npm ci && npm run build && npm test` → `npm run install:toolkit` → `sfsmiths-human sync && sfsmiths-human doctor`.

### Sealing a golden ticket
After a ticket closes cleanly: `sfsmiths-human golden add KEY`. Replays: Phase 3 (pipeline mode).

### Pipeline mode (Phase 3, API key)
`ANTHROPIC_API_KEY=… sfsmiths-human run KEY` runs `claude -p … --agent conductor` in a resume loop with
`--max-budget-usd`; stops at every human gate. Your own plan token is a licence gray zone for unattended batch use —
`--allow-oauth` exists but read the note first.

## Files you may edit by hand

`config/*.yaml` (then `sync`) · `knowledge/checklists/*.yaml` · `knowledge/guards/*.txt` · `knowledge/curated/*` ·
`knowledge/lessons/L-*.md` (then `learn sync`) · `templates/**` · `Example/Flows/*` · `docs/**` · `.claude/agents/*.md`,
`.claude/skills/**` (except generated `lessons-*` and `<prefix>-*`), `.claude/rules/*`, `CLAUDE.md`.
Never edit by hand: `work/**/manifest.yaml`, `.state.json`, `events.jsonl`, `validations/`, `approvals/`, `06c-deploy-manifest.*`, `07a-uat-parity.md`, `.mcp.json`, `.sfsmiths/`.
