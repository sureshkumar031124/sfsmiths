---
name: sfsmiths-plan-grounding
description: How A3 grounds a plan so plan-lint and semantic-check pass — refresh the oracle caches, resolve every component and field against retrieve/describe, cite official docs from the local mirror, mark genuinely new components as create. Use before writing 03-plan.md.
---

# Plan grounding — how a plan earns "zero non-existent components"

`plan-lint` reads `03-plan.json` and resolves **every** `components[].api_name`, `fields[].api_name` (per object),
object names in `soql[]`, and every `Type.Name`/`Object.Field__c`-looking token in the prose against the oracle caches.
One unresolved name = stage fails. This skill is how you never hit that.

## Step 0 — refresh the oracle
```
sfsmiths agent cache freshen <KEY>            # objects + component types from scope.json
sfsmiths agent cache freshen <KEY> --objects Case,Account --types ApexClass,Flow,ValidationRule
```
Caches: `.sfsmiths/cache/describe/<Object>.json` (fields, types, updateable/createable, calculated),
`.sfsmiths/cache/metadata/<Type>.json` (component names in the development org). Read them — they are the truth for
"exists here". For "exists in production", use `mcp__sfsmiths-evidence__prod_describe` / `prod_tooling`.

## Step 1 — read the real thing
For every component you will touch: `mcp__sf-dev__retrieve_metadata` (or open the baseline-synced file under
`org/force-app/`). Plan from the actual code and XML: method names, handler structure, flow elements, field references.
Quote line numbers when you describe a change.

## Step 2 — fields and objects
For every field: find it in the describe cache; note `type`, `updateable`, `calculated`, `nillable`. Semantic-check fails on:
DML to a non-updateable/formula/rollup field; changes to managed-package (`namespace__`) components; DML or callouts
planned inside a before-save flow; an `api_version` that differs from `org/sfdx-project.json`.

## Step 3 — platform behaviour claims
Order of execution, limits, flow semantics, sharing rules: grep the mirror and cite the line:
```
grep -n "before-save" knowledge/mirror/llms-product-docs.txt | head
```
→ `{source: "L2", ref: "knowledge/mirror/llms-product-docs.txt:1234"}`. No mirror line → say "per platform behaviour
(unverified)" and add it to unknowns. Never cite a URL you did not find in the mirror or `knowledge/curated/`.

## Step 4 — new components
A name that does not exist yet is allowed **only** with `action: "create"` and a naming-rule-compliant name
(`config/naming.yaml`). Every other unresolved name is a mistake — fix the name or remove the claim.

## Step 5 — self-check before finishing
```
sfsmiths agent gate plan-lint <KEY> --stage plan
sfsmiths agent gate semantic-check <KEY> --stage plan
sfsmiths agent gate checklist <KEY> --stage plan
```
Read the reasons; fix; re-run. Arriving at SubagentStop with known failures wastes a bounce.

## Contract fields plan-lint/semantic-check read
`components[] {type, api_name, action, object?, evidence}` · `fields[] {object, api_name, action, evidence}` ·
`soql[]` · `flows[] {api_name, type, trigger, dml, actions[]}` · `api_version` · `objects[]` · `touches[]`.
