---
paths:
  - "tests-ui/**"
---

# Playwright specs (tests-ui/)

- Development org only. `tests-ui/auth.setup.ts` refuses production hosts — never edit that guard. Preprod runs happen only through the engine as the least-privilege test user.
- Role/label locators over CSS; assertions describe business outcomes; no `test.skip` without a `// QUARANTINE(<reason>)` comment and a move to `tests-ui/quarantine/`.
- Form values: allowlisted test emails only (`config/safety.yaml`), scenario-true names.
- A healed test that changed its assertion is a defect for A6 review, not a fix.
