/**
 * Regression tests for the independent review findings: rejection re-runs the stage, support-agent flow,
 * coach verb allowed, comms-lint email rules, maintenance agents after done, mv of protected files denied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { makeProject, cleanup, runHook, agentCli, writeJson, write } from "./helpers.mjs";
import { projectPaths } from "../dist/core/paths.js";
import { loadManifest } from "../dist/core/manifest.js";
import { buildContext, runGate } from "../dist/gates/registry.js";

const T = "DEMO-101";
const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

test("/reject re-runs the stage with the reason; a later /approve advances", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const vault = path.join(root, "work", T);
    agentCli(root, ["open", T]);
    agentCli(root, ["handoff", T]);
    write(path.join(vault, "00c-prior-art.md"), "# x\n"); writeJson(path.join(vault, "00c-prior-art.json"), { ticket: T, related: [], tracker_hits: [], history: [], lessons: [], digest: [] });
    runHook(root, "stage-gate", { hook_event_name: "SubagentStop", agent_type: "a1-intake" });
    agentCli(root, ["handoff", T]); // → intake
    write(path.join(vault, "01-intake.md"), "# intake\n");
    write(path.join(vault, "ticket.md"), "x");
    writeJson(path.join(vault, "01-intake.json"), { classification: "BUG", summary: "Critical web cases lose their owner when priority flips", acceptance_criteria: [{ id: "AC1", text: "owner is the regional queue", source: "ticket.md" }], scope: [{ type: "ApexClass", api_name: "X", evidence: { source: "vault", ref: "ticket.md" } }], objects: ["Case"], touches: ["apex"], suggested_tier: "HIGH", keywords: [], questions: [] });
    runHook(root, "stage-gate", { hook_event_name: "SubagentStop", agent_type: "a1-intake" });
    let out = agentCli(root, ["handoff", T]).stdout; assert.match(out, /WAIT_HUMAN \(approval\) at stage "intake"/);
    const h = runHook(root, "prompt-router", { hook_event_name: "UserPromptSubmit", prompt: `/reject ${T} --reason "scope misses the trigger"`, agent_type: "conductor" });
    assert.equal(h.code, 0, h.stderr);
    out = agentCli(root, ["handoff", T]).stdout;
    assert.match(out, /ACTION: SPAWN subagent "a1-intake" for stage "intake" \(attempt 2\)/, out);
    assert.match(out, /scope misses the trigger/, "rejection reason reaches the prompt");
    const m = loadManifest(T, p);
    assert.equal(m.waiting, null); assert.equal(m.status, "running");
    // agent redoes intake, passes → asks again → approve → baseline
    runHook(root, "stage-gate", { hook_event_name: "SubagentStop", agent_type: "a1-intake" });
    out = agentCli(root, ["handoff", T]).stdout; assert.match(out, /WAIT_HUMAN \(approval\) at stage "intake"/);
    runHook(root, "prompt-router", { hook_event_name: "UserPromptSubmit", prompt: `/approve ${T}`, agent_type: "conductor" });
    out = agentCli(root, ["handoff", T]).stdout; assert.match(out, /SPAWN subagent "a0b-baseline"/);
  } finally { cleanup(root); }
});

test("support flow: specialist requests a UI observation → handoff spawns a8-ui → then re-spawns the specialist (same attempt)", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const vault = path.join(root, "work", T);
    agentCli(root, ["open", T]);
    // jump to repro by marking earlier stages done through the manifest is out of scope here — drive the real path quickly
    const done = (agent, files) => { for (const [f, c] of Object.entries(files)) (typeof c === "string" ? write : writeJson)(path.join(vault, f), c); runHook(root, "stage-gate", { hook_event_name: "SubagentStop", agent_type: agent }); agentCli(root, ["handoff", T]); };
    agentCli(root, ["handoff", T]);
    done("a1-intake", { "00c-prior-art.md": "# x\n", "00c-prior-art.json": { ticket: T, related: [], tracker_hits: [], history: [], lessons: [], digest: [] } });
    write(path.join(vault, "ticket.md"), "x");
    done("a1-intake", { "01-intake.md": "# x\n", "01-intake.json": { classification: "BUG", summary: "Screen flow hides the escalate button for support agents", acceptance_criteria: [{ id: "AC1", text: "owner is the regional queue", source: "ticket.md" }], scope: [{ type: "Flow", api_name: "Case_Escalate_Screen", evidence: { source: "vault", ref: "ticket.md" } }], objects: ["Case"], touches: ["flow", "ui"], suggested_tier: "LOW", keywords: [], questions: [] } });
    // MEDIUM tier (flow) → intake auto → baseline
    done("a0b-baseline", { "00b-baseline.md": "# b\n", "00b-baseline.json": { synced_at: "x", ancestor_source: "fingerprint", scope: [], components: [], excluded: [], stopped: false } });
    done("a0-cartographer", { "00d-cartography.md": "# m\n", "00d-cartography.json": { objects: [], automation: [], consumers: [], drift: [], unknowns: [] } });
    let m = loadManifest(T, p); assert.equal(m.stage, "repro");
    assert.ok(m.next_allowed_stages.includes("a8-ui"), "a8-ui allowed during repro");
    // a2 asks for a UI observation and stops
    write(path.join(vault, "ui-request.md"), "# observe\nOpen the case, click Escalate, expect the modal.\n");
    const s = runHook(root, "stage-gate", { hook_event_name: "SubagentStop", agent_type: "a2-repro", last_assistant_message: "Cannot see the modal from Apex. UI observation requested." });
    assert.equal(s.json, undefined, `no block on a clean support request: ${s.stdout}`);
    let out = agentCli(root, ["handoff", T]).stdout;
    assert.match(out, /SPAWN subagent "a8-ui" for stage "repro"/, out);
    assert.ok(!runHook(root, "agent-gate", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "a8-ui" } }).denied);
    // a8 stops (support agents have no gates)
    const s2 = runHook(root, "stage-gate", { hook_event_name: "SubagentStop", agent_type: "a8-ui" });
    assert.equal(s2.json, undefined);
    out = agentCli(root, ["handoff", T]).stdout;
    assert.match(out, /SPAWN subagent "a2-repro" for stage "repro" \(attempt 1\)/, out);
    m = loadManifest(T, p); assert.equal(m.bounces.length, 0, "no bounce recorded for a support round-trip");
  } finally { cleanup(root); }
});

test("policy: coach verbs allowed; human verbs still denied; moving/removing protected files denied; explicit org required", () => {
  const root = makeProject();
  try {
    assert.ok(!runHook(root, "policy", bash("sfsmiths agent learn-digest DEMO-101")).denied);
    assert.ok(!runHook(root, "policy", bash("sfsmiths agent feedback-note DEMO-101 'x'")).denied);
    assert.ok(runHook(root, "policy", bash("sfsmiths agent learn")).denied);
    assert.ok(runHook(root, "policy", bash("sfsmiths agent lessons approve L-1")).denied);
    assert.ok(runHook(root, "policy", bash("mv config/orgs.yaml /tmp/x.yaml")).denied);
    assert.ok(runHook(root, "policy", bash("git mv .claude/settings.json /tmp/s.json")).denied);
    assert.ok(runHook(root, "policy", bash("git rm -f CLAUDE.md")).denied);
    assert.ok(runHook(root, "policy", bash("sf data query -q 'SELECT Id FROM Case'")).denied, "no default org");
    assert.ok(!runHook(root, "policy", bash("sf data query -q 'SELECT Id FROM Case' -o DevSandbox")).denied);
    // data-guard: metadata deploy is not a data side effect; permission assignment is
    assert.ok(!runHook(root, "data-guard", { hook_event_name: "PreToolUse", tool_name: "mcp__sf-dev__deploy_metadata", tool_input: {} }).denied);
    assert.ok(runHook(root, "data-guard", { hook_event_name: "PreToolUse", tool_name: "mcp__sf-dev__assign_permission_set", tool_input: {} }).denied);
  } finally { cleanup(root); }
});

test("comms-lint: no emails at all in client drafts; only allowlisted test emails in internal drafts", async () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    agentCli(root, ["open", T]);
    const vault = path.join(root, "work", T);
    write(path.join(vault, "10-comms", "client-update.md"), "audience: client-visible\n\nPlease contact rollout.manager@example.com.\n");
    let r = await runGate("comms-lint", buildContext(T, "comms", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /no email addresses/);
    write(path.join(vault, "10-comms", "client-update.md"), "audience: client-visible\n\nThe fix is live.\n");
    write(path.join(vault, "10-comms", "internal-summary.md"), "audience: internal\n\nReporter: jane.doe@customer-university.edu\n");
    r = await runGate("comms-lint", buildContext(T, "comms", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /non-allowlisted email/);
    write(path.join(vault, "10-comms", "internal-summary.md"), "audience: internal\n\nTest user rollout.manager@example.com verified the fix.\n");
    r = await runGate("comms-lint", buildContext(T, "comms", {}, p), { persist: false });
    assert.equal(r.status, "passed", r.reason);
  } finally { cleanup(root); }
});
