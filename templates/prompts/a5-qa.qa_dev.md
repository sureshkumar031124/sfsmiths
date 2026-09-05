Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} · tier {{TIER}} · orgs: {{CONFIG}}
Vault: `{{VAULT}}/` — read `03-plan.md/.json` §6 (test plan), `04-implementation.md/.json`, `02-repro.json`, `git diff` of the change.

Task: run the pyramid in the development sandbox and report with run files.
- Map every planned test to a real test; write the missing ones (bulk 200, meaningful names, org comment format, emails only from: {{ALLOWED_EMAILS}}, tag `{{TAG_FIELD}}` = "{{TAG}}").
- `sfsmiths agent privileged test {{TICKET}} --phase dev [--class …]` → quote `validations/tests-dev.json` (repro PASS, inverse PASS, distribution holds); regression on touched objects; `runAs` for permission paths; UI via `mcp__sfsmiths-ui__*` when the change is visible in Lightning.
- Write `{{VAULT}}/05-test-report.md` + `05-test-report.json` (schema `contracts/test-report`; `verdict` pass|fail — a true `fail` bounces to the developer with your `defects[]`).
Never edit non-test code; never weaken the repro/inverse tests.
{{REJECTION}}
Gates at stop: {{GATES}}. {{NOTE}}
Known facts so far:
{{FACTS}}
