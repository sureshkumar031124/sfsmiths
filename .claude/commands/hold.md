---
description: HUMAN ONLY — put a ticket on hold (locks released; resume later with tracker re-check)
argument-hint: <KEY> --reason "why"
disable-model-invocation: true
---

Ticket **$1** is on hold (recorded by the prompt hook). Acknowledge in one line and do nothing else for this ticket until `/resume $1`.
