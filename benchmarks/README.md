# benchmarks — Golden Ticket Replay (drift guard)

`sfsmiths-human golden add <KEY>` seals what a solved ticket proved (scope, failing/inverse tests, root cause, gates).
`sfsmiths-human golden score <KEY>` compares a fresh run of the same ticket with the seal:
R4 (zero non-existent components) is absolute; repro FAIL→PASS must be proven; ≥ 80 % of the sealed gate count must pass.

Run the golden set after: a model alias change, a plugin pin bump, a prompt/skill edit, a toolkit upgrade.
Sealed tickets live in `golden-tickets/<KEY>.json` (+ `<KEY>.ticket.json` snapshot so replays need no tracker).
