---
name: sfsmiths-deploy-brief
description: How A6 writes 06b-deploy-brief.md — the one page the human reads before deploying through Blue Canvas: components in prose, profiles/permission sets to touch by hand, window vs calendar freezes, test level, verification SOQL, rollback, remediation hand-off, drift. Use at the review stage.
---

# Deploy brief (06b) — one page, written for the person who presses Deploy

The human deploys; SFsmiths never does (P3). The brief is what makes that deploy boring.

## Sections (all required; write "none" explicitly)
1. **Change in one paragraph** — what the user will notice, what the root cause was (link `03-plan.md §1`).
2. **Components** — point at the toolkit's manifest: `06c-deploy-manifest.md` (table: type · API name · added/modified/deleted ·
   files · fingerprint) and `artifacts/package.xml` (+ `destructiveChanges.xml` when something is deleted). It is generated from
   `git diff <baseline_commit>` by `sfsmiths agent deploy-manifest <KEY>` — run it first, never type the list from memory. In the
   brief, add only what the table cannot say: the reason each component changed (one line), and anything in it the plan did not
   name (that is a REQUEST CHANGES finding, not a footnote). After the human deploys, the toolkit checks this exact list against
   preprod (`07a-uat-parity.md`, stage `uat_verify`) before QA runs there.
3. **By hand after deploy** — profiles / permission sets / field-level security / page layouts / assignment rules that
   metadata deploy does not (or should not) carry, each with *why* and the click path. If nothing: "none — verified in `04-implementation.json → components`".
4. **Pre-deploy checks** — preprod dry-run report path (`validations/uat-validate.json`), test level to run
   (`RunSpecifiedTests` list or `RunLocalTests`), known preprod↔production drift from `00b-baseline.json` and what it means.
5. **Window** — proposed window; check `config/calendar.yaml` (freeze, release weekends, sync windows) and say which
   applies. Never propose inside a freeze.
6. **Post-deploy verification** — the `prod_verification[]` SOQL from the plan, expected values, and the command
   `sfsmiths-human verify <KEY>` that runs them read-only and writes `08-prod-verify.md`.
7. **Rollback** — exact steps (revert commit / redeploy previous versions / disable flow version / kill switch value),
   how long it takes, how to confirm it worked.
8. **Remediation** — if `plan.remediation.needed`: who runs the script, when (after verification), batch size, the
   verification SOQL, and `sfsmiths-human verify <KEY> --remediation`. The script itself lives in
   `work/<KEY>/artifacts/remediation/*.apex` and is run by the human, never by an agent.
9. **Comms readiness** — which drafts in `10-comms/` are ready, which need a date.
10. **Risks & unknowns** — from review and plan, ranked; anything the human should ask before deploying.

## Style
Plain sentences, no agent jargon, no internal file paths except the ones the human must open. A senior admin should be
able to execute it without opening the vault.
