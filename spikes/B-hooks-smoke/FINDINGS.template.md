# Spike B findings — hooks + permissions smoke · <date>

## Offline (run.sh output)
| Hook | Payload | Answer (allow/deny + reason) | ms |
|---|---|---|---|

## Live session
| # | Check | Observed | Matches design? |
|---|---|---|---|
| 1 | PreToolUse(Agent) deny | | |
| 2 | SubagentStop block + reason | | |
| 3 | Stop block · 8-cap | | |
| 4 | PostToolUse(Agent) token fields ([U]) | | |
| 5 | memory: project × disallowedTools | | |
| 6 | /approve human origin only | | |
| 7 | latency | | |

**Decision:** …
