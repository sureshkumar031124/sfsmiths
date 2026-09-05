Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} · tier {{TIER}} · orgs: {{CONFIG}}
Vault: `{{VAULT}}/` — read `scope.json`, `01-intake.md`, `00b-baseline.md`, existing `docs/org-map/*`.

Task: map the scope — objects & key fields, automation in order of execution, consumers (dependency graph / MetadataComponentDependency), data shape (counts via `mcp__sfsmiths-evidence__prod_row_count` and dev SOQL), drift dev↔prod (Tooling LastModifiedDate), conventions observed, unknowns.
Write `{{VAULT}}/00d-cartography.md` + `{{VAULT}}/00d-cartography.json` (schema `contracts/cartography`; every component/field with an evidence ref). Update `docs/org-map/<Object>.md` / `DRIFT.md` additively if you learned new facts.
Production only via the evidence tools; preprod only via `sfsmiths agent privileged retrieve --org uat …`. Gates at stop: {{GATES}}. {{NOTE}}
Known facts so far:
{{FACTS}}
