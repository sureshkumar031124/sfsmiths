# Contributing

1. `npm ci && npm run build && npm test` — 51 offline tests must stay green; add one for every behaviour you change (gates, hooks, state machine, UI, MCP). Tests start from `config/defaults/` — never from your personal `config/*.yaml`, which is gitignored.
2. `node scripts/hardcode-lint.mjs` — nothing company-specific outside `config/`. Examples use `PROJ-123`, `DevSandbox`, `*@example.com`.
3. Hooks are safety-critical: keep `src/hooks/fast.ts` dependency-free and fast (`node scripts/hooks-latency.mjs`), fail closed, and duplicate hard cases as static deny rules in `.claude/settings.json`.
4. Every agent prompt change is a behaviour change: run the golden set when you have one, and note it in `docs/DECISIONS.md`.
5. Verified facts about Claude Code / Salesforce CLI go with a date and a source in the file header comment; unverified ones are marked **[U]** and get a spike.
6. Commit style: `type(scope): imperative summary` (`gate(plan-lint): resolve fields per object`). Run `npm run install:toolkit` after toolkit changes so your hooks match your source.
