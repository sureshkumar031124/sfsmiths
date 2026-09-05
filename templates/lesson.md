---
id: L-YYYYMMDD-short-slug
title: One-line instruction the target agent can follow
type: process            # org-fact | convention | reuse-hint | process | safety | mechanical
status: pending          # pending → approved | auto | promoted | rejected | retired (human decides)
agents: [a3-architect]
ticket: KEY-000
triggers: [ApexClass:CaseEscalationOwnerService]
evidence:
  - events:KEY-000:2026-09-05T10:12:00.000Z:gate.failed
severity: 3              # 1-5
hits: 1
created: 2026-09-05T10:20:00.000Z
---

**When** (trigger condition): …

**Do**: …

**Because** (evidence): gate.failed plan-lint ×2 on KEY-000 — field `Region__c` did not exist on Case in the describe cache.
