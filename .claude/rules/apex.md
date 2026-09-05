---
paths:
  - "org/force-app/**/*.cls"
  - "org/force-app/**/*.trigger"
---

# Apex files in this repo

- Match the file's existing comment format exactly (header doc block, method docs, modification log with the ticket key). `comment-lint` fails otherwise. Details: skill `std-comment-conventions` (or the org's `*-comment-conventions` skill when present).
- Names describe behaviour; no ticket numbers in class/method names (`std-naming-rules`, `config/naming.yaml`).
- `with sharing` by default; bind variables only; no hard-coded ids/emails/URLs; no SOQL/DML in loops; one trigger per object through the handler framework (`std-trigger-framework`).
- Tests: bulk 200, an assertion in every method, no `SeeAllData`, inverse tests kept intact (`sfsmiths-bulk-test-authoring`).
- Only the development sandbox may receive this code from an agent (`sfsmiths agent privileged deploy-dev`); preprod/production deploys are the human's.
