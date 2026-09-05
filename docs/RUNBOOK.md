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
| deploy to preprod | read `06b-deploy-brief.md`, deploy with Blue Canvas / your tool, then `sfsmiths-human deployed KEY --org preprod` |
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
- `sfsmiths-human orgmap` (nightly) refreshes `docs/org-map/`; review `CONVENTIONS.md` once, then `sfsmiths-human conventions build --prefix <yourorg>` generates the org-specific comment/naming skills.
- `sfsmiths-human mirror` refreshes the official docs mirror (grounding L2).

## When something is wrong

| Symptom | Where to look | Fix |
|---|---|---|
| `start` refuses | doctor output | fix the named boot condition; `--force` is for emergencies only |
| an agent is denied constantly (`policy.denied` events) | `work/KEY/events.jsonl`, UI → Safety tile | it is trying the wrong thing; read the reason; if a legitimate path is missing, add a toolkit verb — never widen the hook |
| stage keeps failing gates | `work/KEY/validations/<stage>-<gate>.json` | the reason is mechanical; fix the artifact or the config the gate reads |
| conductor loops / stops early | Stop hook blocks (8-cap → `waiting_human`) | `sfsmiths agent handoff KEY` by hand to see the state; `/resume` |
| budget parked | `manifest.yaml → budget` | raise `config/budgets.yaml` or `/resume KEY --allow-budget` |
| canary FAIL | `.sfsmiths/canary/<org>.json` | Setup → Email → Deliverability → *No access* (or *System email only*); rerun `sfsmiths agent canary` |
| preprod validate fails | `validations/uat-validate.json` | usually drift preprod↔dev outside scope → widen scope (`sfsmiths agent scope set`) and rerun baseline |
| hooks not firing | `claude --debug`, `sfsmiths-human doctor` #9 | installed copy missing/outdated → `npm run install:toolkit`; PATH |
| UI shows config errors | Config tab | fix YAML; every save is schema-validated |

Escape hatches (human, documented, audited): `SFSMITHS_HOOKS_OFF=1` disables the SFsmiths hooks for a session;
`claude --settings disableAllHooks` disables all hooks; both leave the identity-level protections (read-only user,
keychain split) in place.

## Maintenance procedures

### Adding an org
UI → Orgs → Add, or `sfsmiths-human org add --alias X --role development|preprod|evidence` → `org login` → `doctor`.
Preprod orgs always live in the engine keychain; evidence orgs need a read-only user.

### Changing models or gate modes
UI → Agents, or edit `config/models.yaml` / `config/autonomy.yaml` → `sfsmiths-human sync`. Takes effect in the next session.
Run the golden set after a model change: `sfsmiths-human golden list|score`.

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
Never edit by hand: `work/**/manifest.yaml`, `.state.json`, `events.jsonl`, `validations/`, `approvals/`, `.mcp.json`, `.sfsmiths/`.
