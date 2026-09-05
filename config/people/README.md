# config/people/<name>.md — recipient profiles for A9 Comms drafts

One file per person the drafts are written for. Schema (Part 7 §13):

```yaml
---
name: Jane Doe
role: Support Lead
technical_depth: 1        # 0 = doesn't know what a field is · 1 = admin-literate · 2 = reads Flows/errors · 3 = developer
cares_about: [customer impact, dates]
style: short bullets
never_mention: [internal blame, other customers, security detail]
audience_default: internal   # internal | client-visible
timezone: America/New_York
---
```

Profiles are read-only for agents (write-guard). They never contain personal data beyond the working profile above.
