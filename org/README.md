# org/ — the SFDX project agents work in

- `force-app/` is the **only** place agents write code and metadata. It is baseline-synced from preprod per ticket scope
  (`sfsmiths agent baseline <KEY>`), so what you see here for a scoped component is what preprod has, plus the ticket's change.
- `.baseline/` (gitignored) holds the raw retrieves: `uat/<ts>/`, `dev/<ts>/`, `dev-pre-sync/<ts>/` — evidence for the 3-way classification.
- `sourceApiVersion` in `sfdx-project.json` is what semantic-check compares plans against. Change it deliberately.
- Profiles, settings and credential-bearing metadata are force-ignored: humans manage them through the deploy brief.

Nothing in this folder is company-specific by default; the first `baseline` run fills it from your orgs.
