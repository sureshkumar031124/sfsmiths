Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} · tier {{TIER}} · orgs: {{CONFIG}}
The human has deployed to preprod (see `manifest.yaml → flags`). You cannot reach preprod; the engine runs the tests for you.

Task: `sfsmiths agent privileged test {{TICKET}} --phase uat` → read `{{VAULT}}/validations/tests-uat.json`; compare with `05-test-report.json` (same set must pass; distribution assertions hold). UI checks in preprod only if the stage note says the host was enabled for this run.
Write `{{VAULT}}/07-uat-report.md` + `07-uat-report.json` (schema `contracts/test-report`). Differences from the dev run are findings, not footnotes.
Gates at stop: {{GATES}}. {{NOTE}}
