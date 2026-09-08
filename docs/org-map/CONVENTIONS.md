# CONVENTIONS — sampled from devsbx on 2026-09-08T07:17:13.194Z (DRAFT — review once, then `sfsmiths-human conventions build`)

## Apex header comment (observed in 10/12 recent classes)

```apex
// CaseCloseSolutionPicklists
/**
 * ESD-587 — read-only picklist provider for the [Case] Close Case Screen Flow's
 * "Upstream Solution" / "Solution Sub-Category" pair.
 *
 * WHY THIS CLASS EXISTS. Do not replace it with a UI API wire adapter.
 * Case.Upstream_Solution__c is ITSELF a dependent picklist: valueSet.controllingField
 * = 'Status'. Only 15 of its 19 values carry a valueSettings entry; 'Customer Closed',
 * 'Auto-Close: Central Support', 'Internal Close' and 'Silent Close' carry none, so a
 * Status-aware API never offers them. Measured 2026-08-06: the UI API (and therefore
 * both the getPicklistValues and getPicklistValuesByRecordType wire adapters) returns
 * 15 values on Master/Standard and 0 on Bug / Feature_Request / Task / Idea, because
 * Status 'Closed' / 'Closed-Resolved' exist only in the Standard support process.
// CaseCloseSolutionPicklistsTest
/**
 * ESD-587 tests for CaseCloseSolutionPicklists.
 *
 * The counts below (19 top values, 44 middle values, 9 parents with children) are ORG
 * FACTS read 2026-08-06 from both skumarbox and PartialUAT — the two field
 * definitions are byte-identical. These are not made-up numbers. If any assertion
 * here fails: someone edited the Upstream_Solution__c or
 * Upstream_Solution_Sub_Category__c picklist in Setup, OR the undocumented
 * PicklistEntry.validFor decode in CaseCloseSolutionPicklists broke on a platform
 * release. Read the failure, re-read the field in Setup, update the assertion ON
 * PURPOSE — do not delete it just to make the test pass.
 *
// CaseTypeStamperTest
/***********************************************************************************
* Name          :  CaseTypeStamperTest
*
* Jira          :  ESD-544
*
* Description   :  Tests for CaseTypeStamper.
*
*                  Group A = pure unit tests, NO DML. These call
*                  stampDefaultTypeOnInsert(...) directly on in-memory Case records.
*                  They cannot false-pass because no flow or trigger runs.
*
*                  Group B = integration tests with real DML, through CaseTrigger.
```

## Method documentation
- 20% of public/global methods carry a doc comment (2/10). Standard: every public method gets one.

## Modification log
- 0/12 classes carry a modification/history log. Standard: one line per change with the ticket key, e.g. `// 2026-09-05 SFS-1234 <what changed>`.

## Naming patterns (class suffixes observed)
- *Test: 6
- *Controller: 1
- *Handler: 1
- *Queueable: 1

## Flow naming (recent)
- Case_Close_Case_Screen_Flow
- Case_On_Create
- Screen_Flow_Create_New_Case
- Case_Create_a_Case_Screen_Flow
- Opportunity_Closed_Won_Flow_H2_24
- OCR_Automation
- OCR_Automation_RTF
- Opportunity_Closed_Won_Flow_2024

## Field descriptions
- 77% of custom Case fields have a description. Standard: every custom field/flow/VR gets a description (comment-lint checks it).

## Your decisions (edit here)
- header format:
- modification log line format:
- class/flow/field naming:
- what must never appear in comments:
