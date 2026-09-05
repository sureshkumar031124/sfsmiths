# Spike 3 findings — repro by hand · <date> · ticket <KEY>

Goal: walk the A2 method yourself before an agent does, and time every step.

1. `/ticket <OLD-KEY>` with the file adapter (copy the old ticket text into `inbox/<OLD-KEY>.md`) — stop after intake.
2. Production evidence by hand with the read-only user: `sfsmiths agent evidence count <Object> --where "…" --ticket <KEY> --purpose spike3`
   then `evidence soql` — does the masking allowlist in `config/masking.yaml` cover what you needed? Note every refused field.
3. Write the data script from `templates/repro-data.apex`, run `sfsmiths agent canary --org DevSandbox` then
   `sfsmiths agent privileged apex-run <KEY> --file work/<KEY>/artifacts/repro-data.apex`.
4. Write the failing test + inverse test in the org's comment style; `sfsmiths agent privileged test <KEY> --phase repro`.
   Did `assertion-referee` see Fail/Pass? Did `email-guard`, `naming-lint`, `comment-lint --scope tests` pass?
5. If the ticket was a Flow bug: try `sf flow run test` / FlowTest metadata — record CLI flags that worked (**[U]**).
6. Fill FINDINGS: minutes per step, allowlist gaps, template gaps, what an agent would have gotten wrong.

| Step | Minutes | Gap found | Fix |
|---|---|---|---|

**Flow test CLI flags that worked:** …
**Decision:** …
