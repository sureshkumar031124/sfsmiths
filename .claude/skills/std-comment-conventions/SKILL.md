---
name: std-comment-conventions
description: Generic comment conventions SFsmiths agents follow when the org has not generated its own <prefix>-comment-conventions skill — ApexDoc header, doc comment on every public/global method, modification log with the ticket key, descriptions on flows/fields/rules/permission sets, LWC headers; comment-lint enforces them. Use when writing or editing any code or metadata.
---

# Comment conventions (generic — the org's observed format wins; see `docs/org-map/CONVENTIONS.md`)

The rule behind all of this: **comments in the existing format of the codebase**. Before you write a comment, open a
neighbouring class and copy its shape exactly (tag order, spacing, log format). `comment-lint` checks the mechanics below
on every changed file.

## Apex classes and triggers — header block (required)
```apex
/**
 * @description  One sentence: what this class is responsible for.
 * @author       <team or agent name>
 * @date         2026-09-05
 * @group        Case Management            // if the org uses groups
 *
 * Modification Log
 * ------------------------------------------------------------------
 * Date        Ticket      Author        Change
 * 2026-09-05  KEY-123     a4-developer  Assign regional queue when Priority becomes Critical
 */
public with sharing class CaseEscalationOwnerService {
```
- The **modification log must mention the ticket key** of the current change (comment-lint: `missing modification-log entry`).
- Keep the org's existing header if it has one — add your log line, do not reformat the block.

## Methods — doc comment on every `public` / `global` method (required)
```apex
    /**
     * @description Assigns the regional escalation queue to Critical cases; bulk-safe, no DML for unchanged owners.
     * @param cases   Trigger.new cases whose Priority changed
     * @param oldMap  previous values, used to detect the flip
     */
    public static void assignEscalationOwner(List<Case> cases, Map<Id, Case> oldMap) {
```
Private methods: a one-line `//` or doc comment when the name alone does not explain the *why*.

## Inline comments
Explain *why*, not *what*. `// TODO` must carry a ticket key (`// TODO KEY-124: …`) or comment-lint fails it.

## Metadata — `<description>` required
Flows (and non-obvious elements), custom fields, validation rules (plus a clear `errorMessage`), custom objects,
permission sets, quick actions, flexipages: a `<description>` of at least a sentence saying what it does and why it exists.

## LWC
First lines of every `.js`: a header comment (purpose, ticket in a modification log line); JSDoc on public
`@api` properties and methods; `.html` templates get a comment only where structure is non-obvious.

## Tests
Same header block; each test method gets a one-line `@description` saying what it proves (FAILS-on-bug / INVERSE).

## Self-check
`sfsmiths agent gate comment-lint <KEY> --stage <stage>` (tests-only scope at repro; everything at develop).
