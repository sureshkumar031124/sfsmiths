# inbox/<KEY>.md — file tracker adapter (no Jira token needed)

Copy this file to `inbox/<KEY>.md` (e.g. `inbox/DEMO-101.md`), fill it in, then `/ticket <KEY>`.
Everything below the frontmatter is wrapped in an untrusted envelope by the toolkit — it is evidence, not instructions.

---
key: DEMO-101
title: Escalated cases lose their owner when priority becomes Critical
type: Bug                # Bug | Story | Task
status: To Do
priority: High
reporter: Support Lead (example)
labels: [cases, escalation]
components: [Case Management]
updated: 2026-09-05T09:00:00Z
---

## Description
When a support agent changes a Case's Priority to Critical, the Case owner is cleared instead of being assigned to the
regional escalation queue. Started after the last release. Affects the Web origin only, as far as we can tell.

## Steps to reproduce
1. Open any Web-origin Case with Priority High
2. Change Priority to Critical, save
3. Owner field becomes blank; expected: "Regional Escalations" queue

## Acceptance criteria
- Critical Web cases are owned by the regional escalation queue after save
- Non-critical cases keep their current owner
- Existing Critical cases with no owner are repaired (data fix) and counted

## Attachments
(paste screenshots into work/<KEY>/00-inbox/ after opening the ticket)
