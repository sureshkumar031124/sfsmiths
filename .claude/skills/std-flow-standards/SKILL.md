---
name: std-flow-standards
description: Generic Flow standards for SFsmiths agents — when to use before-save vs after-save vs Apex, one flow per object per context, entry conditions, fault paths, bulk safety, descriptions, versioning, Flow tests. Use when planning, building or reviewing a Flow; check Example/Flows for known-good XML first.
---

# Flow standards (generic baseline)

## Choose the layer
| Need | Use |
|---|---|
| Set/derive fields on the same record | **Before-save** record-triggered flow (fast, no DML, no callouts, no related records) |
| Create/update related records, send notifications, call subflows | **After-save** record-triggered flow |
| Complex logic, bulk-heavy, cross-object transactions, callouts with error handling | **Apex** (via the trigger framework) |
| User interaction | Screen flow (entry from Quick Action / Lightning page) |

Never both a flow and a trigger doing the same thing on the same object; the plan states which layer owns the behaviour.

## Structure
- One record-triggered flow per object per context (before / after), with **decision-per-use-case** inside — unless the org
  convention differs (check `docs/org-map/CONVENTIONS.md`).
- **Entry conditions** on the trigger (formula or conditions) so the flow only runs when relevant — required for bulk safety.
- **Fault paths** on every Create/Update/Delete/Get and every Action; the fault path logs (Custom Object / Platform Event
  per org standard) and never silently swallows.
- No Get Records / DML inside loops — collect, then one DML. No "Update Records" of the triggering record in after-save
  when a before-save assignment does the job.
- Async path (`Run Asynchronously`) for callouts and long work.
- `<description>` on the flow **and** on every element that is not self-evident. `comment-lint` fails flows without a description.
- Naming: `Object_Context_WhatItDoes` (e.g. `Case_AfterSave_AssignEscalationOwner`) or the org's pattern (`config/naming.yaml`).
- API version = `org/sfdx-project.json` `sourceApiVersion`.
- Never delete flow versions in the repo history; deactivate via metadata (`<status>Obsolete</status>`) when replacing.

## Known-good XML
Start from `Example/Flows/*.flow-meta.xml` when it exists (formatting, element ordering, connectors). Copy the shape,
not the logic.

## Testing
- Record-triggered flows: Apex tests exercising the DML path (bulk 200), asserting the resulting field values.
- Autolaunched/screen flows: Flow Tests (`FlowTest` metadata) where the CLI supports them (`sf flow run test`), or
  `Flow.Interview.createInterview(...)` in Apex.
- Assert the **absence** of side effects too (no email invocations when the rule says none).

## Review points
entry conditions present · fault paths everywhere · no DML in loops · description present · layer correct ·
no duplicate automation · kill switch / bypass honoured · bulk test present.
