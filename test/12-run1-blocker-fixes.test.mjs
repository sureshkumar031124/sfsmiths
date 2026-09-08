/**
 * Run 1 (DEMO-101) blocker + cost fixes, from beta testing on the first real machine.
 *
 *   D-093  a live subagent is never a failed stage: `run_in_background` is denied, the stage-gate stamps
 *          `agent_ended_at`, the handoff answers WAIT_AGENT while no end is stamped (bounded), a system
 *          <task-notification> is not vault evidence, and `/resume` recovers a stage whose gates all pass.
 *   D-094  budgets are judged on FRESH tokens and prices ship, so cost is never silently $0.
 *   D-095  reasoning effort is per-agent config, synced into the agent files and recorded with every run.
 *
 * What actually happened in Run 1: the conductor spawned a1-intake in the background, its turn ended, the Stop
 * hook blocked, `handoff` read `status: running` as "the agent died", bounced the stage, spawned a SECOND
 * a1-intake in parallel and escalated 40 s in — while both agents were still working. Both later passed their
 * gates with 21 evidence refs each.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, cleanup, runHook, REPO } from "./helpers.mjs";
import { projectPaths } from "../dist/core/paths.js";
import { loadConfig, loadConfigFile, writeConfigFile, EFFORT_LEVELS } from "../dist/core/config.js";
import { newManifest, saveManifest, loadManifest, recordGate, stageRecord } from "../dist/core/manifest.js";
import { decideHandoff, markStageDone, markAgentEnded, clearAgentEnd, AGENT_WAIT_CAP, AGENT_NAMES } from "../dist/core/state-machine.js";
import { isBackgroundSpawn } from "../dist/hooks/fast.js";
import { isTaskNotification } from "../dist/hooks/heavy.js";
import { freshTokens, priceFor, loadPrices, effortForAgent, recordAgentRun } from "../dist/engines/tokens.js";
import { syncAgentModels } from "../dist/engines/sync.js";
import { recoverFinishedStage } from "../dist/engines/lifecycle.js";

/** a project whose ticket is mid-prior_art with a1-intake spawned and nothing reported back yet */
function runningStage(root, stage = "prior_art") {
  const p = projectPaths(root);
  const cfg = loadConfig(p, { fresh: true });
  const m = newManifest("DEMO-101", "file", "demo");
  stageRecord(m, "open").status = "done";
  m.stage = stage;
  const rec = stageRecord(m, stage);
  rec.status = "running";
  rec.attempts = 1;
  rec.agent = "a1-intake";
  rec.started_at = new Date().toISOString();
  m.next_allowed_stages = ["a1-intake"];
  saveManifest(m, p);
  return { p, cfg, m };
}

/* ─────────────────────────── D-093 ─────────────────────────── */

test("D-093 a: isBackgroundSpawn catches every spelling a background Agent call could use", () => {
  for (const k of ["run_in_background", "runInBackground", "background", "async", "is_async", "isAsync"]) {
    assert.equal(isBackgroundSpawn({ subagent_type: "a1-intake", [k]: true }), true, `${k}: true must be background`);
    assert.equal(isBackgroundSpawn({ subagent_type: "a1-intake", [k]: "true" }), true, `${k}: "true" must be background`);
  }
  assert.equal(isBackgroundSpawn({ subagent_type: "a1-intake" }), false);
  assert.equal(isBackgroundSpawn({ subagent_type: "a1-intake", run_in_background: false }), false);
});

test("D-093 a: the agent-gate hook DENIES a background spawn of an otherwise allowed agent", () => {
  const root = makeProject();
  try {
    const { p } = runningStage(root);
    fs.mkdirSync(path.join(root, ".sfsmiths", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sfsmiths", "sessions", "test-session.json"), JSON.stringify({ ticket: "DEMO-101", conductor: true }));
    // control: the same agent in the foreground is allowed
    const fg = runHook(root, "agent-gate", { tool_name: "Agent", tool_input: { subagent_type: "a1-intake" }, agent_type: "conductor" });
    assert.equal(fg.denied, false, `foreground spawn must be allowed, got: ${fg.reason}`);
    // the fix: background is denied, and the reason tells the conductor what to do instead
    const bg = runHook(root, "agent-gate", { tool_name: "Agent", tool_input: { subagent_type: "a1-intake", run_in_background: true }, agent_type: "conductor" });
    assert.equal(bg.denied, true, "background spawn must be denied");
    assert.match(bg.reason, /FOREGROUND/i);
    // and it is logged as evidence
    const events = fs.readFileSync(path.join(root, ".sfsmiths", "events.jsonl"), "utf8");
    assert.match(events, /"type":"agent\.spawn_denied"/);
    assert.match(events, /"reason":"background"/);
    assert.ok(p);
  } finally { cleanup(root); }
});

test("D-093 b: a running stage with NO recorded agent end answers WAIT_AGENT — never a bounce, never an escalation", () => {
  const root = makeProject();
  try {
    const { cfg, m } = runningStage(root);
    const before = m.bounces.length;
    const r = decideHandoff(m, cfg);
    assert.equal(r.decision.action, "WAIT_AGENT", "a live agent must not be read as a failure");
    assert.equal(r.decision.agent, "a1-intake");
    assert.equal(r.decision.stage, "prior_art");
    assert.equal(r.manifest.bounces.length, before, "no bounce");
    assert.equal(r.manifest.status, "running");
    assert.notEqual(r.manifest.status, "escalated");
    assert.equal(r.manifest.stages.prior_art.attempts, 1, "attempt counter must not move");
  } finally { cleanup(root); }
});

test("D-093 b: once the stage-gate stamps agent_ended_at, the same state IS a failure (the old behaviour, correctly conditioned)", () => {
  const root = makeProject();
  try {
    const { cfg, m } = runningStage(root);
    markAgentEnded(m, "prior_art");
    const r = decideHandoff(m, cfg);
    assert.notEqual(r.decision.action, "WAIT_AGENT");
    assert.equal(r.manifest.stages.prior_art.status, "running", "the bounce restarts the same stage");
    assert.equal(r.manifest.bounces.length, 1, "a genuinely ended agent with no passing gates bounces");
    assert.match(r.manifest.bounces[0].reason, /retry with the gate report/);
  } finally { cleanup(root); }
});

test("D-093 b: WAIT_AGENT is bounded — after AGENT_WAIT_CAP waits it escalates honestly instead of waiting forever", () => {
  const root = makeProject();
  try {
    const { cfg, m } = runningStage(root);
    let last;
    for (let i = 0; i < AGENT_WAIT_CAP; i++) {
      last = decideHandoff(m, cfg);
      assert.equal(last.decision.action, "WAIT_AGENT", `wait ${i + 1} of ${AGENT_WAIT_CAP} must still wait`);
      assert.equal(last.decision.waits, i + 1);
    }
    // past the cap it stops waiting and enters the normal bounce ladder (D-075: one retry, then escalate)
    const after = decideHandoff(last.manifest, cfg);
    assert.notEqual(after.decision.action, "WAIT_AGENT", "the wait must not be unbounded");
    assert.equal(after.decision.action, "SPAWN", "the first failure retries the stage");
    assert.match(after.manifest.stages.prior_art.note ?? "", /never reported back/, "the honest reason is recorded");
    assert.equal(after.manifest.bounces.length, 1);
    // attempt 2's agent also never reports back → the cap is hit again → this time it escalates
    let m2 = after.manifest;
    for (let i = 0; i <= AGENT_WAIT_CAP; i++) m2 = decideHandoff(m2, cfg).manifest;
    assert.equal(m2.status, "escalated", "a second silent agent escalates instead of looping");
    assert.match(m2.escalation.reason, /never reported back/);
  } finally { cleanup(root); }
});

test("D-093 b: a new attempt clears the stamp, so the next agent is not judged by the last one's end", () => {
  const root = makeProject();
  try {
    const { cfg, m } = runningStage(root);
    markAgentEnded(m, "prior_art");
    assert.ok(m.stages.prior_art.agent_ended_at);
    const bounced = decideHandoff(m, cfg).manifest;          // bounce → attempt 2 spawned
    assert.equal(bounced.stages.prior_art.attempts, 2);
    assert.equal(bounced.stages.prior_art.agent_ended_at, undefined, "the new attempt starts with no recorded end");
    assert.equal(decideHandoff(bounced, cfg).decision.action, "WAIT_AGENT", "attempt 2's live agent waits again");
  } finally { cleanup(root); }
});

test("D-093 b: clearAgentEnd resets the wait counter too", () => {
  const rec = { agent_ended_at: "2026-09-07T10:00:00.000Z", agent_waits: 5 };
  clearAgentEnd(rec);
  assert.equal(rec.agent_ended_at, undefined);
  assert.equal(rec.agent_waits, 0);
});

test("D-093 b: the sidecar the fast hooks read carries agent_ended_at", () => {
  const root = makeProject();
  try {
    const { p, m } = runningStage(root);
    saveManifest(m, p);
    const before = JSON.parse(fs.readFileSync(path.join(root, "work", "DEMO-101", ".state.json"), "utf8"));
    assert.equal(before.agent_ended_at, null, "a live agent has no end in the sidecar");
    markAgentEnded(m, "prior_art");
    saveManifest(m, p);
    const after = JSON.parse(fs.readFileSync(path.join(root, "work", "DEMO-101", ".state.json"), "utf8"));
    assert.ok(after.agent_ended_at, "the stamp reaches the sidecar");
  } finally { cleanup(root); }
});

test("D-093 e: a <task-notification> is a system message — recognised, never filed as human-pasted evidence", () => {
  const real = [
    "<task-notification>\n<task-id>afe893ca2699bba65</task-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n</task-notification>",
    "<task-id>abc123</task-id>\n<tool-use-id>toolu_01</tool-use-id>",
  ];
  for (const s of real) assert.equal(isTaskNotification(s), true);
  // a human describing one, or pasting a real ticket, is NOT a notification
  assert.equal(isTaskNotification("the task notification said it finished, please continue"), false);
  assert.equal(isTaskNotification("Steps to reproduce: open the case, set priority to Critical. Expected: owner kept."), false);
});

test("D-093 e: the prompt-router keeps a task-notification out of 00-inbox and points at the handoff instead", () => {
  const root = makeProject();
  try {
    runningStage(root);
    fs.writeFileSync(path.join(root, ".sfsmiths", "sessions", "test-session.json"), JSON.stringify({ ticket: "DEMO-101", conductor: true }));
    const notification = `<task-notification>\n<task-id>afe893ca2699bba65</task-id>\n<output-file>/tmp/a.output</output-file>\n<status>completed</status>\n</task-notification>\n${"filler ".repeat(120)}ticket acceptance expected actual`;
    const r = runHook(root, "prompt-router", { prompt: notification, agent_type: "conductor" });
    assert.equal(r.code, 0);
    const inbox = path.join(root, "work", "DEMO-101", "00-inbox");
    const files = fs.existsSync(inbox) ? fs.readdirSync(inbox) : [];
    assert.deepEqual(files, [], "a system notification must not become vault evidence");
    assert.match(r.stdout, /handoff/, "the conductor is told to run the handoff");
    // control: a genuine human paste of the same length IS kept
    const paste = `${"Steps to reproduce: ".repeat(30)}expected actual acceptance ticket`;
    runHook(root, "prompt-router", { prompt: paste, agent_type: "conductor" });
    assert.equal(fs.readdirSync(inbox).length, 1, "a real paste is still filed as evidence");
    assert.match(fs.readFileSync(path.join(inbox, fs.readdirSync(inbox)[0]), "utf8"), /source="human-paste"/);
  } finally { cleanup(root); }
});

test("D-093 c: recovery — a failed stage whose gates all re-pass becomes done, with no agent re-run", async () => {
  const root = makeProject();
  try {
    const { p, m } = runningStage(root);
    // the vault as Run 1 left it: the agent's output IS there and valid, but the stage was marked failed
    const vault = path.join(root, "work", "DEMO-101");
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, "00c-prior-art.md"), "# Prior art\n\nNothing related found; every surface returned zero with a control.\n");
    fs.writeFileSync(path.join(vault, "00c-prior-art.json"), JSON.stringify({
      ticket: "DEMO-101",
      searched: { keywords: ["case owner", "priority critical"], objects: ["Case"], components: [] },
      related: [], tracker_hits: [], history: [], lessons: [],
      digest: [
        "No related ticket found on any surface — each zero is reported with the control that proves the search worked.",
        "git history is UNKNOWN, not zero: org/force-app holds no metadata in a development-only run.",
      ],
      evidence: [{ source: "vault", ref: "00c-prior-art.md", note: "this report" }],
    }, null, 2));
    const rec = stageRecord(m, "prior_art");
    rec.status = "failed";
    rec.note = "agent ended without passing stage gates";
    m.status = "escalated";
    m.escalation = { at: new Date().toISOString(), reason: "prior_art failed 2×", stage: "prior_art" };
    m.waiting = { kind: "question", stage: "prior_art", prompt: "human decision needed", since: new Date().toISOString() };
    saveManifest(m, p);

    const out = await recoverFinishedStage(loadManifest("DEMO-101", p), p);
    assert.ok(out, "recovery must run on a failed agent stage");
    assert.equal(out.recovered, true, `expected recovery, got: ${out.note}`);
    const after = loadManifest("DEMO-101", p);
    assert.equal(after.stages.prior_art.status, "done");
    assert.equal(after.status, "running", "the escalation is cleared");
    assert.equal(after.escalation, null);
    assert.equal(after.stages.prior_art.attempts, 1, "no new attempt — the agent is not re-run");
    assert.ok(after.stages.prior_art.agent_ended_at, "the recovered stage records an end");
    assert.match(fs.readFileSync(path.join(root, ".sfsmiths", "events.jsonl"), "utf8"), /"type":"stage\.recovered"/);
  } finally { cleanup(root); }
});

test("D-093 c: recovery is DECLINED when the artifact is not actually valid (no free pass)", async () => {
  const root = makeProject();
  try {
    const { p, m } = runningStage(root);
    const vault = path.join(root, "work", "DEMO-101");
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, "00c-prior-art.md"), "# Prior art\n");
    fs.writeFileSync(path.join(vault, "00c-prior-art.json"), "{ this is not valid json");
    stageRecord(m, "prior_art").status = "failed";
    m.status = "escalated";
    saveManifest(m, p);
    const out = await recoverFinishedStage(loadManifest("DEMO-101", p), p);
    assert.equal(out.recovered, false);
    assert.equal(loadManifest("DEMO-101", p).stages.prior_art.status, "failed", "a broken artifact stays failed");
  } finally { cleanup(root); }
});

test("D-093 c: recovery never touches a stage that is merely running, or a human/toolkit stage", async () => {
  const root = makeProject();
  try {
    const { p, m } = runningStage(root);                       // status: running, not failed
    assert.equal(await recoverFinishedStage(m, p), undefined);
    const human = runningStage(root, "deploy_uat");            // human stage, no gates
    assert.equal(await recoverFinishedStage(human.m, human.p), undefined);
  } finally { cleanup(root); }
});

/* ─────────────────────────── D-094 ─────────────────────────── */

test("D-094: freshTokens excludes cache reads — Run 1's real numbers", () => {
  // a1-intake, first run, from metrics/agent-runs.jsonl
  const usage = { input_tokens: 122, output_tokens: 24_346, cache_read_input_tokens: 12_593_461, cache_creation_input_tokens: 681_675 };
  const total = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  assert.equal(total, 13_299_604, "the total that crossed a 1.5M budget 21× over");
  assert.equal(freshTokens(usage), 706_143, "what actually cost fresh context — under the same budget");
  assert.ok(freshTokens(usage) < 1_500_000);
});

test("D-094: default prices ship, so a run records a real cost instead of $0", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const prices = loadPrices(p);
    assert.ok(prices, "prices must come from config/budgets.yaml when metrics/prices.json is absent");
    assert.ok(priceFor("claude-opus-5", prices), "an opus model id must match the `opus` key");
    assert.ok(priceFor("claude-sonnet-4-5", prices));
    assert.equal(priceFor("some-unknown-model", prices), undefined, "an unknown model is an honest unknown, not a wrong number");
    const run = recordAgentRun({
      ticket: undefined, agent: "a1-intake", model: "claude-opus-5", source: "transcript", total_tokens: 13_299_604,
      usage: { input_tokens: 122, output_tokens: 24_346, cache_read_input_tokens: 12_593_461, cache_creation_input_tokens: 681_675 },
    }, p);
    assert.ok(run.usd > 0, `cost must not be 0, got ${run.usd}`);
    assert.equal(run.fresh_tokens, 706_143);
  } finally { cleanup(root); }
});

test("D-094: metrics/prices.json still overrides the shipped defaults", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    fs.writeFileSync(path.join(root, "metrics", "prices.json"), JSON.stringify({ opus: { input: 1, output: 1, cache_read: 1, cache_write: 1 } }));
    const pr = priceFor("claude-opus-5", loadPrices(p));
    assert.equal(pr.input, 1, "the operator's own file wins");
  } finally { cleanup(root); }
});

test("D-094: the manifest tracks fresh tokens and the raw total separately", () => {
  const root = makeProject();
  try {
    const { p, m } = runningStage(root);
    saveManifest(m, p);
    recordAgentRun({
      ticket: "DEMO-101", agent: "a1-intake", model: "claude-opus-5", source: "transcript", total_tokens: 13_299_604,
      usage: { input_tokens: 122, output_tokens: 24_346, cache_read_input_tokens: 12_593_461, cache_creation_input_tokens: 681_675 },
    }, p);
    const after = loadManifest("DEMO-101", p);
    assert.equal(after.budget.tokens, 13_299_604);
    assert.equal(after.budget.fresh_tokens, 706_143);
    assert.ok(after.budget.usd > 0);
  } finally { cleanup(root); }
});

/* ─────────────────────────── D-095 ─────────────────────────── */

test("D-095: every agent has a configured effort, and every value is one Claude Code accepts", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const cfg = loadConfig(p, { fresh: true });
    const allowed = new Set([...EFFORT_LEVELS, "inherit"]);
    for (const agent of AGENT_NAMES) {
      const e = cfg.models.effort?.[agent] ?? cfg.models.fallback_effort;
      assert.ok(e, `${agent} has no effort and there is no fallback_effort`);
      assert.ok(allowed.has(e), `${agent}: effort "${e}" is not one of ${[...allowed].join("|")}`);
    }
    assert.ok(allowed.has(cfg.models.fallback_effort ?? "inherit"));
    // the conductor is a router: it must not be configured to deliberate
    assert.equal(cfg.models.effort.conductor, "low");
  } finally { cleanup(root); }
});

test("D-095: sync writes the effort line next to model, and `inherit` removes it (session level applies)", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const models = loadConfigFile("models", p);
    models.effort = { ...models.effort, "a1-intake": "max", "a9-comms": "inherit" };
    writeConfigFile("models", models, p);
    const cfg = loadConfig(p, { fresh: true });
    const warnings = [];
    syncAgentModels(p, cfg, warnings);
    assert.deepEqual(warnings, []);

    const fm = (agent) => fs.readFileSync(path.join(root, ".claude", "agents", `${agent}.md`), "utf8").split("\n---")[0].split("\n");
    const a1 = fm("a1-intake");
    const mi = a1.findIndex((l) => l.startsWith("model:"));
    assert.equal(a1[mi + 1], "effort: max", "effort sits directly after model, never under a block list");
    assert.equal(a1.filter((l) => l.startsWith("effort:")).length, 1, "no duplicate effort lines");
    assert.equal(fm("a9-comms").some((l) => l.startsWith("effort:")), false, "`inherit` writes no line at all");

    // idempotent: syncing twice changes nothing further
    const before = fs.readFileSync(path.join(root, ".claude", "agents", "a1-intake.md"), "utf8");
    syncAgentModels(p, cfg, []);
    assert.equal(fs.readFileSync(path.join(root, ".claude", "agents", "a1-intake.md"), "utf8"), before);
  } finally { cleanup(root); }
});

test("D-095: sync leaves every other frontmatter key alone (tools, disallowedTools, skills, background)", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const file = path.join(root, ".claude", "agents", "a2-repro.md");
    const keysOf = (t) => t.split("\n---")[0].split("\n").filter((l) => /^[a-zA-Z]+:/.test(l)).map((l) => l.split(":")[0]);
    const before = keysOf(fs.readFileSync(file, "utf8"));
    syncAgentModels(p, loadConfig(p, { fresh: true }), []);
    const after = keysOf(fs.readFileSync(file, "utf8"));
    for (const k of before) assert.ok(after.includes(k), `sync dropped frontmatter key "${k}"`);
    assert.ok(after.includes("effort"));
  } finally { cleanup(root); }
});

test("D-095: an invalid effort value warns and falls back to the session level instead of writing rubbish", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const cfg = loadConfig(p, { fresh: true });
    cfg.models.effort = { ...cfg.models.effort, "a5-qa": "turbo" };   // not a Claude Code level
    const warnings = [];
    syncAgentModels(p, cfg, warnings);
    assert.ok(warnings.some((w) => /a5-qa/.test(w) && /turbo/.test(w)), `expected a warning, got ${JSON.stringify(warnings)}`);
    const fm = fs.readFileSync(path.join(root, ".claude", "agents", "a5-qa.md"), "utf8").split("\n---")[0];
    assert.equal(/^effort:/m.test(fm), false, "an invalid level must not be written into the agent file");
  } finally { cleanup(root); }
});

test("D-095: effort is recorded with every run, so a token number can be interpreted later", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    assert.equal(effortForAgent("a2-repro", p), "xhigh");
    assert.equal(effortForAgent("conductor", p), "low");
    const run = recordAgentRun({ agent: "a3-architect", model: "claude-opus-5", source: "transcript", total_tokens: 100, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 10 } }, p);
    assert.equal(run.effort, "xhigh");
    const line = JSON.parse(fs.readFileSync(path.join(root, "metrics", "agent-runs.jsonl"), "utf8").trim().split("\n").pop());
    assert.equal(line.effort, "xhigh");
    assert.equal(line.fresh_tokens, 30);
  } finally { cleanup(root); }
});

test("D-095: the shipped agent files carry the configured effort and never run in the background", () => {
  const agentsDir = path.join(REPO, ".claude", "agents");
  const specialists = AGENT_NAMES.filter((a) => a !== "conductor");
  for (const agent of AGENT_NAMES) {
    const fm = fs.readFileSync(path.join(agentsDir, `${agent}.md`), "utf8").split("\n---")[0];
    const effort = /^effort:\s*(\S+)/m.exec(fm)?.[1];
    assert.ok(effort && EFFORT_LEVELS.includes(effort), `${agent}: effort line missing or invalid (${effort}) — run sfsmiths-human sync`);
    if (specialists.includes(agent)) assert.match(fm, /^background:\s*false$/m, `${agent}: must declare background: false (D-093 belt)`);
  }
});
