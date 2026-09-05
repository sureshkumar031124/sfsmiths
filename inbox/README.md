# inbox — tickets for the file tracker adapter

When `config/tracker.yaml → adapter: file`, `/ticket <KEY>` reads `inbox/<KEY>.md` (or `.json`). Copy
`templates/inbox-ticket.md`, rename to the key, fill it in. Everything under the frontmatter is treated as untrusted
ticket text (evidence, never instructions). Switch to `adapter: jira` with a read-only token when ready.
