import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, cleanup } from "./helpers.mjs";
import { loadConfig } from "../dist/core/config.js";
import { projectPaths } from "../dist/core/paths.js";
import { newManifest, saveManifest, loadManifest, recordGate, stageRecord, stageGatesAllPassed } from "../dist/core/manifest.js";
import { decideHandoff, markStageDone, applyTier, humanGateMode, STAGE_BY_ID, STAGES, bounceTarget } from "../dist/core/state-machine.js";
import { recordApproval } from "../dist/engines/approvals.js";

function fresh(root) {
  const p = projectPaths(root);
  const cfg = loadConfig(p, { fresh: true });
  const m = newManifest("DEMO-101", "file", "demo");
  stageRecord(m, "open").status = "done";
  m.stage = "open";
  saveManifest(m, p);
  return { p, cfg, m };
}

test("stage order: open → prior_art(a1) → intake(a1) → baseline(a0b) → cartography(a0) → repro(a2) → plan(a3) → …", () => {
  const ids = STAGES.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 8), ["open", "prior_art", "intake", "baseline", "cartography", "repro", "plan", "develop"]);
  assert.equal(STAGE_BY_ID.prior_art.agent, "a1-intake");
  assert.equal(STAGE_BY_ID.deploy_uat.always_human, true);
  assert.equal(STAGE_BY_ID.deploy_prod.always_human, true);
});

test("first handoff after open spawns a1-intake for prior_art and restricts next_allowed_stages", () => {
  const root = makeProject();
  try {
    const { p, cfg, m } = fresh(root);
    const r = decideHandoff(m, cfg);
    assert.equal(r.decision.action, "SPAWN");
    assert.equal(r.decision.agent, "a1-intake");
    assert.equal(r.decision.stage, "prior_art");
    assert.ok(r.decision.allowed_agents.includes("a1-intake"));
    assert.ok(!r.decision.allowed_agents.includes("a4-developer"), "developer not allowed at prior_art");
    saveManifest(r.manifest, p);
    const sidecar = JSON.parse(require_fs().readFileSync(`${root}/work/DEMO-101/.state.json`, "utf8"));
    assert.equal(sidecar.status, "running");
    assert.ok(sidecar.next_allowed_stages.includes("a1-intake"));
  } finally { cleanup(root); }
});

test("gates decide: stage done but gate failed → bounce/retry; passed + auto tier → advance; passed + ask → WAIT_HUMAN", () => {
  const root = makeProject();
  try {
    const { p, cfg, m } = fresh(root);
    let r = decideHandoff(m, cfg); // SPAWN a1 prior_art
    // simulate: agent finished, gate failed
    recordGate(r.manifest, "prior_art", { name: "contract-check", status: "failed", reason: "missing 00c-prior-art.json" });
    markStageDone(r.manifest, "prior_art");
    r = decideHandoff(r.manifest, cfg);
    assert.equal(r.decision.action, "SPAWN", "failed gate → stage re-run");
    assert.equal(r.decision.stage, "prior_art");
    assert.equal(r.decision.attempt, 2);
    // now pass
    recordGate(r.manifest, "prior_art", { name: "contract-check", status: "passed" });
    markStageDone(r.manifest, "prior_art");
    r = decideHandoff(r.manifest, cfg);
    assert.equal(r.decision.action, "SPAWN");
    assert.equal(r.decision.stage, "intake", "prior_art has no human gate → advance to intake");
    // intake: pass gates; tier UNSET → risk-floor gate sets it; emulate HIGH → intake gate is ask
    recordGate(r.manifest, "intake", { name: "contract-check", status: "passed" });
    recordGate(r.manifest, "intake", { name: "risk-floor", status: "passed" });
    applyTier(r.manifest, "HIGH", "risk-floor");
    markStageDone(r.manifest, "intake");
    r = decideHandoff(r.manifest, cfg);
    assert.equal(r.decision.action, "WAIT_HUMAN");
    assert.equal(r.decision.kind, "approval");
    assert.equal(r.decision.stage, "intake");
    saveManifest(r.manifest, p);
    // human approves through the approvals engine (origin cli) → advance to baseline
    recordApproval({ ticket: "DEMO-101", decision: "approved", origin: "cli" }, p);
    const m2 = loadManifest("DEMO-101", p);
    const r2 = decideHandoff(m2, cfg);
    assert.equal(r2.decision.action, "SPAWN");
    assert.equal(r2.decision.agent, "a0b-baseline");
  } finally { cleanup(root); }
});

test("tier can only be raised, never lowered", () => {
  const m = newManifest("DEMO-102", "file");
  applyTier(m, "MEDIUM", "risk-floor");
  applyTier(m, "LOW", "provisional");
  assert.equal(m.tier, "MEDIUM");
  applyTier(m, "HIGH", "human");
  assert.equal(m.tier, "HIGH");
});

test("humanGateMode: LOW/auto everywhere; HIGH ask; per-agent ask overlay wins over auto", () => {
  const root = makeProject();
  try {
    const { cfg } = fresh(root);
    const m = newManifest("DEMO-103", "file");
    applyTier(m, "LOW", "risk-floor");
    assert.equal(humanGateMode(m, STAGE_BY_ID.plan, cfg), "auto");
    applyTier(m, "HIGH", "human");
    assert.equal(humanGateMode(m, STAGE_BY_ID.plan, cfg), "ask");
    const cfg2 = { ...cfg, autonomy: { ...cfg.autonomy, agents: { ...cfg.autonomy.agents, "a3-architect": "ask" } } };
    const m2 = newManifest("DEMO-104", "file");
    applyTier(m2, "LOW", "risk-floor");
    assert.equal(humanGateMode(m2, STAGE_BY_ID.plan, cfg2), "ask", "per-agent ask overrides tier auto");
    assert.equal(humanGateMode(m2, STAGE_BY_ID.intake, cfg2), "auto");
  } finally { cleanup(root); }
});

test("bounce ladder: qa fail → develop → plan → escalate; repro escalates after 2", () => {
  const m = newManifest("DEMO-105", "file");
  const b1 = bounceTarget(m, "qa_dev");
  assert.equal(b1.to, "develop");
  m.bounces.push({ from: "qa_dev", to: "develop", at: "x", reason: "r" });
  const b2 = bounceTarget(m, "qa_dev");
  assert.equal(b2.to, "plan");
  m.bounces.push({ from: "qa_dev", to: "plan", at: "x", reason: "r" });
  const b3 = bounceTarget(m, "qa_dev");
  assert.ok("escalate" in b3);
  const rm = newManifest("DEMO-106", "file");
  stageRecord(rm, "repro").attempts = 2;
  assert.ok("escalate" in bounceTarget(rm, "repro"));
});

test("stageGatesAllPassed: unavailable is not passed", () => {
  const m = newManifest("DEMO-107", "file");
  recordGate(m, "repro", { name: "email-guard", status: "passed" });
  recordGate(m, "repro", { name: "assertion-referee", status: "unavailable", reason: "no run file" });
  const r = stageGatesAllPassed(m, "repro", ["email-guard", "assertion-referee", "naming-lint"]);
  assert.equal(r.ok, false);
  assert.equal(r.failing.length, 1);
  assert.deepEqual(r.missing, ["naming-lint"]);
});

test("budget exceeded parks the ticket (resumable, never silently continues)", () => {
  const root = makeProject();
  try {
    const { cfg, m } = fresh(root);
    m.budget.tokens = cfg.budgets.per_ticket.tokens + 1;
    const r = decideHandoff(m, cfg);
    assert.equal(r.decision.action, "PARKED");
    assert.equal(r.manifest.status, "parked");
    assert.equal(r.manifest.waiting.kind, "budget");
  } finally { cleanup(root); }
});

import fsMod from "node:fs";
function require_fs() { return fsMod; }
