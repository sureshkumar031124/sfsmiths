#!/usr/bin/env bash
# Spike B — hooks + permissions smoke test, OFFLINE (no org needed). Feeds realistic payloads to the installed hooks and
# dumps what they answer; then lists what must be observed inside a live Claude Code session.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$repo"
HOOK="${HOME}/.sfsmiths/bin/sfsmiths-hook"; [ -x "$HOOK" ] || HOOK="node $repo/bin/sfsmiths-hook.js"
out="spikes/B-hooks-smoke/out"; mkdir -p "$out"
run() { local name="$1"; local payload="$2"; echo "── $name"; echo "$payload" | SFSMITHS_PROJECT_DIR="$repo" $HOOK "$name" | tee "$out/$name-$(date +%s%N).json"; echo " (exit ${PIPESTATUS[1]})"; }
run agent-gate  '{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"salesforce-dev","prompt":"x"},"session_id":"spike","cwd":"'"$repo"'"}'
run agent-gate  '{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"a4-developer","prompt":"x"},"session_id":"spike","cwd":"'"$repo"'"}'
run policy      '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sf project deploy start --source-dir org/force-app -o Production"},"session_id":"spike","cwd":"'"$repo"'"}'
run policy      '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sfsmiths-human approve DEMO-101"},"session_id":"spike","cwd":"'"$repo"'"}'
run policy      '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"HOME=/tmp/x sf org list"},"session_id":"spike","cwd":"'"$repo"'"}'
run policy      '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push bluecanvas main"},"session_id":"spike","cwd":"'"$repo"'"}'
run policy      '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sfsmiths agent status"},"session_id":"spike","cwd":"'"$repo"'"}'
run write-guard '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"'"$repo"'/.claude/settings.json"},"session_id":"spike","cwd":"'"$repo"'","agent_type":"a4-developer"}'
run write-guard '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"'"$repo"'/org/force-app/main/default/classes/X.cls"},"session_id":"spike","cwd":"'"$repo"'","agent_type":"a4-developer"}'
run data-guard  '{"hook_event_name":"PreToolUse","tool_name":"mcp__sf-dev__deploy_metadata","tool_input":{},"session_id":"spike","cwd":"'"$repo"'"}'
node scripts/hooks-latency.mjs || true
cat <<'TXT'

── LIVE checks (inside `sfsmiths-human start`, file adapter ticket DEMO-101) — record in FINDINGS:
 1. Ask the conductor to spawn a4-developer at stage intake → PreToolUse(Agent) deny message visible? (expected: yes)
 2. Let a1-intake finish without writing 01-intake.json → SubagentStop block with the gate reason? (expected: yes; ≤3 then failed)
 3. Type "stop" mid-ticket → Stop hook blocks with the handoff pointer? After 8 blocks → waiting_human + Slack (if configured)?
 4. Open work/DEMO-101/events.jsonl + metrics/agent-runs.jsonl → PostToolUse(Agent) tokens recorded? Which fields did tool_response carry? ([U] payload shape)
 5. a3-architect has memory: project + disallowedTools: Edit — can it still write its MEMORY.md? Can it write elsewhere? (expected: memory yes, elsewhere no)
 6. `/approve` typed by you → approvals/*.json origin user_prompt_submit; ask the conductor to "approve" → nothing happens (no verb).
 7. Hook latency in the session (Ctrl+O transcript timings) vs scripts/hooks-latency.mjs.
TXT
