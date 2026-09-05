---
name: std-naming-rules
description: Generic naming rules SFsmiths agents apply to every new component, field, flow, test class and test record when the org has not generated its own <prefix>-naming-rules skill — names say what a thing does, never carry the ticket number; naming-lint enforces config/naming.yaml. Use when creating or renaming anything.
---

# Naming rules (generic — `config/naming.yaml` is the enforced source; an org-specific skill overrides this text)

## The one rule
**A name says what the thing does or is.** The ticket key never goes into a name; it goes into the comment
modification log and the test-data tag field. `naming-lint` fails ticket-only names (`Fix1234`, `PROJ1234Class`,
`Test_PROJ_1234`) and names below the minimum word count.

## Patterns (defaults from `config/naming.yaml`; the org's file may differ — read it)
| Kind | Pattern | Good | Bad |
|---|---|---|---|
| Apex class | `UpperCamel`, ≥ 2 words, role suffix (`Service`, `Selector`, `Handler`, `Guard`, `Batch`, `Queueable`, `Controller`) | `CaseAutoCloseGuard`, `OpportunityLineItemService` | `TempClass`, `Fix1234` |
| Apex test class | class name + `Test` | `CaseAutoCloseGuardTest` | `Test1234` |
| Trigger | `<Object>Trigger` (one per object) | `CaseTrigger` | `CaseTrigger2` |
| Flow | `Object_Context_WhatItDoes` (`_`-separated, 2–7 parts) | `Case_AfterSave_RecentReplyGuard` | `Flow_1234` |
| Custom field | `Meaningful_Words__c`, ≥ 1 real word | `Last_Customer_Reply_At__c` | `Field1__c` |
| Validation rule | `Object_Condition_Statement` | `Case_Cannot_Close_With_Open_Tasks` | `VR1` |
| Permission set | `Role_Or_Capability` | `Support_Escalation_Manager` | `PS_1234` |
| Test record names/subjects | ≥ 3 words, scenario-true, ≥ 12 chars | `Escalated case with recent reply — auto-close repro` | `Test`, `record 1` |
| Test methods | `behaviourUnderCondition` | `ownerIsAssignedWhenPriorityBecomesCritical` | `test1`, `testMethod` |

## Also
- Match the org's existing suffix vocabulary (see `docs/org-map/CONVENTIONS.md → Naming patterns`) before inventing one.
- Labels are for humans (spaces, capitalisation); API names follow the patterns above.
- Never rename existing components as part of a fix unless the plan says so (blast radius).
- Custom Metadata records, Custom Labels and Static Resources follow the same "what it is" rule.

## Self-check
`sfsmiths agent gate naming-lint <KEY> --stage <stage>` — run it before you finish a stage that created anything.
