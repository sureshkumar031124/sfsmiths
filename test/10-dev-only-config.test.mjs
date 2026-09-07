/**
 * A development-sandbox-only configuration (no preprod, no evidence org) — the recommended first run on a new machine:
 * the preprod stages are skipped, and production verify records a skip instead of failing checks it cannot run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeProject, cleanup, agentCli, writeJson, REPO } from "./helpers.mjs";
const require_child = () => createRequire(import.meta.url)("node:child_process");
import { projectPaths } from "../dist/core/paths.js";
import { newManifest, loadManifest, saveManifest, stageRecord } from "../dist/core/manifest.js";
import { nextStageId } from "../dist/core/state-machine.js";
import { prodVerify } from "../dist/engines/lifecycle.js";

const T = "DEMO-101";

/** keep only the development org in config/orgs.yaml */
function devOnly(root) {
  const file = path.join(root, "config", "orgs.yaml"); // personal copy, written from the tracked default
  const lines = fs.readFileSync(path.join(root, "config", "defaults", "orgs.yaml"), "utf8").split("\n");
  const cut = lines.findIndex((l) => /^\s+- alias: PartialUAT/.test(l));
  fs.writeFileSync(file, lines.slice(0, cut).join("\n") + "\n");
}

test("no_preprod skips BOTH preprod stages: comms → deploy_prod (deploy_uat and qa_uat marked skipped)", () => {
  const m = newManifest(T, "file");
  m.flags["no_preprod"] = true;
  assert.equal(nextStageId(m, "comms"), "deploy_prod");
  assert.equal(stageRecord(m, "deploy_uat").status, "skipped");
  assert.equal(stageRecord(m, "qa_uat").status, "skipped");
  // with a preprod org the human deploy stage is next, as before
  const m2 = newManifest("DEMO-102", "file");
  assert.equal(nextStageId(m2, "comms"), "deploy_uat");
});

test("prod_verify without an evidence org records a skip (no failing checks, no escalation) and the stage completes", async () => {
  const root = makeProject();
  try {
    devOnly(root);
    const p = projectPaths(root);
    assert.equal(agentCli(root, ["open", T]).code, 0);
    const vault = path.join(root, "work", T);
    writeJson(path.join(vault, "03-plan.json"), { prod_verification: [{ description: "no Critical case owned by a user", query: "SELECT COUNT() FROM Case WHERE Priority='Critical' AND Owner.Type='User'", expected: "0" }] });
    const m = loadManifest(T, p);
    m.stage = "prod_verify";
    stageRecord(m, "prod_verify").status = "running";
    saveManifest(m, p);

    const r = await prodVerify(T, { p });
    assert.deepEqual(r.results, []);
    const after = loadManifest(T, p);
    assert.equal(stageRecord(after, "prod_verify").status, "done");
    assert.match(stageRecord(after, "prod_verify").note ?? "", /no evidence org/);
    assert.match(fs.readFileSync(path.join(vault, "08-prod-verify.md"), "utf8"), /Skipped .* no org with role=evidence/);
    const val = JSON.parse(fs.readFileSync(path.join(vault, "validations", "prod_verify.json"), "utf8"));
    assert.equal(val.skipped, "no evidence org configured");
    const events = fs.readFileSync(path.join(vault, "events.jsonl"), "utf8");
    assert.match(events, /"prod\.verified"/);
    assert.doesNotMatch(events, /escalation/);
  } finally {
    cleanup(root);
  }
});

test("setup wizard: `none` clears the optional preprod/production orgs (Enter alone keeps the default)", () => {
  const root = makeProject();
  try {
    const { spawnSync } = require_child();
    // Enter on the e-mail question must keep the documentation-safe defaults (an empty --emails list used to blank them)
    const answers = ["DevSandbox", "none", "none", "file", "DEMO", "", "Test_Tag__c", "n", ""].join("\n");
    const r = spawnSync(process.execPath, [path.join(REPO, "bin", "sfsmiths-human.js"), "setup"], { cwd: root, input: answers, encoding: "utf8", env: { ...process.env, SFSMITHS_PROJECT_DIR: root } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const orgs = fs.readFileSync(path.join(root, "config", "orgs.yaml"), "utf8");
    assert.match(orgs, /alias: DevSandbox/);
    assert.doesNotMatch(orgs, /role: preprod/);
    assert.doesNotMatch(orgs, /role: evidence/);
    const safety = fs.readFileSync(path.join(root, "config", "safety.yaml"), "utf8");
    assert.match(safety, /"\*@example\.com"/); assert.match(safety, /"\*\.invalid"/);
    assert.match(r.stdout, /1\. sfsmiths-human org login --alias DevSandbox/);
    assert.doesNotMatch(r.stdout, /--keychain engine/);
  } finally {
    cleanup(root);
  }
});
