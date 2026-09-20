# templates/prompts — the task prompt the conductor passes to each specialist

`sfsmiths agent handoff <KEY>` renders the first of `<agent>.<stage>.<CLASSIFICATION>.md`, `<agent>.<stage>.md`,
`<agent>.md` that exists (CLASSIFICATION = `01-intake.json → classification`: BUG | ENHANCEMENT | DATA-FIX | QUESTION,
`UNKNOWN` before intake ran — D-098), substituting:

`{{TICKET}} {{TITLE}} {{VAULT}} {{STAGE}} {{STAGE_TITLE}} {{AGENT}} {{ATTEMPT}} {{TIER}} {{OUTPUT}} {{GATES}}
{{NOTE}} {{REJECTION}} {{CONFIG}} {{FACTS}} {{TAG_FIELD}} {{TAG}} {{ALLOWED_EMAILS}} {{CLASSIFICATION}}`

The agent's *system prompt* (`.claude/agents/<agent>.md`) says how the job is done; this file says **which** job, for
**which** ticket, with the values that change per run. Keep them short. Edit here to change what agents are told;
never put company-specific values in them — they come from config through the placeholders.
