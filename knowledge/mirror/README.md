# knowledge/mirror — local mirror of OFFICIAL Salesforce documentation (grounding layer L2)

`sfsmiths-human mirror` downloads the sources in `sources.yaml` (defaults: Salesforce developer docs `llms.txt`,
`llms-product-docs.txt`, `llms-lwc.txt`) and verifies size/type. Agents grep these files and cite `file:line`.

- Never commit the mirrored files (gitignored) — they are large and licensed by Salesforce; every clone refreshes its own.
- Never edit them by hand.
- Add sources deliberately (official docs only). Blog posts are not grounding.
