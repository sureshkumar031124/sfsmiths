#!/usr/bin/env node
/**
 * scripts/hooks-latency.mjs — measure the BLOCKING hooks' wall time (a timed-out hook fails open, so speed is safety).
 * Runs each fast hook 15× with a realistic payload against the INSTALLED copy (falls back to repo bin/) and fails if p95 > budget.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.SFSMITHS_HOME || path.join(os.homedir(), ".sfsmiths");
const installed = path.join(home, "bin", process.platform === "win32" ? "sfsmiths-hook.cmd" : "sfsmiths-hook");
const cmd = fs.existsSync(installed) ? [installed] : ["node", path.join(repo, "bin", "sfsmiths-hook.js")];
const BUDGET_MS = Number(process.env.SFSMITHS_HOOK_BUDGET_MS || 1500); // Claude Code timeout we configure is 5s; keep 3× headroom
const cases = {
  "agent-gate": { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "a1-intake", prompt: "x" }, session_id: "latency", cwd: repo },
  policy: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sf project deploy start --source-dir org/force-app -o DevSandbox --json" }, session_id: "latency", cwd: repo },
  "write-guard": { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(repo, "org/force-app/main/default/classes/X.cls") }, session_id: "latency", cwd: repo, agent_type: "a4-developer" },
  "data-guard": { hook_event_name: "PreToolUse", tool_name: "mcp__sf-dev__deploy_metadata", tool_input: {}, session_id: "latency", cwd: repo },
};
let bad = false;
for (const [name, payload] of Object.entries(cases)) {
  const times = [];
  for (let i = 0; i < 15; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(cmd[0], [...cmd.slice(1), name], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, SFSMITHS_PROJECT_DIR: repo } });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (r.status !== 0 && i === 0) console.log(`  (${name} exit ${r.status}: ${(r.stderr || "").trim().slice(0, 120)})`);
  }
  times.sort((a, b) => a - b);
  const p50 = times[7].toFixed(0), p95 = times[14].toFixed(0);
  const ok = times[14] <= BUDGET_MS;
  if (!ok) bad = true;
  console.log(`${ok ? "✅" : "❌"} ${name.padEnd(12)} p50 ${p50}ms  p95 ${p95}ms  (budget ${BUDGET_MS}ms, using ${cmd.join(" ")})`);
}
process.exit(bad ? 1 : 0);
