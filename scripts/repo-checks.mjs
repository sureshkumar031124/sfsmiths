#!/usr/bin/env node
/**
 * scripts/repo-checks.mjs — structural checks on the Claude Code layer that no unit test covers (run by `npm run verify` and CI).
 *
 *   1. .claude/settings.json parses and wires every sfsmiths-hook verb the toolkit implements
 *   2. every hook command points at the INSTALLED copy ($HOME/.sfsmiths/bin), never at the repo
 *   3. .claude-plugin/marketplace.json parses and pins the plugin to a 40-char sha
 *   4. every .claude/agents/*.md has frontmatter with name (= file name), description and model
 *   5. the conductor's Agent(...) allowlist names only agents that exist
 *
 * Plain node:fs — no build, no dependencies, same result on every platform (the previous inline shell version
 * broke on quote escaping and would not run on Windows).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const problems = [];
const fail = (msg) => problems.push(msg);

// 1 + 2 — hooks
const REQUIRED_HOOKS = ["session-start", "prompt-router", "agent-gate", "policy", "write-guard", "data-guard", "tokens", "post-edit", "stage-gate", "stop-guard", "precompact"];
let settings;
try {
  settings = JSON.parse(read(".claude/settings.json"));
} catch (e) {
  fail(`.claude/settings.json is not valid JSON: ${e.message}`);
}
if (settings) {
  const wired = new Set();
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const h of entry.hooks ?? []) {
        if (h.type !== "command") continue;
        const m = /sfsmiths-hook"?\s+([a-z-]+)/.exec(h.command ?? "");
        if (!m) fail(`${event}: hook command does not call sfsmiths-hook: ${h.command}`);
        else wired.add(m[1]);
        if (!/\$HOME\/\.sfsmiths\/bin\/sfsmiths-hook/.test(h.command ?? "")) fail(`${event}: hook must run the installed copy ($HOME/.sfsmiths/bin/sfsmiths-hook): ${h.command}`);
        if (typeof h.timeout !== "number") fail(`${event}: hook has no explicit timeout: ${h.command}`);
      }
    }
  }
  for (const name of REQUIRED_HOOKS) if (!wired.has(name)) fail(`hook not wired in .claude/settings.json: ${name}`);
  if (!Array.isArray(settings.permissions?.deny) || settings.permissions.deny.length === 0) fail("permissions.deny is empty — static denies are part of the enforcement layer");
}

// 3 — marketplace pin
try {
  const mp = JSON.parse(read(".claude-plugin/marketplace.json"));
  for (const p of mp.plugins ?? []) {
    const sha = p.source?.sha;
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail(`marketplace plugin "${p.name}" is not pinned to a 40-char sha (found: ${sha})`);
  }
} catch (e) {
  fail(`.claude-plugin/marketplace.json is not valid JSON: ${e.message}`);
}

// 4 — agent frontmatter
const agentsDir = path.join(repo, ".claude", "agents");
const agentNames = new Set();
for (const f of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()) {
  const expected = f.replace(/\.md$/, "");
  const text = fs.readFileSync(path.join(agentsDir, f), "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) { fail(`.claude/agents/${f}: no YAML frontmatter`); continue; }
  const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm[1])?.[1]?.trim();
  if (field("name") !== expected) fail(`.claude/agents/${f}: name must be "${expected}" (found "${field("name")}")`);
  if (!field("description")) fail(`.claude/agents/${f}: missing description`);
  if (!field("model")) fail(`.claude/agents/${f}: missing model`);
  agentNames.add(field("name") ?? expected); // Claude Code addresses a subagent by its frontmatter name, not its file name
}

// 5 — conductor allowlist
const conductor = fs.existsSync(path.join(agentsDir, "conductor.md")) ? read(".claude/agents/conductor.md") : "";
const allow = /Agent\(([^)]*)\)/.exec(conductor)?.[1];
if (!allow) fail("conductor.md: tools must include Agent(<allowed subagents>)");
else for (const a of allow.split(",").map((s) => s.trim()).filter(Boolean)) if (!agentNames.has(a)) fail(`conductor.md allows unknown agent "${a}"`);

if (problems.length) {
  console.error(`repo-checks: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`repo-checks: ok (hooks wired: ${REQUIRED_HOOKS.length}, agents: ${agentNames.size}, marketplace pinned)`);
