# 02 — Reproduction · <KEY>

## Production evidence (masked, L3)
| Question | Query/count | Result | Evidence file |
|---|---|---|---|
| Does the bad state exist? | COUNT() … | n | evidence/… |

## Data created (development sandbox, tag `<TAG>`)
| Object | Count | Names pattern | Script |
|---|---|---|---|
| Case | 200 | "Portal login fails after password reset #n" | artifacts/repro-data.apex |

## Failing assertion (must FAIL now → PASS after fix)
- `ClassNameTest.methodName` — what it proves …  → outcome in validations/tests-repro.json: **Fail**

## Inverse assertion (must PASS before and after)
- `ClassNameTest.otherMethod` — … → **Pass**

## Predicted distribution (artifacts/assertions.json)
| Description | Query | Expected |
|---|---|---|

## Root-cause hypothesis (for the architect — not a fix)
… (confidence 0.x)

## Attempts / notes
- attempt 1: …
