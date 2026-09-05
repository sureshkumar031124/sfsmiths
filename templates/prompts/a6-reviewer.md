Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} · tier {{TIER}} · orgs: {{CONFIG}}
Vault: `{{VAULT}}/` — diff: read `flags.baseline_commit` in `{{VAULT}}/manifest.yaml`, then `git diff <that sha>..HEAD -- org/force-app tests-ui`; read `03-plan.md/.json` + approvals, `01-intake.md`, `02-repro.json`, `04-implementation.md/.json`, `05-test-report.md/.json`, `00d-cartography.md`, `00b-baseline.json`, `config/calendar.yaml`.

Task: fresh-eyes review (read-only) + deploy brief.
- `sfsmiths agent analyze {{TICKET}}` (or read `validations/analyzer.json`) and `sfsmiths agent gate security {{TICKET}} --stage review` for detection; you judge.
- Write `{{VAULT}}/06-review.md` (nine dimensions with ✅/⚠️/❌ and evidence; verdict APPROVE / APPROVE WITH NITS / REQUEST CHANGES), `{{VAULT}}/06-review.json` (schema `contracts/review`; `security.crud_fls` and `security.sharing` stated), and `{{VAULT}}/06b-deploy-brief.md` (skill `sfsmiths-deploy-brief`).
If your model alias equals the developer's, write the "same-alias review" warning first.
{{REJECTION}}
Gates at stop: {{GATES}}. {{NOTE}}
