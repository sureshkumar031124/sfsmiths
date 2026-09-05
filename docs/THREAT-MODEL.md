# SFsmiths — Threat model

Assets: production data and metadata · preprod integrity · customer trust (no stray emails, no leaked PII) · the
team's code standards · the human's decision rights. Adversaries: a confused or prompt-injected agent, a buggy tool, a
careless operator. Not in scope: a malicious operator with shell access to their own machine (they can already do everything).

## Enforcement ladder (outer walls first — each holds even if the inner ones fail)

| Layer | Mechanism | Covers |
|---|---|---|
| **L-A Identity** | production reachable only as a read-only user with FLS = masking allowlist; preprod credentials only in a separate `HOME` (engine keychain); no admin login in the default keychain (doctor #6) | prod writes, PII exposure, preprod tampering — even with hooks disabled |
| **L-B Toolkit surfaces** | agent-safe `sfsmiths agent …` vs human-only `sfsmiths-human …` binaries; MCP servers with no write tools for production, dev-bound `sf-dev`; UI on 127.0.0.1 with a token | agents cannot approve, deploy-mark, sync, log in, post to the tracker |
| **L-C Static permissions** | `.claude/settings.json` deny rules: human verbs, non-dev `sf` targets (synced per alias), git push/remotes, `claude`, keychain paths, protected files, dangerous MCP tools, plugin agent, web tools | applies to every subagent even when a hook times out |
| **L-D Fast hooks** | PreToolUse `policy`/`write-guard`/`agent-gate`/`data-guard` (≤50 ms, fail-closed, static defaults when policy file missing) | normalised command analysis, write targets, stage order, canary before side effects |
| **L-E Gates** | SubagentStop `stage-gate` runs mechanical checks; Stop guard; `unavailable ≠ passed` | quality, evidence, naming, comments, emails, tests |
| **L-F Human** | tier matrix + per-agent ask; typed answers on HIGH plans; deploys always human; lessons approved by humans | judgement calls |
| **L-G Audit** | `events.jsonl`, `evidence.log.jsonl`, `ui.log.jsonl`, validations with artifact hashes, approvals as files with origin | after-the-fact review, rewards |

## Threats and controls

| # | Threat | Controls |
|---|---|---|
| T1 | Agent writes to production | L-A (read-only user), no prod MCP write tool, L-C denies `sf … -o Production*`, L-D R7, prod evidence server is SELECT-only |
| T2 | Agent reads PII from production | masking allowlist per object (`config/masking.yaml`), field-type refusal (Email/Phone), row caps, FLS mirrors allowlist (doctor #12), every query logged |
| T3 | Real email sent from a sandbox | canary must PASS (`NO_MASS_MAIL_PERMISSION`) before data stages (`data-guard`, `privileged apex-run`), `email-guard` scans artifacts, UI `ui_fill` refuses non-allowlisted addresses, EML checklist in every plan |
| T4 | Agent deploys to preprod/production | preprod only via engine keychain (agents cannot read it: L-C `Read(~/.sfsmiths/**)`, R2), deploys are human stages, `git push` denied, Blue Canvas remotes denied |
| T5 | Agent edits the rules that govern it | protected paths in L-C + write-guard (`src/`, `.claude/**`, `config/`, `knowledge/` except PENDING, `templates/`, `schemas/`), hooks run the **installed copy** outside the repo |
| T6 | Agent fabricates an approval / deploy mark | approvals are files written only by human-origin paths (UserPromptSubmit hook, `sfsmiths-human`, UI); no agent verb exists; `Approval.origin` recorded |
| T7 | Agent runs out of order / skips a stage | manifest `next_allowed_stages` enforced by `agent-gate`; SubagentStop matcher per agent; Stop guard |
| T8 | Prompt injection via ticket text, comments, org data, docs | all untrusted text wrapped in `<untrusted source=…>` envelopes; agents instructed (P7) and hooks do not read prose; `injection-patterns.txt` for the intake notice; comms-lint refuses leaked envelopes |
| T9 | Hallucinated API names reach code | plan-lint/semantic-check against describe/metadata caches; `action: create` explicit; R4 golden rule |
| T10 | Fake pass (weakened test, `assert(true)`) | assertion-referee reads run files, requires FAIL→PASS + inverse; test-quality zero-assertion detection; A6 reviews test diffs; reward penalties |
| T11 | Runaway cost | per-ticket and daily budgets → parked; pipeline `--max-budget-usd`; token accounting per agent/model |
| T12 | Hook time-out fails open | fast hooks are zero-dependency (measured p95 < 60 ms; CI budget 1.5 s vs 5 s timeout); hard cases duplicated as static denies (L-C); identity (L-A) beneath |
| T13 | UI exposed on the network / CSRF / DNS rebinding | binds 127.0.0.1 only; random per-start token in the URL fragment; Host + Origin + Sec-Fetch-Site checks; no CDN; CSP; writes limited to config/approvals/lessons/hold |
| T14 | Secrets in the repo | secrets only in env vars; `hardcode-lint` flags secret-looking values in config; gitleaks in CI; `.gitignore` covers state, keychains, mirrors |
| T15 | Third-party plugin changes behaviour silently | pinned marketplace (`sha`), CLAUDE.md arbitration, plugin's `salesforce-dev` agent denied, plugin MCP tools allowlisted individually |
| T16 | Preprod/production drift makes a dev-tested fix wrong | baseline sync (preprod → dev, 3-way), drift table in cartography, preprod dry-run before review, preprod QA after human deploy |
| T17 | Agent memory poisons future runs | agent notes quarantined (`MEMORY.md` labelled UNVERIFIED), lessons only from events/human decisions, memory audit, coach cannot edit approved lessons |
| T18 | Operator bypasses everything | documented escape hatches (`SFSMITHS_HOOKS_OFF`, `--settings disableAllHooks`) are visible in events/session; identity layer still holds |

## Residual risks (accepted, documented)

- Windows shell semantics for hook commands (`$HOME`) — Phase 4.
- `PostToolUse(Agent)` token payload shape is not documented by Claude Code; accounting falls back to transcripts (Spike B).
- Deny rules and hooks reason about *commands*; a subprocess that opens files itself (a Node script an agent writes and runs) is bounded by write-guard on its creation and by the read-only identity, not by path rules. Enable the Claude Code sandbox for OS-level enforcement if your policy requires it.
- The evidence server trusts `config/masking.yaml`; a human who allowlists `Contact.Email` has decided to expose it.
