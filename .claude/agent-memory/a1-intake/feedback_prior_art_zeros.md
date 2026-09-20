---
name: prior-art-empty-surface-controls
description: At the prior_art stage, never write "nothing relevant" from the engine's empty index alone — prove per surface whether each zero is a real measurement or a structurally empty corpus, with a control that must return rows.
metadata:
  type: feedback
---

When `sfsmiths agent prior-art <KEY>` returns all zeros (related / tracker_hits / history / lessons),
do not write "nothing relevant" straight from that output. Establish, per surface, whether the zero is a
**measurement** ("we searched a populated corpus and nothing matched") or **structural** ("the corpus was
empty, so no result was possible") — and say which, per surface, in the digest.

**Why:** a wall of zeros is the classic shape of a broken probe, and the two readings drive different
downstream behaviour. A *measured* zero is mild reassurance that the area is untouched. A *structural*
zero is a warning that a prerequisite is missing — and it must not be allowed to soften the risk tier
("no accumulated warnings" is not "low risk" when the system has never run). Reporting a structural
zero as if it were a measurement is the dishonest version of this stage.

**How to apply:** for each surface, read its corpus directly and run one probe that MUST return rows:
- related vaults → read `knowledge/ticket-index.json`; the engine filters the subject ticket out as self
  (`priorart.ts:116`), so a 1-entry index means a candidate pool of zero
- tracker → read the adapter and corpus from `config/tracker.yaml`, then read the adapter's own `search()`
  rather than its docstring; the `file` adapter's docstring claims "inbox + completed vaults" but it iterates
  only `inboxDir` (`tracker/file.ts:5` vs `:42`)
- git history → control with `git log -- <a path that definitely has commits>`; see
  [[prior-art-git-zero-is-unknown]] for why this surface is usually UNKNOWN rather than zero
- lessons → the engine matches `L-*.md` only; confirm repo-wide whether any such file exists. Over an empty
  corpus no positive control is *constructible*, so say "population-existence check" and label it honestly

Pick control terms from the repo's own commit subjects / corpus contents, never from the ticket's keywords —
ticket keywords legitimately return 0 and prove nothing about the method. Re-measure any control figure before
publishing it: on DEMO-101 a draft quoted `config=4, docs=2` where the verified counts were 3 and 1.

Then check the two things that silently degrade later stages: whether `org/force-app` is actually synced, and
whether `docs/org-map/ORG-FACTS.md` / `CONVENTIONS.md` exist (if not, fall back to the `std-*` skills and say so).

If a hook denies a surface, name it as an uncovered gap rather than routing around it or quietly dropping it.
