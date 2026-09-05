import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { makeProject, cleanup, writeJson, write } from "./helpers.mjs";
import { loadConfig } from "../dist/core/config.js";
import { projectPaths } from "../dist/core/paths.js";
import { newManifest, saveManifest, stageRecord } from "../dist/core/manifest.js";
import { buildContext, runGate, GATES, gateNames } from "../dist/gates/registry.js";
import { emailAllowed, checkName, wordCount, lintApexComments, lintMetadataDescription, apexSecurityFindings, testQualityFindings } from "../dist/gates/hygiene.js";
import { parseSoql, checkAllowlist, maskRecords } from "../dist/engines/evidence/query.js";

function project() {
  const root = makeProject();
  const p = projectPaths(root);
  const cfg = loadConfig(p, { fresh: true });
  const m = newManifest("DEMO-101", "file", "demo");
  stageRecord(m, "open").status = "done";
  m.flags.baseline_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  saveManifest(m, p);
  const vault = path.join(root, "work", "DEMO-101");
  return { root, p, cfg, m, vault };
}

test("the 12 gates are registered", () => {
  const names = gateNames().sort();
  for (const g of ["contract-check", "risk-floor", "baseline-check", "email-guard", "naming-lint", "assertion-referee", "plan-lint", "semantic-check", "checklist", "comment-lint", "deploy-report", "test-quality", "security", "comms-lint", "analyzer"]) assert.ok(names.includes(g), `gate ${g}`);
  assert.ok(Object.keys(GATES).length >= 12);
});

test("contract-check: missing → failed; invalid JSON → failed; valid + resolving evidence → passed; dangling evidence ref → failed", async () => {
  const { root, p, vault } = project();
  try {
    let ctx = buildContext("DEMO-101", "intake", {}, p);
    let r = await runGate("contract-check", ctx, { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /missing 01-intake.md/);
    write(path.join(vault, "01-intake.md"), "# intake\n");
    write(path.join(vault, "01-intake.json"), "{ not json");
    r = await runGate("contract-check", buildContext("DEMO-101", "intake", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /not valid JSON/);
    const intake = { classification: "BUG", summary: "Critical web cases lose their owner after the priority flip", acceptance_criteria: [{ id: "AC1", text: "owner is the regional queue", source: "ticket.md#L12" }], scope: [{ type: "ApexClass", api_name: "CaseEscalationOwnerService", evidence: { source: "vault", ref: "ticket.md" } }], objects: ["Case"], touches: ["apex"], suggested_tier: "HIGH", keywords: ["escalation"], questions: [] };
    writeJson(path.join(vault, "01-intake.json"), intake);
    r = await runGate("contract-check", buildContext("DEMO-101", "intake", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /evidence refs do not resolve/, "ticket.md does not exist yet");
    write(path.join(vault, "ticket.md"), "<untrusted source=\"file\">text</untrusted>");
    r = await runGate("contract-check", buildContext("DEMO-101", "intake", {}, p), { persist: true });
    assert.equal(r.status, "passed", r.reason);
    assert.ok(fs.existsSync(path.join(vault, "validations", "intake-contract-check.json")), "outcome persisted");
  } finally { cleanup(root); }
});

test("risk-floor computes the tier from scope and only raises the agent's suggestion", async () => {
  const { root, p, vault } = project();
  try {
    writeJson(path.join(vault, "01-intake.json"), { suggested_tier: "LOW", scope: [{ type: "Flow", api_name: "Case_AfterSave_X" }], touches: ["flow"] });
    let ctx = buildContext("DEMO-101", "intake", {}, p);
    let r = await runGate("risk-floor", ctx, { persist: false });
    assert.equal(r.status, "passed"); assert.equal(ctx.manifest.tier, "MEDIUM", "flow → MEDIUM floor beats LOW suggestion");
    writeJson(path.join(vault, "01-intake.json"), { suggested_tier: "LOW", scope: [{ type: "ApexClass", api_name: "X" }], touches: ["apex", "email"] });
    ctx = buildContext("DEMO-101", "intake", {}, p);
    await runGate("risk-floor", ctx, { persist: false });
    assert.equal(ctx.manifest.tier, "HIGH");
  } finally { cleanup(root); }
});

test("email-guard / naming-lint / comment-lint on a changed test class", async () => {
  const { root, p, vault } = project();
  try {
    const cls = path.join(root, "org/force-app/main/default/classes/CaseEscalationOwnerAssignmentTest.cls");
    write(cls, `/**\n * @description Proves escalation owner assignment.\n * Modification Log: 2026-09-05 DEMO-101 created\n */\n@IsTest\nprivate class CaseEscalationOwnerAssignmentTest {\n  @IsTest static void ownerAssigned() { Contact c = new Contact(Email='rollout.manager@example.com'); System.assert(true, 'x'); }\n}\n`);
    write(path.join(vault, "artifacts", "repro-data.apex"), "Contact c = new Contact(LastName='Manager', Email='real.person@somecompany.com');");
    let r = await runGate("email-guard", buildContext("DEMO-101", "repro", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /re\*\*\*@somecompany\.com/, "offender masked in the reason");
    assert.ok(r.reward_events.includes("email_guard.blocked"));
    write(path.join(vault, "artifacts", "repro-data.apex"), "Contact c = new Contact(LastName='Manager', Email='rollout.manager@example.com');");
    r = await runGate("email-guard", buildContext("DEMO-101", "repro", {}, p), { persist: false });
    assert.equal(r.status, "passed", r.reason);
    r = await runGate("comment-lint", buildContext("DEMO-101", "repro", { scope: "tests" }, p), { persist: false });
    assert.equal(r.status, "passed", r.reason);
    // a class without header + method docs fails at develop scope
    write(path.join(root, "org/force-app/main/default/classes/Fix1234.cls"), "public class Fix1234 {\n  public static void run() {}\n}\n");
    r = await runGate("comment-lint", buildContext("DEMO-101", "develop", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /header doc block|doc comment|modification-log/);
    r = await runGate("naming-lint", buildContext("DEMO-101", "develop", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /Fix1234/);
  } finally { cleanup(root); }
});

test("pure helpers: emailAllowed, checkName, comment + security + test-quality linters", () => {
  const allow = ["*@example.com", "*.invalid"];
  assert.ok(emailAllowed("rollout.manager@example.com", allow));
  assert.ok(emailAllowed("x@team.invalid", allow));
  assert.ok(!emailAllowed("someone@gmail.com", allow));
  assert.equal(wordCount("CaseAutoCloseGuard"), 4);
  const ticketRe = /[A-Z][A-Z0-9_]{0,15}-[0-9]{1,8}/;
  assert.equal(checkName("CaseAutoCloseGuard", { pattern: "^[A-Z][A-Za-z0-9]{5,60}$", min_words: 2 }, ticketRe, true), undefined);
  assert.ok(checkName("Fix1234", { pattern: "^[A-Z][A-Za-z0-9]{5,60}$", min_words: 2 }, ticketRe, true));
  assert.ok(checkName("PROJ1234Class", { pattern: "^[A-Z][A-Za-z0-9]{5,60}$", min_words: 2 }, ticketRe, true), "ticket-ish name rejected");
  const bad = "public with sharing class X {\n public static void go() { Database.query('SELECT Id FROM Case WHERE Name = \\'' + n + '\\''); }\n}";
  assert.ok(lintApexComments(bad, "DEMO-101", { requireModLog: true }).length >= 2);
  assert.ok(apexSecurityFindings(bad, "X.cls").some((f) => /dynamic SOQL/.test(f)));
  assert.equal(lintMetadataDescription("<Flow><description>Assigns owner</description></Flow>"), undefined);
  assert.ok(lintMetadataDescription("<Flow></Flow>"));
  const t = "@IsTest private class T {\n @IsTest static void noAssert() { insert new Account(Name='x'); }\n @IsTest static void ok() { System.assertEquals(1,1,'m'); }\n}";
  assert.ok(testQualityFindings(t, "T").some((f) => /noAssert.*no assertion/.test(f)));
});

test("assertion-referee: repro phase needs FAIL + inverse PASS; dev phase needs PASS", async () => {
  const { root, p, vault } = project();
  try {
    writeJson(path.join(vault, "02-repro.json"), { failing_tests: ["CaseEscalationOwnerAssignmentTest.ownerAssigned"], inverse_tests: ["CaseEscalationOwnerAssignmentTest.nonCriticalKeepOwner"] });
    let r = await runGate("assertion-referee", buildContext("DEMO-101", "repro", {}, p), { persist: false });
    assert.equal(r.status, "unavailable", "no run file yet");
    const run = (fail, inv) => ({ apex: { tests: [{ FullName: "CaseEscalationOwnerAssignmentTest.ownerAssigned", Outcome: fail }, { FullName: "CaseEscalationOwnerAssignmentTest.nonCriticalKeepOwner", Outcome: inv }] } });
    writeJson(path.join(vault, "validations", "tests-repro.json"), run("Pass", "Pass"));
    r = await runGate("assertion-referee", buildContext("DEMO-101", "repro", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /expected FAIL/);
    writeJson(path.join(vault, "validations", "tests-repro.json"), run("Fail", "Pass"));
    r = await runGate("assertion-referee", buildContext("DEMO-101", "repro", {}, p), { persist: false });
    assert.equal(r.status, "passed", r.reason);
    writeJson(path.join(vault, "validations", "tests-dev.json"), { ...run("Pass", "Pass"), soql_assertions: [{ description: "none unassigned", expected: "0", actual: "0", pass: true }] });
    r = await runGate("assertion-referee", buildContext("DEMO-101", "qa_dev", {}, p), { persist: false });
    assert.equal(r.status, "passed", r.reason);
    writeJson(path.join(vault, "validations", "tests-dev.json"), { ...run("Pass", "Fail") });
    r = await runGate("assertion-referee", buildContext("DEMO-101", "qa_dev", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /inverse must PASS/);
  } finally { cleanup(root); }
});

test("plan-lint + semantic-check resolve against the oracle caches; unknown names fail; action:create passes", async () => {
  const { root, p, vault } = project();
  try {
    writeJson(path.join(root, ".sfsmiths/cache/describe/Case.json"), { object: "Case", fetched_at: new Date().toISOString(), fields: { Id: { type: "id", updateable: false }, Priority: { type: "picklist", updateable: true }, OwnerId: { type: "reference", updateable: true }, CaseNumber: { type: "string", updateable: false, calculated: false } } });
    writeJson(path.join(root, ".sfsmiths/cache/metadata/ApexClass.json"), { type: "ApexClass", fetched_at: new Date().toISOString(), names: ["CaseEscalationOwnerService", "CaseTriggerHandler"] });
    writeJson(path.join(root, ".sfsmiths/cache/metadata/Flow.json"), { type: "Flow", fetched_at: new Date().toISOString(), names: ["Case_AfterSave_AssignOwner"] });
    const plan = (over = {}) => ({ root_cause: "The after-save flow clears OwnerId when Priority flips because the decision reads the stale value.", confidence: 0.8, components: [{ type: "ApexClass", api_name: "CaseEscalationOwnerService", action: "modify", evidence: { source: "L1", ref: "x" } }], fields: [{ object: "Case", api_name: "OwnerId", action: "write" }], soql: ["SELECT Id FROM Case WHERE Priority = 'Critical'"], flows: [], api_version: "64.0", objects: ["Case"], touches: ["apex"], tests: { new: ["CaseEscalationOwnerAssignmentTest.ownerAssigned"] }, rollback: ["redeploy previous class version"], remediation: { needed: false }, prod_verification: [], options: [{ name: "a", tradeoff: "x", chosen: true }, { name: "b", tradeoff: "y" }], checklist_answers: {}, unknowns: [], ...over });
    write(path.join(vault, "03-plan.md"), "# plan\nWe change CaseEscalationOwnerService.assignOwner and read Case.Priority.\n");
    writeJson(path.join(vault, "03-plan.json"), plan());
    let r = await runGate("plan-lint", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(r.status, "passed", r.reason);
    writeJson(path.join(vault, "03-plan.json"), plan({ components: [{ type: "ApexClass", api_name: "CaseOwnerMagicService", action: "modify", evidence: { source: "L1", ref: "x" } }] }));
    r = await runGate("plan-lint", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /CaseOwnerMagicService/);
    writeJson(path.join(vault, "03-plan.json"), plan({ components: [{ type: "ApexClass", api_name: "CaseOwnerMagicService", action: "create", evidence: { source: "L1", ref: "x" } }] }));
    r = await runGate("plan-lint", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(r.status, "passed", `create passes: ${r.reason}`);
    writeJson(path.join(vault, "03-plan.json"), plan({ fields: [{ object: "Case", api_name: "CaseNumber", action: "write" }] }));
    r = await runGate("semantic-check", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /CaseNumber/);
    writeJson(path.join(vault, "03-plan.json"), plan({ api_version: "58.0" }));
    r = await runGate("semantic-check", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /api.?version/i);
  } finally { cleanup(root); }
});

test("checklist gate: unanswered applicable items fail; n/a needs a note", async () => {
  const { root, p, vault } = project();
  try {
    const base = { components: [{ type: "ApexClass" }], touches: ["apex"], checklist_answers: {} };
    writeJson(path.join(vault, "03-plan.json"), base);
    let r = await runGate("checklist", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /ARCH-1/);
    const yaml = (await import("yaml")).default;
    const ids = [];
    for (const f of fs.readdirSync(path.join(root, "knowledge/checklists"))) for (const it of yaml.parse(fs.readFileSync(path.join(root, "knowledge/checklists", f), "utf8")).items) ids.push(it);
    const answers = {};
    for (const it of ids) answers[it.id] = it.applies_when === "always" || it.applies_when === "apex" ? { answer: "yes", note: "checked" } : { answer: "n/a", note: "not in scope" };
    writeJson(path.join(vault, "03-plan.json"), { ...base, checklist_answers: answers });
    r = await runGate("checklist", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(r.status, "passed", r.reason);
    answers["ARCH-1"] = { answer: "n/a" };
    writeJson(path.join(vault, "03-plan.json"), { ...base, checklist_answers: answers });
    r = await runGate("checklist", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(r.status, "failed");
  } finally { cleanup(root); }
});

test("comms-lint: audience header, forbidden terms in client drafts, secrets, leaked envelopes", async () => {
  const { root, p, vault } = project();
  try {
    write(path.join(vault, "10-comms", "client-update.md"), "Subject: update\n\nWe fixed the sandbox trigger.\n");
    let r = await runGate("comms-lint", buildContext("DEMO-101", "comms", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /audience/);
    write(path.join(vault, "10-comms", "client-update.md"), "audience: client-visible\n\nWe fixed the sandbox trigger for you.\n");
    r = await runGate("comms-lint", buildContext("DEMO-101", "comms", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /forbidden term/);
    write(path.join(vault, "10-comms", "client-update.md"), "audience: client-visible\n\nThe case owner is now assigned correctly when the priority changes.\n");
    write(path.join(vault, "10-comms", "internal-summary.md"), "audience: internal\n\nRoot cause: after-save flow ordering. <untrusted source=\"x\">leak</untrusted>\n");
    r = await runGate("comms-lint", buildContext("DEMO-101", "comms", {}, p), { persist: false });
    assert.equal(r.status, "failed"); assert.match(r.reason, /untrusted envelope/);
    write(path.join(vault, "10-comms", "internal-summary.md"), "audience: internal\n\nRoot cause: after-save flow ordering (Case_AfterSave_AssignOwner).\n");
    r = await runGate("comms-lint", buildContext("DEMO-101", "comms", {}, p), { persist: false });
    assert.equal(r.status, "passed", r.reason);
  } finally { cleanup(root); }
});

test("masking: SOQL shape, allowlist, refused field types, row cap + masking", () => {
  const { root, p, cfg } = project();
  try {
    const q = parseSoql("SELECT Id, Status, Priority FROM Case WHERE Origin = 'Web' AND CreatedDate = LAST_N_DAYS:30 ORDER BY CreatedDate DESC LIMIT 50");
    assert.equal(q.object, "Case"); assert.deepEqual(q.fields, ["Id", "Status", "Priority"]); assert.equal(q.limit, 50);
    assert.ok(q.whereFields.includes("Origin") && q.whereFields.includes("CreatedDate"));
    assert.throws(() => parseSoql("DELETE FROM Case"), /Only SELECT/);
    assert.throws(() => parseSoql("SELECT Id, (SELECT Id FROM Contacts) FROM Account"), /Subqueries/);
    assert.equal(checkAllowlist(q, cfg, p).ok, true);
    const bad = checkAllowlist(parseSoql("SELECT Id, Description FROM Case"), cfg, p);
    assert.equal(bad.ok, false); assert.match(bad.reason, /Description/);
    const unlisted = checkAllowlist(parseSoql("SELECT Id FROM Lead"), cfg, p);
    assert.equal(unlisted.ok, false);
    const contactEmail = checkAllowlist(parseSoql("SELECT Id, Email FROM Contact"), cfg, p);
    assert.equal(contactEmail.ok, false, "Contact.Email is never allowlisted by default");
    const rows = maskRecords([{ Id: "500x", Status: "New", Description: "a".repeat(500), attributes: { type: "Case" } }, { Id: "500y", Status: "Closed" }], ["Id", "Status"], 1, true);
    assert.equal(rows.rows.length, 1); assert.equal(rows.truncated, true); assert.ok(!("Description" in rows.rows[0]), "non-allowlisted field dropped");
  } finally { cleanup(root); }
});
