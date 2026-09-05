---
name: std-apex-conventions
description: Generic Apex standards SFsmiths agents follow when the org has no stricter convention (docs/org-map/CONVENTIONS.md and the generated <prefix>-* skills override this) — sharing, security, bulkification, error handling, structure, limits. Use when writing, planning or reviewing Apex.
---

# Apex conventions (generic baseline — the org's own conventions win)

Precedence: (1) the org's observed style in `docs/org-map/CONVENTIONS.md` and the generated `<prefix>-comment-conventions` /
`<prefix>-naming-rules` skills, (2) approved lessons, (3) this file, (4) the `salesforce-development` plugin skills.
When they conflict, follow the higher one and say so in your output.

## Security
- Declare sharing explicitly: `with sharing` by default, `inherited sharing` for utilities, `without sharing` only with a
  comment that names the business reason and the reviewer-visible justification.
- CRUD/FLS: `WITH USER_MODE` / `WITH SECURITY_ENFORCED` on queries in user context, `Security.stripInaccessible` before DML
  on user-provided data; system-mode paths documented.
- SOQL/SOSL: bind variables only; `String.escapeSingleQuotes` when dynamic strings are unavoidable.
- No hard-coded ids, URLs, credentials, email addresses, profile names. Use Custom Metadata / Custom Settings / Labels.
- Never `System.debug` PII; log ids and counts.

## Bulkification & limits
- Collections in, collections out; no SOQL/DML/callout inside loops; one query per object per transaction where possible.
- Selective queries (indexed filters, `LIMIT` on unbounded sets); aggregate in SOQL when you only need counts.
- Async (Queueable > Batch > Future) for callouts and heavy work; chaining depth documented; idempotent jobs.
- Governor-aware: `Limits.*` checks in long loops when relevant; avoid nested loops over large collections (use maps).

## Structure
- Trigger → handler (org framework, see `std-trigger-framework`) → service → selector/repository; no logic in triggers.
- Small, named methods; early returns; guard clauses; no god classes.
- Constants for magic values; enums for state; custom exceptions per domain (`CaseEscalationException`).
- Recursion guards via static sets of processed ids, scoped per transaction.

## Error handling
- Catch specific exceptions; never swallow (`catch (Exception e) {}` is a review blocker).
- `Database.*` partial-success methods with `allOrNone=false` only when the business allows partial results — and then
  handle `SaveResult` errors explicitly.
- Add context to rethrown errors; surface user-facing messages through `addError` with a clear sentence.

## Tests
See `sfsmiths-bulk-test-authoring`. Minimum: bulk 200, positive + negative, `runAs` for permissions, no `SeeAllData`.

## Review checklist (A6 uses this list)
sharing declared · FLS/CRUD · injection · hard-coded values · bulk-safe · limits · recursion · error handling ·
tests present & meaningful · comments in org format · names meaningful · no unrelated changes.
