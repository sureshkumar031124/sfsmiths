# tests-ui — Playwright specs (optional layer)

- `specs/` — deterministic UI checks drafted by A8/A5; role/label locators; business-outcome assertions.
- `quarantine/` — flaky specs with a `// QUARANTINE(<reason>)` header; never a gate.
- `heals/` — proposals from Playwright's healer agent, reviewed by A6 before any spec changes.
- `auth.setup.ts` — development org login via frontdoor; **refuses production**. Do not edit the guard.

Install (human): `npm i -D playwright@1.63.0 @playwright/test@1.63.0 && npx playwright install chromium`.
Run: `npx playwright test -c tests-ui/playwright.config.ts`.
