Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} · tier {{TIER}} · orgs: {{CONFIG}}
Vault: `{{VAULT}}/` — read `01-intake.md/.json`, `02-repro.md/.json`, `00d-cartography.md`, `00b-baseline.md`, `00c-prior-art.md`; checklists in `knowledge/checklists/*.yaml`.

Task: the grounded fix plan.
1. `sfsmiths agent cache freshen {{TICKET}}`; retrieve/read every component you will touch; confirm every field in the describe cache or via `mcp__sfsmiths-evidence__prod_describe`.
2. Write `{{VAULT}}/03-plan.md` — nine sections (root cause · components · order of execution & side effects · consumers & blast radius · bulk & limits · tests · rollback & kill switch · remediation · options + unknowns + checklist answers) — and `{{VAULT}}/03-plan.json` (schema `contracts/plan`). New names → `action: create` and `config/naming.yaml`-compliant.
3. Self-check: `sfsmiths agent gate plan-lint {{TICKET}} --stage plan`, `… semantic-check …`, `… checklist …`, `… contract-check …`.
Tier {{TIER}}: keep §1, §7, §8 short enough for a two-minute human check.
{{REJECTION}}
Gates at stop: {{GATES}}. {{NOTE}}
Known facts so far:
{{FACTS}}
