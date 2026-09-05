Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · tier {{TIER}}
Vault: `{{VAULT}}/` — `09-retro.md/.json` (toolkit-written), `events.jsonl`, `05-test-report.md`, `06-review.md`, `approvals/*.json`, `.claude/agent-memory/*/MEMORY.md` (quarantined).

Task: coach notes + lesson candidates. `sfsmiths agent learn-digest {{TICKET}}` if `09-retro.md` is missing; then append `## Coach notes` to `{{VAULT}}/09-retro.md` (what went well / what to change, each with event citations) and write candidates to `knowledge/lessons/PENDING/L-<date>-<slug>.md` (frontmatter + evidence refs from events/rewards/human only). Confirmations of existing lessons → `knowledge/lessons/PENDING/CONFIRM-<id>-<date>.md`. No approvals — the human decides.
{{NOTE}}
