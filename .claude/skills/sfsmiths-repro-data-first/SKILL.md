---
name: sfsmiths-repro-data-first
description: How A2 (and A5) build reproduction test data in the development sandbox — masked production evidence first, then meaningful, tagged, safe-email records created through an anonymous Apex script run by the toolkit. Use before creating any record in an org.
---

# Repro data, the SFsmiths way ("data first")

A bug lives in **data shapes**, not in code alone. Reproduce the shape, then the bug appears by itself.

## 1. Look at production — through the mask
```
mcp__sfsmiths-evidence__prod_row_count  { object: "Case", where: "Status = 'Escalated' AND OwnerId = null", purpose: "…", ticket: "<KEY>" }
mcp__sfsmiths-evidence__prod_soql       { query: "SELECT Status, Origin, RecordType.Name, COUNT(Id) c FROM Case WHERE CreatedDate = LAST_N_DAYS:30 GROUP BY Status, Origin, RecordType.Name", purpose: "…", ticket: "<KEY>" }
```
Prefer aggregates. When you need row shapes, ask for the allowlisted fields only; you receive masked values and a
path under `work/<KEY>/evidence/` — that path is your citation (`source: L3`). Refusals (field not allowlisted) are
final: write the gap into your report and work with what you have.

## 2. Design the records
- **Minimal but bulk-honest**: if a trigger/flow is involved, the failing test must run with ≥ 200 records.
- **Meaningful names**: `Account.Name = "Northwind Escalation Rollout"`, `Case.Subject = "Portal login fails after password reset"`.
  Never `Test1`, `PROJ-1234 Case`, `asdf`. naming-lint checks names and the tag field.
- **Tag every record** in the test-tag field (`config/safety.yaml → test_tag_field`, default `Test_Tag__c`) with the tag
  from your stage prompt (`[SFSMITHS <KEY>]`). Cleanup and audits key on it.
- **Emails**: only from `allowed_test_emails` (default `*@example.com`, `*@example.org`, `*.invalid`, `*@sfsmiths.invalid`).
  Build them from the scenario: `rollout.manager@example.com`. Same for phone numbers — use fictitious patterns.
- **Users**: never create real people; use existing test users or `runAs` in tests. Never change a real user's email.
- **Files/attachments**: tiny generated content only.

## 3. Create them with a script the toolkit runs
Write `work/<KEY>/artifacts/repro-data.apex` from `templates/repro-data.apex`, then:
```
sfsmiths agent privileged apex-run <KEY> --file work/<KEY>/artifacts/repro-data.apex
```
The toolkit refuses if the email canary is missing/stale/failed (P9 layer 1), scans the script for non-allowlisted
addresses (layer 2), runs it in the development sandbox only (layer 3), and logs the result under `validations/`.
Print the created ids at the end of the script (`System.debug(JSON.serialize(ids))`) and copy them into `02-repro.md`.

## 4. Prove the bug
Write the failing Apex test (see `sfsmiths-bulk-test-authoring`) and run
`sfsmiths agent privileged test <KEY> --phase repro`. `assertion-referee` expects: failing test → **Fail**, inverse → **Pass**.

## What never happens
- Creating data by hand in the UI without a script (not repeatable, not scannable).
- `sf data create record … -o <anything but dev>` — denied.
- Copying production values (names, emails, phones) into dev — even masked ones. Invent scenario-true values.
- "Fixing" data to make the test pass. Data reproduces; code fixes (A4).
