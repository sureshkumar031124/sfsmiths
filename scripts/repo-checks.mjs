#!/usr/bin/env node
/**
 * scripts/repo-checks.mjs — structural checks on the Claude Code layer that no unit test covers (run by `npm run verify` and CI).
 *
 *   1. .claude/settings.json parses and wires every sfsmiths-hook verb the toolkit implements
 *   2. every hook command points at the INSTALLED copy ($HOME/.sfsmiths/bin), never at the repo
 *   3. .claude-plugin/marketplace.json parses and pins the plugin to a 40-char sha
 *   4. every .claude/agents/*.md has frontmatter with name (= file name), description and model; a present
 *      `effort:` is a valid level and every specialist declares `background: false` (D-093/D-095)
 *   5. the conductor's Agent(...) allowlist names only agents that exist
 *   6. generated org-convention skills (<prefix>-*) are listed by every agent that lists the matching std-* skill (D-096)
 *   7. no agent may browse the web: WebFetch/WebSearch absent from tools and present in disallowedTools (P12)
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
  // strict YAML: an unquoted description containing ": " is BLOCK_AS_IMPLICIT_KEY for strict parsers (Claude Code is lenient today)
  const desc = field("description") ?? "";
  if (/: /.test(desc) && !/^(["']).*\1$/.test(desc)) fail(`.claude/agents/${f}: description contains ": " — quote the whole value so strict YAML parsers accept it`);
  if (!field("model")) fail(`.claude/agents/${f}: missing model`);
  // D-095: an effort line is optional (config `inherit` removes it), but a present one must be a level Claude Code accepts
  const effort = field("effort");
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) fail(`.claude/agents/${f}: effort "${effort}" is not low|medium|high|xhigh|max`);
  // D-093: a specialist must never be spawned as a background task — the stage gates run when it stops, so a
  // background agent ends the conductor's turn before the stage can be judged (Run 1's false escalation).
  if (expected !== "conductor" && field("background") !== "false") fail(`.claude/agents/${f}: must declare "background: false" (D-093)`);
  agentNames.add(field("name") ?? expected); // Claude Code addresses a subagent by its frontmatter name, not its file name
}

// 5 — conductor allowlist
const conductor = fs.existsSync(path.join(agentsDir, "conductor.md")) ? read(".claude/agents/conductor.md") : "";
const allow = /Agent\(([^)]*)\)/.exec(conductor)?.[1];
if (!allow) fail("conductor.md: tools must include Agent(<allowed subagents>)");
else for (const a of allow.split(",").map((s) => s.trim()).filter(Boolean)) if (!agentNames.has(a)) fail(`conductor.md allows unknown agent "${a}"`);

// 6 — D-096: a generated org-convention skill (<prefix>-comment-conventions / <prefix>-naming-rules) that exists in
// .claude/skills must be listed by every agent that lists the matching std-<suffix> skill — otherwise the org style
// is written but never loaded (P10). `sfsmiths-human sync` (or `conventions build`) wires it; this check catches drift.
const skillsDir = path.join(repo, ".claude", "skills");
const generated = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((d) => /^(?!std-)[a-z0-9]+-(comment-conventions|naming-rules)$/.test(d) && fs.existsSync(path.join(skillsDir, d, "SKILL.md"))) : [];
for (const g of generated) {
  const suffix = g.replace(/^[a-z0-9]+-/, "");
  for (const f of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(agentsDir, f), "utf8"))?.[1] ?? "";
    if (new RegExp(`^\\s*-\\s+std-${suffix}\\s*$`, "m").test(fm) && !new RegExp(`^\\s*-\\s+${g}\\s*$`, "m").test(fm)) fail(`.claude/agents/${f}: lists std-${suffix} but not the generated org skill ${g} — run \`sfsmiths-human sync\` (D-096)`);
  }
}

// 8 — D-101: the intake and plan skeletons carry the "Picture" sections (ASCII + mermaid + worked example) the human asked for
//     (only when templates/ is present — test fixtures copy the Claude Code layer alone)
if (fs.existsSync(path.join(repo, "templates"))) {
  for (const [f, heading] of [["templates/01-intake.md", "## 2a. Picture"], ["templates/03-plan.md", "### 3a. Picture"]]) {
    const t = fs.existsSync(path.join(repo, f)) ? read(f) : "";
    if (!t.includes(heading)) fail(`${f}: missing "${heading}" section (D-101)`);
    if (!/```mermaid/.test(t)) fail(`${f}: missing a mermaid block in the Picture section (D-101)`);
  }
}

// 7 — agents never browse the web (P12): knowledge comes from the human-refreshed docs mirror and curated notes only
for (const f of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(agentsDir, f), "utf8"))?.[1] ?? "";
  const tools = /^tools:\s*(.+)$/m.exec(fm)?.[1] ?? "";
  const disallowed = /^disallowedTools:\s*(.+)$/m.exec(fm)?.[1] ?? "";
  for (const t of ["WebFetch", "WebSearch"]) {
    if (tools.split(",").map((s) => s.trim()).includes(t)) fail(`.claude/agents/${f}: tools must not include ${t} (P12: agents never browse)`);
    if (!disallowed.split(",").map((s) => s.trim()).includes(t)) fail(`.claude/agents/${f}: disallowedTools must include ${t} (P12: agents never browse)`);
  }
}

if (problems.length) {
  console.error(`repo-checks: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`repo-checks: ok (hooks wired: ${REQUIRED_HOOKS.length}, agents: ${agentNames.size}, marketplace pinned)`);
