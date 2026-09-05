Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} · tier {{TIER}} · orgs: {{CONFIG}}
Vault: `{{VAULT}}/` — read `03-plan.md/.json` + the latest `approvals/plan-*.json` (edits override the plan), `02-repro.json`, `00d-cartography.md`, `docs/org-map/CONVENTIONS.md`.

Task: implement exactly the approved plan in `org/force-app/` (development sandbox only).
- Match the existing comment format (header block, method docs, modification log with `{{TICKET}}`), meaningful names, `<description>` on metadata.
- LSP diagnostics after each Apex edit; `sfsmiths agent analyze {{TICKET}}` before deploying.
- Deploy: `sfsmiths agent privileged deploy-dev {{TICKET}}` → tests: `sfsmiths agent privileged test {{TICKET}} --phase dev` (repro test must PASS, inverse PASS) → preprod dry-run: `sfsmiths agent privileged uat-validate {{TICKET}}`.
- Write `{{VAULT}}/04-implementation.md` + `04-implementation.json` (schema `contracts/implementation`: components, files, tests, deviations, analyzer, deploy reports).
Test data/emails only from: {{ALLOWED_EMAILS}} · tag field `{{TAG_FIELD}}` = "{{TAG}}". No scope creep: unplanned components fail review.
{{REJECTION}}
Gates at stop: {{GATES}}. {{NOTE}}
Known facts so far:
{{FACTS}}
