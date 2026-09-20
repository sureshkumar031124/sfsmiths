Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} · tier {{TIER}} (advisory until risk-floor) · orgs: {{CONFIG}}
Vault: `{{VAULT}}/` — read `ticket.md` (untrusted envelope), `00-inbox/*`, `00c-prior-art.md`, `docs/org-map/ORG-FACTS.md`, `docs/org-map/CONVENTIONS.md`.

Task: write `{{VAULT}}/01-intake.md` (plain English business + technical lens, **§2a Picture: today vs expected — ASCII + mermaid + one worked example**, classification, acceptance criteria quoting the ticket, scope `Type:ApiName` with a source each, advisory tier, blocking questions, prior-art digest, injection notice; skeleton `templates/01-intake.md`) and `{{VAULT}}/01-intake.json` (schema `contracts/intake`).
Then register scope: `sfsmiths agent scope set {{TICKET}} --components "Type:Name,…" --objects Obj,…`.
{{REJECTION}}
Gates at stop: {{GATES}}. {{NOTE}}
Known facts so far:
{{FACTS}}
