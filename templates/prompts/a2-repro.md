Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} of 2 · tier {{TIER}} · orgs: {{CONFIG}}
Vault: `{{VAULT}}/` — read `01-intake.md/.json`, `00b-baseline.md`, `00d-cartography.md`, `00c-prior-art.md`.

Task: prove the bug with a failing assertion (data first).
- Production evidence: `mcp__sfsmiths-evidence__prod_row_count` / `prod_soql` with `ticket: "{{TICKET}}"` and a real purpose.
- Dev data: script `{{VAULT}}/artifacts/repro-data.apex` (from `templates/repro-data.apex`), meaningful names, every record `{{TAG_FIELD}} = "{{TAG}}"`, emails ONLY from: {{ALLOWED_EMAILS}}. Run it with `sfsmiths agent privileged apex-run {{TICKET}} --file {{VAULT}}/artifacts/repro-data.apex`.
- Tests: failing test (must FAIL now) + inverse test (must PASS) under `org/force-app/main/default/classes/`, bulk 200, org comment format. Distribution assertions in `{{VAULT}}/artifacts/assertions.json`.
- `sfsmiths agent privileged test {{TICKET}} --phase repro` → check `validations/tests-repro.json`.
- Write `{{VAULT}}/02-repro.md` + `02-repro.json` (schema `contracts/repro`: failing_tests, inverse_tests, predicted_distribution, data_created, evidence, root_cause_hypothesis, confidence).
If this is attempt 2 and no honest failing assertion exists → write the ESCALATION block (skill `sfsmiths-escalation-format`) instead of forcing one.
{{REJECTION}}
Gates at stop: {{GATES}}. {{NOTE}}
Known facts so far:
{{FACTS}}
