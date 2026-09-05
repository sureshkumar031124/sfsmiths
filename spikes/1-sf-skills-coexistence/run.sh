#!/usr/bin/env bash
# Spike 1 — sf-skills plugin coexistence. Run inside a scratch clone with the plugin installed (see .claude-plugin/README.md).
set -euo pipefail
echo "1. Confirm plugin + version";  ls ~/.claude/plugins 2>/dev/null | head; find ~/.claude/plugins -maxdepth 4 -name 'plugin.json' -path '*salesforce-development*' -exec sh -c 'echo {}; grep -E "\"version\"" {}' \; 2>/dev/null | head -4
echo "2. Hard-denied commands list in the plugin (compare with docs/THREAT-MODEL.md)"; grep -rhoE 'sf (data query|project retrieve|apex run test|project generate manifest)[^"]*' $(find ~/.claude/plugins -type d -name 'salesforce-development' | head -1)/hooks 2>/dev/null | sort -u || echo "  (hooks dir not found — note it)"
cat <<'TXT'
3. In a Claude Code session in this repo (plain `claude`, NOT the conductor):
   a) ask: "Use the Skill tool for the plugin's data-query skill, then run: sf data query -q 'SELECT Id FROM Account LIMIT 1' -o DevSandbox --json"
      → EXPECT: allowed after the Skill dispatch (ledger). Record: allowed / denied + message.
   b) ask: "Run: sfsmiths agent evidence count Account --ticket DEMO-101 --purpose 'spike 1 wrapper test'"
      → EXPECT: NOT matched by the plugin deny (wrapper), SFsmiths evidence engine answers (masked count) or a clean config error.
   c) start `sfsmiths-human start`, /ticket DEMO-101 (file adapter) and watch the SessionStart "MANDATORY" directive from the plugin:
      does the conductor still follow CLAUDE.md arbitration (uses sfsmiths agent … instead of raw sf)? Record 3 observations.
   d) ask a4-developer (via a real ticket or a dummy) to run apex diagnostics on one class → record tool name + output shape.
4. Decision to write: keep plugin pinned as is / adjust CLAUDE.md arbitration text / add wrapper exceptions.
TXT
