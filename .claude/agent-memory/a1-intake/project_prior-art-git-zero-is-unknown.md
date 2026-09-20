---
name: prior-art-git-zero-is-unknown
description: At the prior_art stage the git-history and scope_guess results are structurally empty until the baseline sync runs, so report them as UNKNOWN rather than zero
metadata:
  type: project
---

At `prior_art`, a `0 git commit(s)` result and an empty `scope_guess` are **not measurements** while
`org/force-app` holds only `.gitkeep` files. Report them as UNKNOWN (surface not populated), never as zero.

**Why:** the baseline sync stage (a0b) runs *after* intake, but `buildPriorArt` derives both results from
`walkFiles(org/force-app)` at prior_art time. So `guessScope()` gets an empty component-name map, and the git
search's scope arm (`for (const key of scopeGuess.slice(0,15))`) executes zero iterations — that arm never runs.
Only a keyword `--grep` scoped to the same unpopulated pathspec runs. On DEMO-101 (2026-09-07) the repo had zero
`.cls`/`.trigger`/`.flow-meta.xml` ever committed, so the surface could not answer "was this component changed
recently" at all. Reporting it as zero would falsely clear a "started after the last release" bug of any change
history.

**How to apply:** on any ticket whose baseline is not yet synced — (1) label the git result UNKNOWN with the reason,
(2) carry an `unknowns[]` entry telling the plan stage to re-ask after baseline sync, (3) never let an empty
`scope_guess` imply the ticket names no components; name scope from the ticket text and mark `(needs cartography)`.
Prove the *method* works before publishing any zero: pick `--grep` control terms from the repo's own commit
subjects, not from the ticket's keywords — ticket keywords legitimately return 0 unscoped and prove nothing.

Related: [[prior-art-empty-surface-controls]]
