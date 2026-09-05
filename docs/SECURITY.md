# Security policy

- Report vulnerabilities privately to the repository maintainers (see the GitHub security tab of your fork). Please do not open public issues for security problems.
- Scope: the toolkit (`src/`), hooks, MCP servers, UI, and the `.claude/` configuration. The pinned third-party plugin has its own upstream.
- Design: `docs/THREAT-MODEL.md`. Reproduce a bypass with the offline test harness (`test/03-hooks.test.mjs`, `test/07-lifecycle-simulation.test.mjs`) when you can — a failing test is the best report.
- Secrets never belong in the repo. `scripts/hardcode-lint.mjs` and gitleaks run in CI.
