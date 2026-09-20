# knowledge/curated — human-approved notes with provenance (grounding layer L2)

Agents never browse the web (every agent file denies `WebFetch`/`WebSearch`, checked by `npm run check:repo`). What they may
cite as platform knowledge comes from exactly two places:

1. `knowledge/mirror/` — Salesforce's own documentation, fetched by a human with `sfsmiths-human mirror` from the hosts listed
   in `knowledge/mirror/sources.yaml → trusted_domains` (developer/help/architect/trailhead/admin/engineering.salesforce.com,
   Salesforce's GitHub orgs). Any other host is refused (P12).
2. **this folder** — notes a human read, judged and filed: internal design standards, decisions about your trigger framework,
   integration patterns, and articles by people you trust — Salesforce MVPs, long-time practitioners. **Every file must say
   where it came from**, or `sfsmiths-human doctor` / `npm run check:repo` flag it and agents are told not to cite it.

## Required frontmatter

```yaml
---
source_url: https://…            # where the human read it (https)
author: Jane Doe                 # person or team
trust: mvp                       # official | mvp | veteran | internal
retrieved: 2026-09-20            # YYYY-MM-DD — when the human read it
added_by: your name              # who filed it (accountable human)
supersedes: (optional) older file name
---
```

`trust: official` is reserved for Salesforce documentation domains (checked). A stale curated note is worse than none
because agents trust it — mark superseded notes and remove them.

Nothing here is written by agents. Agents cite a curated note as `source: L2, ref: knowledge/curated/<file>.md#<heading>`.
