# spikes — Phase 0 (≈3½ days) — run BEFORE the first real ticket

Each folder has a `run.sh` (or a checklist) and a `FINDINGS.template.md`. Copy the template to `findings-<date>.md`
(gitignored), fill it in honestly, then record the decision in `docs/DECISIONS.md`. Everything marked **[U]** in the
design is settled by these spikes; nothing else is.

| # | Spike | Settles | Time |
|---|---|---|---|
| 1 🔴 | sf-skills coexistence | plugin hard-denies vs our subagents' `Skill` dispatch; wrapper not denied; SessionStart directive vs CLAUDE.md; `apex_diagnostics` on a real class | 3 h |
| 2 🟡 | grounding residual | describe shape · FieldDefinition SOQL · metadata-types · Tooling SOQL rights of the **read-only** user | 1 h |
| 3 🟡 | repro by hand | one old, solved ticket through the A2 method by hand: template fit, masking allowlist, time per step | ½ day |
| 4 ⭐ | baseline by hand | how much drift dev↔preprod really has; classification patterns; `retrieve` timings | 2 h |
| 5 ⭐ | email canary | `Messaging.sendEmail(allOrNothing=false)` result shape in **both** sandboxes; Setup → Deliverability screenshot | 1 h |
| A | prod read-only user | admin creates the least-privilege user (recipe in `A-prod-readonly-user/`); doctor #5/#12 pass | admin |
| B 🔴 | hooks + permissions smoke | deny/block/cap behaviours, `PostToolUse(Agent)` payload shape, `memory: project` × `disallowedTools`, latency | 3 h |

Verified already (no spike needed): subagent `tools:` does **not** accept `Bash(pattern)` (docs) — enforcement is
hooks + static denies · `.claude/rules` with `paths:` is documented · marketplace `git-subdir` supports `sha`.
