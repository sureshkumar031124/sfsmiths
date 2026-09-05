Ticket **{{TICKET}}** — "{{TITLE}}" · support request during stage `{{STAGE}}` · tier {{TIER}} · orgs: {{CONFIG}}
Vault: `{{VAULT}}/` — read `ui-request.md` if present, else `02-repro.md` / `05-test-report.md` for the open UI question; record ids from `02-repro.md` / `artifacts/`.

Task: observe in the DEVELOPMENT org only. `mcp__sfsmiths-ui__ui_login` → `ui_goto` → steps → `ui_text` + `ui_screenshot` (pass `ticket: "{{TICKET}}"`) → `ui_close`. Form values: emails only from {{ALLOWED_EMAILS}}.
Write `{{VAULT}}/ui/REPORT.md` (steps, quoted text, screenshot paths, observation-verdict) and `{{VAULT}}/ui/report.json`; draft `tests-ui/specs/<what-it-proves>.spec.ts` when a repeatable check is possible. Refusals from the server are final — report them.
{{NOTE}}
