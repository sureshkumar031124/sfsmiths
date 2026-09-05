# docs/org-map — facts about YOUR orgs (generated, then reviewed)

`sfsmiths-human orgmap [--objects Case,Account]` writes:

- `ORG-FACTS.md` — orgs, editions, API versions, installed packages, release, users of note (no secrets)
- `<Object>.md` — key fields, record types, automation in order of execution, sharing model, row counts
- `dependency-graph.json` — MetadataComponentDependency edges used by baseline scope expansion and cartography
- `DRIFT.md` — dev ↔ preprod ↔ production differences seen during runs
- `CONVENTIONS.md` — **draft** sampled from your Apex/flows: header comment format, method doc style, modification log,
  naming suffixes, field descriptions. Review it once, fill in "Your decisions", then
  `sfsmiths-human conventions build --prefix <yourorg>` generates the `<prefix>-comment-conventions` and
  `<prefix>-naming-rules` skills every agent uses.

The cartographer (a0) may update these files during a ticket (additively, with a dated line). Nothing here is
company-specific until you run it against your orgs — that is the point.
