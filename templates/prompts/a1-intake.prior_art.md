Ticket **{{TICKET}}** — "{{TITLE}}" · stage `{{STAGE}}` ({{STAGE_TITLE}}) · attempt {{ATTEMPT}} · tier {{TIER}} · orgs: {{CONFIG}}
Vault: `{{VAULT}}/`

Task: build the prior-art digest.
1. `sfsmiths agent prior-art {{TICKET}}` → read `{{VAULT}}/00c-prior-art.index.json`.
2. Read the related vaults it points to (intake, plan, retro) and the matching lessons.
3. Write `{{VAULT}}/00c-prior-art.md` and `{{VAULT}}/00c-prior-art.json` (schema `contracts/prior-art`): for each item — what, how solved, retro verdict, **how it applies here** (reuse / warning / irrelevant). "Nothing relevant" with the searched keywords is a valid result.
Gates at stop: {{GATES}}. {{NOTE}}
Known facts so far:
{{FACTS}}
