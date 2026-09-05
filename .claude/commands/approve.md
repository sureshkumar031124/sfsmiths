---
description: HUMAN ONLY — approve the stage a ticket is waiting on (recorded by the UserPromptSubmit hook)
argument-hint: <KEY> [--stage plan|intake|review] [--answer "what you checked"] [--edited "what you changed"]
allowed-tools: Bash(sfsmiths agent handoff:*), Bash(sfsmiths agent status:*)
disable-model-invocation: true
---

The human approved **$1**. The approval file was written by the prompt hook (see the SFsmiths context line above).
If no such context line is present, the approval was NOT recorded — say so and stop; do not try to record it yourself (only the human can).

Otherwise run `sfsmiths agent handoff $1` and follow it.
