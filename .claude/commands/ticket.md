---
description: Start or continue working a ticket (conductor session only)
argument-hint: <KEY> [--restart]
allowed-tools: Bash(sfsmiths agent open:*), Bash(sfsmiths agent handoff:*), Bash(sfsmiths agent status:*)
disable-model-invocation: true
---

Work ticket **$1** as the SFsmiths conductor.

The UserPromptSubmit hook has bound this session to $1 (if it refused, this is not a conductor session — tell the human to run `sfsmiths-human start`).

Steps:
1. Run `sfsmiths agent open $ARGUMENTS`
2. Run `sfsmiths agent handoff $1` and follow its ACTION literally (spawn exactly the named subagent with the printed prompt, or relay the WAIT/ESCALATION text and stop).
3. After every subagent returns, run `sfsmiths agent handoff $1` again.

Never approve, deploy, or spawn anything the handoff did not name.
