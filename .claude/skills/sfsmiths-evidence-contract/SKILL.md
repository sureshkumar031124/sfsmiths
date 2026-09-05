---
name: sfsmiths-evidence-contract
description: How to write the JSON contract that accompanies every SFsmiths stage file (NN-*.json) so contract-check passes — schema location, the evidence reference shape, which refs must resolve to real files, and the per-stage required fields. Use whenever you write a stage output.
---

# Stage contracts — the JSON next to your markdown

Every agent stage produces a markdown file for humans and a JSON file for the gates. `contract-check` validates the
JSON against `schemas/contracts/<name>.schema.json` and verifies that evidence refs which look like files exist.

| Stage | Markdown | JSON | Schema |
|---|---|---|---|
| prior_art | `00c-prior-art.md` | `00c-prior-art.json` | `prior-art` |
| intake | `01-intake.md` | `01-intake.json` | `intake` |
| cartography | `00d-cartography.md` | `00d-cartography.json` | `cartography` |
| repro | `02-repro.md` | `02-repro.json` | `repro` |
| plan | `03-plan.md` | `03-plan.json` | `plan` |
| develop | `04-implementation.md` | `04-implementation.json` | `implementation` |
| qa_dev / qa_uat | `05-test-report.md` / `07-uat-report.md` | `05-test-report.json` / `07-uat-report.json` | `test-report` |
| review | `06-review.md` | `06-review.json` | `review` |
| comms | `10-comms/README.md` | `10-comms/index.json` | `comms` |

Read the schema before writing (`Read schemas/contracts/<name>.schema.json`). `additionalProperties` is allowed in most
schemas, so you may add fields — but required ones must be present with the right types.

## The evidence reference
```json
{ "source": "L1", "ref": "org/force-app/main/default/classes/CaseEscalationOwnerService.cls:42", "verified_at": "2026-09-05T10:12:00Z" }
```
`source` ∈ `L0 L1 L2 L3 L4 vault tracker git human`. Rules:
- `vault`, `L2` and `git` refs that look like file paths **must exist** (relative to the vault or the repo root).
- `L3` refs point to `evidence/*.json` written by the evidence server.
- `L4` refs point to `ui/*.png` or `ui/REPORT.md`.
- `human` refs point to `approvals/*.json`.
- A claim with no evidence is either dropped or moved to `unknowns[]` with a reason. Empty arrays are honest; invented refs are the worst thing you can do here.

## Minimal examples

**intake**
```json
{ "classification": "BUG", "summary": "…", "acceptance_criteria": [{ "id": "AC1", "text": "…", "source": "ticket.md#L12" }],
  "scope": [{ "type": "ApexClass", "api_name": "CaseEscalationOwnerService", "evidence": { "source": "L0", "ref": "ticket.md#L20" } }],
  "objects": ["Case"], "touches": ["apex", "email"], "suggested_tier": "HIGH", "keywords": ["escalation", "owner"], "questions": [] }
```
**repro**
```json
{ "failing_tests": ["CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical"],
  "inverse_tests": ["CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner"],
  "predicted_distribution": [{ "description": "…", "query": "SELECT COUNT() …", "expected": "0" }],
  "data_created": [{ "object": "Case", "count": 200, "tag": "[SFSMITHS KEY-1]" }],
  "root_cause_hypothesis": "…", "confidence": 0.7,
  "evidence": [{ "source": "L3", "ref": "evidence/prod-soql-20260905-101200.json" }] }
```
**test-report**
```json
{ "tests": [{ "name": "CaseEscalationOwnerAssignmentTest.ownerIsAssigned…", "layer": "apex", "outcome": "Pass", "run_file": "validations/tests-dev.json" }],
  "defects": [], "coverage": 91, "verdict": "pass", "evidence": [{ "source": "vault", "ref": "validations/tests-dev.json" }] }
```

## Before you stop
```
sfsmiths agent gate contract-check <KEY> --stage <stage>
```
If it fails, the reason names the field. Fix the JSON; do not pad it.
