/**
 * Full offline ticket simulation: the toolkit + hooks drive DEMO-101 from open to done with fixture agent outputs.
 * No Salesforce CLI, no Claude — this proves the choreography (stage order, gates, human gates, bounces, deploy marks).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { makeProject, cleanup, runHook, agentCli, humanCli, writeJson, write, readJson } from "./helpers.mjs";
import { projectPaths } from "../dist/core/paths.js";
import { loadManifest } from "../dist/core/manifest.js";
import { buildContext } from "../dist/gates/registry.js";
import { changedSourceFiles, hashFiles } from "../dist/gates/helpers.js";
import { readAllEvents } from "../dist/core/events.js";

const T = "DEMO-101";

test("DEMO-101 travels open → prior_art → intake → baseline → cartography → repro → plan → develop → qa_dev → review → comms → deploy_uat → qa_uat → deploy_prod → prod_verify → learn → done", async () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const vault = path.join(root, "work", T);
    const handoff = () => { const r = agentCli(root, ["handoff", T]); assert.equal(r.code, 0, r.stderr); return r.stdout; };
    const stop = (agent) => runHook(root, "stage-gate", { hook_event_name: "SubagentStop", agent_type: agent, agent_id: "x" });
    const human = (prompt) => runHook(root, "prompt-router", { hook_event_name: "UserPromptSubmit", prompt, agent_type: "conductor" });
    const expectSpawn = (out, agent, stage) => assert.match(out, new RegExp(`ACTION: SPAWN subagent "${agent}" for stage "${stage}"`), out.split("\n").slice(0, 3).join(" | "));
    const ev = () => { const e = { source: "vault", ref: "ticket.md" }; return e; };

    // open
    let r = agentCli(root, ["open", T]); assert.equal(r.code, 0, r.stderr);
    let out = handoff(); expectSpawn(out, "a1-intake", "prior_art");

    // prior_art: agent stops WITHOUT output → block (attempt 1/3), then writes → pass
    let s = stop("a1-intake");
    assert.equal(s.json?.decision, "block", `expected block, got ${s.stdout}`); assert.match(s.json.reason, /contract-check/);
    write(path.join(vault, "00c-prior-art.md"), "# prior art\nnothing relevant\n");
    writeJson(path.join(vault, "00c-prior-art.json"), { ticket: T, related: [], tracker_hits: [], history: [], lessons: [], digest: ["no prior work on Case owner assignment"] });
    s = stop("a1-intake"); assert.equal(s.json, undefined, `expected allow, got ${s.stdout}`);
    assert.equal(loadManifest(T, p).stages.prior_art.status, "done");
    out = handoff(); expectSpawn(out, "a1-intake", "intake");

    // intake: HIGH tier (Apex + permissions) → human gate asks
    write(path.join(vault, "01-intake.md"), "# intake\n");
    writeJson(path.join(vault, "01-intake.json"), { classification: "BUG", summary: "Critical web cases lose their owner when priority flips to Critical after the last release", acceptance_criteria: [{ id: "AC1", text: "Critical web cases are owned by the regional escalation queue", source: "ticket.md" }, { id: "AC2", text: "Non-critical cases keep their owner", source: "ticket.md" }], scope: [{ type: "ApexClass", api_name: "CaseEscalationOwnerService", evidence: ev() }, { type: "ApexTrigger", api_name: "CaseTrigger", evidence: ev() }], objects: ["Case"], touches: ["apex", "email"], suggested_tier: "MEDIUM", keywords: ["escalation", "owner", "critical"], questions: [] });
    s = stop("a1-intake"); assert.equal(s.json, undefined, s.stdout);
    let m = loadManifest(T, p); assert.equal(m.tier, "HIGH", "risk-floor raised MEDIUM → HIGH (apex + email)");
    out = handoff(); assert.match(out, /ACTION: WAIT_HUMAN \(approval\) at stage "intake"/);
    // the conductor may not spawn anything now
    assert.ok(runHook(root, "agent-gate", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "a0b-baseline" } }).denied);
    // the human approves by typing /approve — recorded by the prompt hook
    let h = human(`/approve ${T}`); assert.equal(h.code, 0, h.stderr); assert.match(h.stdout, /approved recorded/);
    out = handoff(); expectSpawn(out, "a0b-baseline", "baseline");

    // baseline (toolkit would write this after retrieving both orgs)
    write(path.join(vault, "00b-baseline.md"), "# baseline\nall identical\n");
    writeJson(path.join(vault, "00b-baseline.json"), { synced_at: new Date().toISOString(), ancestor_source: "fingerprint", scope: ["ApexClass:CaseEscalationOwnerService", "ApexTrigger:CaseTrigger"], components: [{ key: "ApexClass:CaseEscalationOwnerService", classification: "IDENTICAL", action: "none" }, { key: "ApexTrigger:CaseTrigger", classification: "UAT-NEWER", action: "take-uat", post_sync_equal: true }], excluded: [], stopped: false });
    s = stop("a0b-baseline"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); expectSpawn(out, "a0-cartographer", "cartography");

    // cartography
    write(path.join(vault, "00d-cartography.md"), "# map\n");
    writeJson(path.join(vault, "00d-cartography.json"), { objects: [{ api_name: "Case", fields: [{ api_name: "Priority", type: "picklist" }, { api_name: "OwnerId", type: "reference" }], evidence: [ev()] }], automation: [{ object: "Case", layer: "after_trigger", api_name: "CaseTrigger", active: true, evidence: [ev()] }], consumers: [], drift: [{ component: "ApexClass:CaseEscalationOwnerService", status: "identical" }], unknowns: [] });
    s = stop("a0-cartographer"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); expectSpawn(out, "a2-repro", "repro");

    // repro: test class + data script + failing/inverse run
    const cls = path.join(root, "org/force-app/main/default/classes");
    write(path.join(cls, "CaseEscalationOwnerAssignmentTest.cls"), `/**\n * @description Proves Critical web cases get the regional escalation queue as owner (bulk-safe).\n * Modification Log\n * 2026-09-05  ${T}  created — reproduces missing owner assignment\n */\n@IsTest\nprivate class CaseEscalationOwnerAssignmentTest {\n  /** @description FAILS on the bug */\n  @IsTest static void ownerIsAssignedWhenPriorityBecomesCritical() { System.assertEquals(1, 1, 'owner must be the queue'); }\n  /** @description INVERSE */\n  @IsTest static void nonCriticalCasesKeepTheirOwner() { System.assertEquals(1, 1, 'owner unchanged'); }\n}\n`);
    write(path.join(vault, "artifacts", "repro-data.apex"), "Contact c = new Contact(LastName='Manager', Email='rollout.manager@example.com', Test_Tag__c='[SFSMITHS DEMO-101]');");
    writeJson(path.join(vault, "validations", "tests-repro.json"), { apex: { tests: [{ FullName: "CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical", Outcome: "Fail" }, { FullName: "CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner", Outcome: "Pass" }] } });
    write(path.join(vault, "02-repro.md"), "# repro\n");
    writeJson(path.join(vault, "02-repro.json"), { failing_tests: ["CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical"], inverse_tests: ["CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner"], predicted_distribution: [{ description: "no Critical case owned by a user", query: "SELECT COUNT() FROM Case WHERE Priority='Critical' AND Owner.Type='User'", expected: "0" }], data_created: [{ object: "Case", count: 200, tag: "[SFSMITHS DEMO-101]" }], root_cause_hypothesis: "after-save flow clears OwnerId", confidence: 0.7, evidence: [ev()] });
    s = stop("a2-repro"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); expectSpawn(out, "a3-architect", "plan");

    // plan: oracle caches + full checklist answers; HIGH → typed answer required
    writeJson(path.join(root, ".sfsmiths/cache/describe/Case.json"), { object: "Case", fetched_at: new Date().toISOString(), fields: { Id: { type: "id", updateable: false }, Priority: { type: "picklist", updateable: true, createable: true }, OwnerId: { type: "reference", updateable: true, createable: true } } });
    writeJson(path.join(root, ".sfsmiths/cache/metadata/ApexClass.json"), { type: "ApexClass", fetched_at: new Date().toISOString(), names: ["CaseEscalationOwnerService", "CaseEscalationOwnerAssignmentTest"] });
    writeJson(path.join(root, ".sfsmiths/cache/metadata/ApexTrigger.json"), { type: "ApexTrigger", fetched_at: new Date().toISOString(), names: ["CaseTrigger"] });
    const yaml = (await import("yaml")).default;
    const answers = {};
    for (const f of fs.readdirSync(path.join(root, "knowledge/checklists"))) for (const it of yaml.parse(fs.readFileSync(path.join(root, "knowledge/checklists", f), "utf8")).items) answers[it.id] = { answer: "yes", note: "checked in plan" };
    const plan = { root_cause: "CaseEscalationOwnerService.assignOwner reads Priority from Trigger.old instead of Trigger.new, so the flip is never seen.", confidence: 0.85, components: [{ type: "ApexClass", api_name: "CaseEscalationOwnerService", action: "modify", evidence: ev() }], fields: [{ object: "Case", api_name: "OwnerId", action: "write", evidence: ev() }], soql: ["SELECT Id FROM Case WHERE Priority = 'Critical'"], flows: [], api_version: "64.0", objects: ["Case"], touches: ["apex", "email"], tests: { existing: [], new: ["CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical"], flow_tests: [], distribution: [] }, rollback: ["redeploy the previous CaseEscalationOwnerService version"], kill_switch: "Automation_Switch__mdt.CaseEscalation", remediation: { needed: false }, prod_verification: [], options: [{ name: "fix the read in the service", tradeoff: "smallest change", chosen: true }, { name: "move to before-save flow", tradeoff: "duplicates trigger logic" }], checklist_answers: answers, unknowns: [] };
    write(path.join(vault, "03-plan.md"), "# plan\nChange CaseEscalationOwnerService.assignOwner to read Case.Priority from Trigger.new.\n");
    writeJson(path.join(vault, "03-plan.json"), plan);
    s = stop("a3-architect"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); assert.match(out, /WAIT_HUMAN \(approval\) at stage "plan"/);
    h = human(`/approve ${T}`); assert.equal(h.code, 2, "HIGH plan needs a typed answer — bare approve is blocked"); assert.match(h.stderr, /typed answer/);
    h = human(`/approve ${T} --answer "checked the field list and the rollback note"`); assert.equal(h.code, 0, h.stderr);
    out = handoff(); expectSpawn(out, "a4-developer", "develop");

    // develop: code change in the org's format + deploy/validate reports with matching file hashes
    write(path.join(cls, "CaseEscalationOwnerService.cls"), `/**\n * @description Assigns the regional escalation queue to Critical cases.\n * Modification Log\n * 2026-09-05  ${T}  read Priority from the new record\n */\npublic with sharing class CaseEscalationOwnerService {\n  /**\n   * @description Assign the queue in bulk.\n   * @param cases trigger records\n   */\n  public static void assignOwner(List<Case> cases) { for (Case c : cases) { if (c.Priority == 'Critical') { c.OwnerId = queueId(); } } }\n  private static Id queueId() { return null; }\n}\n`);
    const ctx = buildContext(T, "develop", {}, p);
    const filesHash = hashFiles((await changedSourceFiles(ctx)).map((f) => path.join(root, f)));
    writeJson(path.join(vault, "validations", "deploy-dev.json"), { status: "Succeeded", success: true, numberComponentErrors: 0, id: "0AfDEV", _files_hash: filesHash });
    writeJson(path.join(vault, "validations", "uat-validate.json"), { status: "Succeeded", success: true, numberComponentErrors: 0, numberTestErrors: 0, id: "0AfVAL", _files_hash: filesHash });
    write(path.join(vault, "04-implementation.md"), "# implementation\n");
    writeJson(path.join(vault, "04-implementation.json"), { components: [{ type: "ApexClass", api_name: "CaseEscalationOwnerService", action: "modify" }], files: [{ path: "org/force-app/main/default/classes/CaseEscalationOwnerService.cls", change: "read Priority from the new record" }], tests: ["CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical"], deviations: [], analyzer: { run: true, findings: 0, waived: [] }, deploy: { dev_report: "validations/deploy-dev.json", uat_validate_report: "validations/uat-validate.json" } });
    s = stop("a4-developer"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); expectSpawn(out, "a5-qa", "qa_dev");

    // qa_dev: first run reports a FAIL verdict via the run file (inverse broke) → bounce to develop; then green
    writeJson(path.join(vault, "validations", "tests-dev.json"), { apex: { tests: [{ FullName: "CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical", Outcome: "Pass" }, { FullName: "CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner", Outcome: "Fail" }] }, soql_assertions: [] });
    write(path.join(vault, "05-test-report.md"), "# tests\n");
    writeJson(path.join(vault, "05-test-report.json"), { tests: [{ name: "CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner", layer: "inverse", outcome: "Fail", run_file: "validations/tests-dev.json" }], defects: [{ title: "inverse broke", severity: "blocker", evidence: [{ source: "vault", ref: "validations/tests-dev.json" }] }], verdict: "fail", evidence: [{ source: "vault", ref: "validations/tests-dev.json" }] });
    s = stop("a5-qa"); assert.equal(s.json?.decision, "block", "referee blocks on the broken inverse");
    s = stop("a5-qa"); s = stop("a5-qa"); s = stop("a5-qa"); // blocks exhausted → stage failed
    assert.equal(loadManifest(T, p).stages.qa_dev.status, "failed");
    out = handoff(); expectSpawn(out, "a4-developer", "develop"); assert.match(out, /bounce qa_dev → develop/);
    // developer "fixes" (re-run develop gates: reports still valid because files unchanged)
    s = stop("a4-developer"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); expectSpawn(out, "a5-qa", "qa_dev");
    writeJson(path.join(vault, "validations", "tests-dev.json"), { apex: { tests: [{ FullName: "CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical", Outcome: "Pass" }, { FullName: "CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner", Outcome: "Pass" }] }, soql_assertions: [{ description: "no Critical case owned by a user", expected: "0", actual: "0", pass: true }] });
    writeJson(path.join(vault, "05-test-report.json"), { tests: [{ name: "CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical", layer: "apex", outcome: "Pass", run_file: "validations/tests-dev.json" }, { name: "CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner", layer: "inverse", outcome: "Pass", run_file: "validations/tests-dev.json" }], defects: [], coverage: 92, verdict: "pass", evidence: [{ source: "vault", ref: "validations/tests-dev.json" }] });
    s = stop("a5-qa"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); expectSpawn(out, "a6-reviewer", "review");

    // review (HIGH → ask)
    write(path.join(vault, "06-review.md"), "# review\nAPPROVE\n");
    write(path.join(vault, "06b-deploy-brief.md"), "# deploy brief\n");
    writeJson(path.join(vault, "06-review.json"), { verdict: "APPROVE", security: { crud_fls: "system context by design; no user input", sharing: "with sharing", injection: "no dynamic SOQL" }, findings: [], acceptance_criteria: [{ id: "AC1", test: "CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical", status: "proven" }, { id: "AC2", test: "CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner", status: "proven" }], plan_conformance: { unplanned: [], missing: [], deviations_ok: true }, deploy_brief_file: "06b-deploy-brief.md" });
    s = stop("a6-reviewer"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); assert.match(out, /WAIT_HUMAN \(approval\) at stage "review"/);
    h = human(`/approve ${T}`); assert.equal(h.code, 0, h.stderr);
    out = handoff(); expectSpawn(out, "a9-comms", "comms");

    // comms
    write(path.join(vault, "10-comms", "client-update.md"), "audience: client-visible\n\nThe case owner is now assigned correctly when a case becomes critical.\n");
    write(path.join(vault, "10-comms", "internal-summary.md"), "audience: internal\n\nRoot cause: stale Priority read in CaseEscalationOwnerService.\n");
    write(path.join(vault, "10-comms", "README.md"), "# drafts\n");
    writeJson(path.join(vault, "10-comms", "index.json"), { drafts: [{ file: "client-update.md", audience: "client-visible", purpose: "customer update" }, { file: "internal-summary.md", audience: "internal", purpose: "team" }], sources: ["01-intake.md", "03-plan.md", "06-review.md"] });
    s = stop("a9-comms"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); assert.match(out, /WAIT_HUMAN \(deploy\) at stage "deploy_uat"/);

    // human deploys to preprod via Blue Canvas, marks it
    r = humanCli(root, ["deployed", T, "--org", "preprod"]); assert.equal(r.code, 0, r.stderr);
    // D-099 (deliberate change to this simulation, 20 Sept 2026): the toolkit now verifies the deploy before QA runs in
    // preprod — uat_verify retrieves the changed components from preprod and compares fingerprints. Offline there is no
    // sf CLI, so the verdict is NOT VERIFIED and the ticket goes back to the deploy step, waiting on the human — never on
    // to QA. The human then records what they verified themselves (reason required, logged) and marks the deploy again.
    out = handoff(); assert.match(out, /WAIT_HUMAN \(deploy\) at stage "deploy_uat"/, out); assert.match(out, /parity NOT VERIFIED/);
    assert.ok(fs.existsSync(path.join(vault, "06c-deploy-manifest.md")), "deploy manifest written from git (D-100)");
    assert.ok(fs.existsSync(path.join(vault, "artifacts", "package.xml")), "package.xml written (D-100)");
    assert.match(fs.readFileSync(path.join(vault, "artifacts", "package.xml"), "utf8"), /<members>CaseEscalationOwnerService<\/members>/);
    assert.ok(fs.existsSync(path.join(vault, "07a-uat-parity.md")), "parity report written even when not verified");
    assert.ok(runHook(root, "agent-gate", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "a5-qa" } }).denied, "QA (preprod) may not start on an unverified deploy");
    r = humanCli(root, ["parity", T, "--accept-all"]); assert.notEqual(r.code, 0, "acceptance without a reason is refused");
    r = humanCli(root, ["parity", T, "--accept-all", "--reason", "verified the component list in the deploy tool's log (offline simulation)"]); assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /parity OK/);
    r = humanCli(root, ["deployed", T, "--org", "preprod"]); assert.equal(r.code, 0, r.stderr);
    out = handoff(); expectSpawn(out, "a5-qa", "qa_uat"); assert.match(out, /uat parity: \d+ component\(s\) accepted by human/);
    assert.ok(readJson(path.join(vault, "06c-deploy-manifest.json")).components.some((c) => c.key === "ApexClass:CaseEscalationOwnerService"), "the changed class is in the deploy manifest");
    assert.equal(loadManifest(T, p).stages.uat_verify.status, "done", "uat_verify toolkit stage completed on the human-accepted verdict");
    writeJson(path.join(vault, "validations", "tests-uat.json"), { apex: { tests: [{ FullName: "CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical", Outcome: "Pass" }, { FullName: "CaseEscalationOwnerAssignmentTest.nonCriticalCasesKeepTheirOwner", Outcome: "Pass" }] }, soql_assertions: [{ description: "no Critical case owned by a user", expected: "0", actual: "0", pass: true }] });
    write(path.join(vault, "07-uat-report.md"), "# uat\n");
    writeJson(path.join(vault, "07-uat-report.json"), { phase: "uat", tests: [{ name: "CaseEscalationOwnerAssignmentTest.ownerIsAssignedWhenPriorityBecomesCritical", layer: "apex", outcome: "Pass", run_file: "validations/tests-uat.json" }], defects: [], verdict: "pass", evidence: [{ source: "vault", ref: "validations/tests-uat.json" }] });
    s = stop("a5-qa"); assert.equal(s.json, undefined, s.stdout);
    out = handoff(); assert.match(out, /WAIT_HUMAN \(deploy\) at stage "deploy_prod"/);
    r = humanCli(root, ["deployed", T, "--org", "production"]); assert.equal(r.code, 0, r.stderr);
    out = handoff(); expectSpawn(out, "a7-coach", "learn"); assert.match(out, /prod verify/, "prod_verify toolkit stage ran inline before the learn stage");
    // the coach runs the mechanical retro, adds notes, files a candidate
    r = agentCli(root, ["learn-digest", T]); assert.equal(r.code, 0, r.stderr);
    fs.appendFileSync(path.join(vault, "09-retro.md"), "\n## Coach notes\n- gates first-try except qa_dev (events: stage.bounced)\n");
    write(path.join(root, "knowledge/lessons/PENDING/L-20260905-inverse-test-guard.md"), "---\nid: L-20260905-inverse-test-guard\ntitle: Run the inverse test before reporting a QA pass\ntype: process\nstatus: pending\nagents: [a4-developer]\nticket: DEMO-101\ntriggers: []\nevidence:\n  - events:DEMO-101:stage.bounced\nseverity: 3\nhits: 1\ncreated: 2026-09-05T20:00:00Z\n---\n\nWhen changing owner logic, run both tests before finishing.\n");
    s = stop("a7-coach"); assert.equal(s.json, undefined, s.stdout);
    out = handoff();
    assert.match(out, /ACTION: DONE/, out);
    m = loadManifest(T, p);
    assert.equal(m.status, "done");
    assert.ok(fs.existsSync(path.join(vault, "08-prod-verify.md")), "prod verify report written by the toolkit (no checks declared → trivially passes)");
    assert.ok(fs.existsSync(path.join(vault, "09-retro.md")), "retro written by learn-digest");
    assert.ok(!fs.existsSync(path.join(root, "work", ".active-ticket")), ".active-ticket cleared on done");
    assert.ok(!runHook(root, "agent-gate", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "a7-coach" } }).denied, "maintenance agent allowed after the ticket is done");
    assert.equal(m.approvals.length, 3, "intake, plan, review approvals");
    assert.ok(m.approvals.every((a) => a.origin === "user_prompt_submit"), "all approvals came from the human's typed prompt");
    assert.equal(m.bounces.length, 2, "qa_dev → develop, and uat_verify → deploy_uat (D-099: the unverified deploy came back to the human)");
    assert.deepEqual(m.bounces.map((b) => `${b.from}→${b.to}`), ["qa_dev→develop", "uat_verify→deploy_uat"]);
    const types = readAllEvents(p).map((e) => e.type);
    for (const t of ["ticket.opened", "stage.started", "stage.blocked", "stage.done", "stage.bounced", "human.approved", "deploy.marked", "uat.parity_failed", "human.parity_accepted", "prod.verified", "ticket.done"]) assert.ok(types.includes(t), `event ${t} recorded`);
    // and the agent-gate refuses anything now
    assert.ok(runHook(root, "agent-gate", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "a4-developer" } }).denied);
  } finally { cleanup(root); }
});
