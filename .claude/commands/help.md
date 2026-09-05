---
description: How to drive SFsmiths from this session
---

SFsmiths — commands you (the human) use in this conductor session:

- `/ticket <KEY>` start/continue a ticket · `/status [KEY]` where things stand
- `/approve <KEY> [--stage S] [--answer "…"]` · `/reject <KEY> --reason "…"` — human gates (recorded by the prompt hook)
- `/hold <KEY> --reason "…"` · `/resume <KEY>` — pause/continue (tracker is re-checked on resume)
- `/feedback "…"` — teach the team (approved lesson)

From the terminal: `sfsmiths-human deployed <KEY> --org preprod|production`, `sfsmiths-human verify <KEY>`, `sfsmiths-human ui`, `sfsmiths-human doctor`, `sfsmiths-human learn`, `sfsmiths-human lessons review`.

Answer the human's question about the workflow in plain language; do not start work from this command.
