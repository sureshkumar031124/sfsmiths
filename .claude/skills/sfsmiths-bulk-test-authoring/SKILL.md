---
name: sfsmiths-bulk-test-authoring
description: How SFsmiths agents write Apex tests that the referee and test-quality gates accept — bulk 200, one behaviour per method, business-meaning assertions, inverse tests, no SeeAllData, runAs for permissions, Flow tests. Use when writing or reviewing any test class.
---

# Bulk test authoring — what a test must look like here

A test in this system is a **referee**: it must fail on the bug and pass on the fix, and its inverse must never change.
`assertion-referee` and `test-quality` gates enforce the mechanics; this skill is the craft.

## Skeleton (match the org's comment format — see the comment-conventions skill)
```apex
/**
 * @description Proves Case escalation assigns the regional queue owner when Priority flips to Critical (bulk-safe).
 * @author SFsmiths a2-repro
 * @date 2026-09-05
 * Modification Log
 * 2026-09-05  <KEY>  created — reproduces missing owner assignment
 */
@IsTest
private class CaseEscalationOwnerAssignmentTest {

    @TestSetup
    static void makeData() {
        // scenario-true names, allowlisted emails, tagged records; 200+ where automation is involved
        List<Case> cases = TestDataFactory.escalatedCases(200, 'Portal login fails after password reset');
        insert cases;
    }

    /** @description FAILS on the bug: owner must be the regional escalation queue after the flip. */
    @IsTest
    static void ownerIsAssignedWhenPriorityBecomesCritical() {
        List<Case> cases = [SELECT Id FROM Case WHERE Test_Tag__c = :TestDataFactory.TAG];
        for (Case c : cases) { c.Priority = 'Critical'; }
        Test.startTest();
        update cases;
        Test.stopTest();
        Integer unassigned = [SELECT COUNT() FROM Case WHERE Id IN :cases AND Owner.Type = 'User'];
        Assert.areEqual(0, unassigned, 'Critical cases must be owned by the regional escalation queue, not a user');
    }

    /** @description INVERSE — must PASS before and after the fix: non-critical cases keep their owner. */
    @IsTest
    static void nonCriticalCasesKeepTheirOwner() { /* … */ }
}
```

## Rules the gates check
- **Assertion in every test method** (`Assert.*` or `System.assert*`); a method without one fails `test-quality`
  (and scores `test_quality.zero_assertion`).
- **No `SeeAllData=true`.** Build the data you need.
- **Bulk**: 200 records through the automation path at least once per behaviour.
- **Inverse test** always exists and is named in `02-repro.json → inverse_tests`.
- **Names**: `WhatItProvesTest` classes, `behaviourUnderCondition` methods. No ticket numbers, no `test1`.
- **Emails/phones** only from the allowlist / fictitious patterns (email-guard scans test classes too).

## Craft
- One behaviour per method; the method name is the sentence a reviewer reads.
- `Test.startTest()/stopTest()` around the action so async work completes and limits reset.
- Assertion messages state the business rule that broke, not "expected true".
- Negative paths: what must be rejected (validation rule message), what must not fire (no email sent → check
  `Limits.getEmailInvocations()` stays 0 when the rule says so).
- Permissions: `System.runAs(leastPrivilegeUser)` for sharing/FLS behaviour; create the user in test with an
  allowlisted email.
- Flows: a record-triggered flow is exercised by the DML in the test; for screen/autolaunched flows use
  `Flow.Interview` or FlowTest metadata (`sf flow run test` via the toolkit's test verb when configured).
- Data factory: prefer/extend the org's existing factory class; constants for the tag and domain.

## Distribution assertions (`work/<KEY>/artifacts/assertions.json`)
```json
[{ "description": "no Critical case owned by a user after fix", "query": "SELECT COUNT() FROM Case WHERE Priority='Critical' AND Owner.Type='User' AND Test_Tag__c='[SFSMITHS KEY]'", "expected": "0" }]
```
Run by `sfsmiths agent privileged test <KEY> --phase dev|uat`; results land in `validations/tests-<phase>.json`.
