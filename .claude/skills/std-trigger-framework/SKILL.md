---
name: std-trigger-framework
description: How SFsmiths agents work with triggers — discover and reuse the org's existing trigger framework first (one trigger per object, handler class, bypass switch), and only if none exists follow this generic handler pattern. Use when a plan or change touches a trigger or record-triggered automation.
---

# Trigger framework — reuse first, this pattern second

## Step 1 — find what the org already has
```
grep -rl "trigger " org/force-app/main/default/triggers | head
grep -rn "TriggerHandler\|TriggerDispatcher\|TriggerFramework\|fflib_SObjectDomain\|Bypass" org/force-app/main/default/classes --include=*.cls -l | head
```
Read the handler base class and one existing handler end-to-end. Note: how a handler registers, how contexts are
dispatched (`beforeInsert`, `afterUpdate` …), how recursion is prevented, how bypass works (Custom Setting /
Custom Permission / static flag), how the handler is tested. **Record these in `00d-cartography.md §6` and follow them.**

## Step 2 — one trigger per object, no logic in the trigger
```apex
trigger CaseTrigger on Case (before insert, before update, after insert, after update) {
    new CaseTriggerHandler().run();   // or the org's dispatcher call — copy it exactly
}
```
If the object already has a trigger, **extend its handler**; never add a second trigger.

## Step 3 — generic handler shape (only when the org has none)
```apex
public inherited sharing virtual class TriggerHandler {
    private static Set<String> bypassed = new Set<String>();
    public void run() {
        if (bypassed.contains(handlerName()) || isDisabledBySetting()) return;
        switch on Trigger.operationType {
            when BEFORE_INSERT { beforeInsert(); } when BEFORE_UPDATE { beforeUpdate(); }
            when AFTER_INSERT  { afterInsert(); }  when AFTER_UPDATE  { afterUpdate(); }
            when BEFORE_DELETE { beforeDelete(); } when AFTER_DELETE  { afterDelete(); } when AFTER_UNDELETE { afterUndelete(); }
        }
    }
    protected virtual void beforeInsert() {} /* … */
    public static void bypass(String name) { bypassed.add(name); }
    public static void clearBypass(String name) { bypassed.remove(name); }
    protected virtual Boolean isDisabledBySetting() { return false; } // e.g. Trigger_Switch__mdt
    protected virtual String handlerName() { return String.valueOf(this).split(':')[0]; }
}
```
Handlers pass `Trigger.new` / `Trigger.oldMap` into **service** methods that take collections; services own the logic and are
unit-testable without DML where possible.

## Order-of-execution notes the plan must state
before-save flows → before triggers → system validation + validation rules → duplicate rules → after-save flows/processes →
after triggers → assignment/auto-response/workflow → escalation rules → roll-up summary → post-commit (email, async).
A change that moves logic between these layers is a design decision — write it in `03-plan.md §3` with the reason.

## Recursion & re-entry
- Static `Set<Id>` of processed records per context; clear only in tests.
- Beware flow ↔ trigger loops (flow updates the record → trigger fires again). The plan names every automation on the object.

## Kill switch
Every new behaviour gets a switch (Custom Metadata `Automation_Switch__mdt` or the org's equivalent) read in the handler;
the deploy brief documents how to flip it.
