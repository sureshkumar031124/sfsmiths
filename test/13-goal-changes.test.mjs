/**
 * test/13-goal-changes.test.mjs — the changes that closed the gap between the first end user's goal and the shipped
 * system (20 Sept 2026): D-096 convention-skill wiring · D-097 doctor canary age · D-098 classification-aware repro ·
 * D-100 deploy manifest · D-099 UAT parity · D-101 picture sections.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeProject, cleanup, write, writeJson, readJson, humanCli, agentCli, REPO } from "./helpers.mjs";

const { projectPaths } = await import(path.join(REPO, "dist/core/paths.js"));
const { loadManifest, saveManifest, stageRecord, recordGate } = await import(path.join(REPO, "dist/core/manifest.js"));
const { STAGE_BY_ID } = await import(path.join(REPO, "dist/core/state-machine.js"));
const { syncAgentSkills, addSkillAfter, generatedConventionSkills, syncAll } = await import(path.join(REPO, "dist/engines/sync.js"));
const { conventionsBuild } = await import(path.join(REPO, "dist/engines/conventions.js"));
const { loadConfig } = await import(path.join(REPO, "dist/core/config.js"));

function frontmatter(file) { return /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(file, "utf8"))[1]; }
function skillsOf(fm) { return [...fm.matchAll(/^\s*-\s+(\S+)\s*$/gm)].map((m) => m[1]); }

/* ---------------- D-096 ---------------- */

test("D-096: addSkillAfter inserts the org overlay directly under the std-* line, once, and only where std-* is listed", () => {
  const fm = "name: x\nskills:\n  - sfsmiths-core-rules\n  - std-naming-rules\n  - lessons-x";
  const once = addSkillAfter(fm, "std-naming-rules", "acme-naming-rules");
  assert.equal(once, "name: x\nskills:\n  - sfsmiths-core-rules\n  - std-naming-rules\n  - acme-naming-rules\n  - lessons-x");
  assert.equal(addSkillAfter(once, "std-naming-rules", "acme-naming-rules"), once, "idempotent");
  assert.equal(addSkillAfter(fm, "std-comment-conventions", "acme-comment-conventions"), fm, "agent without std-comment-conventions is left alone");
});

test("D-096: conventions build → sync wires <prefix>-* skills into exactly the agents that list the matching std-* skill", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    assert.deepEqual(generatedConventionSkills(p), [], "a fresh project has no generated skills");
    write(path.join(root, "docs/org-map/CONVENTIONS.md"), "# CONVENTIONS\n\n## Apex header comment\n/** ApexDoc */\n\n## Method documentation\n@description on every method\n\n## Modification log\n* 2026-09-20 KEY-1 — what\n\n## Naming patterns (class suffixes observed)\nService, Handler\n\n## Flow naming (recent)\nObject_Event_Purpose\n\n## Your decisions (edit here)\n- header format: ApexDoc\n");
    const r = conventionsBuild({ prefix: "acme", p });
    assert.equal(r.written.length, 2, r.warnings.join("; "));
    assert.deepEqual(generatedConventionSkills(p).map((g) => g.name), ["acme-comment-conventions", "acme-naming-rules"]);

    const before = Object.fromEntries(fs.readdirSync(p.agents).map((f) => [f, fs.readFileSync(path.join(p.agents, f), "utf8")]));
    const warnings = [];
    const updated = syncAgentSkills(p, warnings);
    assert.deepEqual(warnings, []);
    assert.ok(updated.length >= 5, `expected a2/a3/a4/a5/a6 (+a8) wired, got ${JSON.stringify(updated)}`);
    for (const f of fs.readdirSync(p.agents)) {
      const fm = frontmatter(path.join(p.agents, f));
      const skills = skillsOf(fm);
      const stdNaming = skills.includes("std-naming-rules"), stdComments = skills.includes("std-comment-conventions");
      assert.equal(skills.includes("acme-naming-rules"), stdNaming, `${f}: acme-naming-rules iff std-naming-rules`);
      assert.equal(skills.includes("acme-comment-conventions"), stdComments, `${f}: acme-comment-conventions iff std-comment-conventions`);
      if (stdNaming) assert.equal(skills[skills.indexOf("std-naming-rules") + 1], "acme-naming-rules", `${f}: overlay sits directly under the std line (precedence visible)`);
      // nothing else changed: strip the two added lines and compare byte-for-byte
      const stripped = fs.readFileSync(path.join(p.agents, f), "utf8").replace(/^\s*-\s+acme-(naming-rules|comment-conventions)\s*\n/gm, "");
      assert.equal(stripped, before[f], `${f}: only the skill lines changed`);
    }
    assert.deepEqual(syncAgentSkills(p, []), [], "second sync is a no-op");
    const all = syncAll(p, { skipSkills: true });
    assert.ok(!all.agents_updated.some((u) => /acme/.test(u)), "syncAll does not re-add");
  } finally { cleanup(root); }
});

test("D-096: the conventions CLI wires the skills itself (no manual 'add to skills:' step)", () => {
  const root = makeProject();
  try {
    write(path.join(root, "docs/org-map/CONVENTIONS.md"), "# C\n\n## Apex header comment\nbanner\n\n## Your decisions (edit here)\n- header format: banner\n");
    const r = humanCli(root, ["conventions", "build", "--prefix", "acme"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wired into agents: .*a4-developer/);
    assert.ok(skillsOf(frontmatter(path.join(root, ".claude/agents/a4-developer.md"))).includes("acme-comment-conventions"));
  } finally { cleanup(root); }
});

/* ---------------- D-098 ---------------- */

/** Put DEMO-101 at the end of cartography so the next handoff spawns a2-repro and renders its prompt. */
function ticketAtRepro(root, classification) {
  const T = "DEMO-101";
  let r = agentCli(root, ["open", T]); assert.equal(r.code, 0, r.stderr);
  const p = projectPaths(root);
  const m = loadManifest(T, p);
  for (const s of ["prior_art", "intake", "baseline", "cartography"]) {
    const rec = stageRecord(m, s); rec.status = "done"; rec.attempts = 1;
    for (const g of STAGE_BY_ID[s].gates) recordGate(m, s, { name: g, status: "passed", reason: "fixture" });
  }
  m.stage = "cartography"; m.status = "running"; m.tier = "MEDIUM";
  saveManifest(m, p);
  if (classification) writeJson(path.join(root, "work", T, "01-intake.json"), { classification, summary: "an intake summary long enough", acceptance_criteria: [{ id: "AC1", text: "x", source: "ticket.md#L1" }], scope: [], objects: ["Case"], touches: ["apex"], suggested_tier: "MEDIUM", keywords: [], questions: [] });
  r = agentCli(root, ["handoff", T]); assert.equal(r.code, 0, r.stderr);
  return r.stdout;
}

test("D-098: an ENHANCEMENT ticket gets the acceptance-tests-first repro prompt; a BUG keeps the prove-the-bug prompt; no intake → UNKNOWN", () => {
  for (const [cls, expectRe, forbidRe] of [
    ["ENHANCEMENT", /acceptance tests first/i, /prove the bug with a failing assertion/],
    ["BUG", /prove the bug with a failing assertion/, /acceptance tests first/i],
    [undefined, /prove the bug with a failing assertion/, /acceptance tests first/i],
  ]) {
    const root = makeProject();
    try {
      const out = ticketAtRepro(root, cls);
      assert.match(out, /ACTION: SPAWN subagent "a2-repro" for stage "repro"/, out.split("\n").slice(0, 3).join(" | "));
      assert.match(out, expectRe, `${cls}: expected template`);
      assert.doesNotMatch(out, forbidRe, `${cls}: wrong template leaked`);
      assert.match(out, new RegExp(`classification \\*\\*${cls ?? "UNKNOWN"}\\*\\*`), `${cls}: {{CLASSIFICATION}} rendered`);
    } finally { cleanup(root); }
  }
});

test("D-098: a project-level classification template overrides the package one (templates/ before packageRoot)", () => {
  const root = makeProject();
  try {
    write(path.join(root, "templates/prompts/a2-repro.repro.ENHANCEMENT.md"), "PROJECT OVERRIDE for {{TICKET}} ({{CLASSIFICATION}})\n");
    const out = ticketAtRepro(root, "ENHANCEMENT");
    assert.match(out, /PROJECT OVERRIDE for DEMO-101 \(ENHANCEMENT\)/);
  } finally { cleanup(root); }
});

/* ---------------- D-100 deploy manifest ---------------- */

const { buildDeployManifest, computeDeployFilesHash, renderPackageXml, changedFilesWithStatus } = await import(path.join(REPO, "dist/engines/deploy-manifest.js"));
const { componentContentFingerprint, componentFingerprint } = await import(path.join(REPO, "dist/core/fingerprint.js"));

function openTicketWithSource(root) {
  const T = "DEMO-101";
  let r = agentCli(root, ["open", T]); assert.equal(r.code, 0, r.stderr);
  const cls = path.join(root, "org/force-app/main/default/classes");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  // a committed class that the ticket will MODIFY, and a committed trigger the ticket will DELETE
  write(path.join(cls, "CaseEscalationOwnerService.cls"), "public with sharing class CaseEscalationOwnerService { }\n");
  write(path.join(cls, "CaseEscalationOwnerService.cls-meta.xml"), '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>64.0</apiVersion><status>Active</status></ApexClass>\n');
  write(path.join(root, "org/force-app/main/default/triggers/LegacyCaseTrigger.trigger"), "trigger LegacyCaseTrigger on Case (before insert) { }\n");
  write(path.join(root, "org/force-app/main/default/triggers/LegacyCaseTrigger.trigger-meta.xml"), '<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>64.0</apiVersion><status>Active</status></ApexTrigger>\n');
  git("add", "-A"); git("commit", "-q", "-m", "org baseline");
  const p = projectPaths(root);
  const m = loadManifest(T, p); m.flags.baseline_commit = git("rev-parse", "HEAD").toString().trim(); saveManifest(m, p);
  // the ticket's work: modify the class, add a field + a test class, delete the legacy trigger
  write(path.join(cls, "CaseEscalationOwnerService.cls"), "public with sharing class CaseEscalationOwnerService { public static void assignOwner(List<Case> cases) { } }\n");
  write(path.join(cls, "CaseEscalationOwnerAssignmentTest.cls"), "@IsTest private class CaseEscalationOwnerAssignmentTest { @IsTest static void ownerIsAssigned() { System.assert(true, 'x'); } }\n");
  write(path.join(cls, "CaseEscalationOwnerAssignmentTest.cls-meta.xml"), '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>64.0</apiVersion><status>Active</status></ApexClass>\n');
  write(path.join(root, "org/force-app/main/default/objects/Case/fields/Escalation_Queue_Name__c.field-meta.xml"), '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Escalation_Queue_Name__c</fullName><type>Text</type><length>80</length></CustomField>\n');
  fs.rmSync(path.join(root, "org/force-app/main/default/triggers/LegacyCaseTrigger.trigger"));
  fs.rmSync(path.join(root, "org/force-app/main/default/triggers/LegacyCaseTrigger.trigger-meta.xml"));
  write(path.join(root, "tests-ui/specs/case-escalation-modal.spec.ts"), "// spec\n");
  return { T, p, cls };
}

test("D-100: the deploy manifest comes from git — added / modified / deleted components, package.xml and destructiveChanges.xml, a table for the deploy tool", async () => {
  const root = makeProject();
  try {
    const { T, p } = openTicketWithSource(root);
    const status = await changedFilesWithStatus(p, T);
    assert.deepEqual(status.map((s) => `${s.action}:${path.basename(s.file)}`).sort(), [
      "added:CaseEscalationOwnerAssignmentTest.cls", "added:CaseEscalationOwnerAssignmentTest.cls-meta.xml", "added:Escalation_Queue_Name__c.field-meta.xml", "added:case-escalation-modal.spec.ts",
      "deleted:LegacyCaseTrigger.trigger", "deleted:LegacyCaseTrigger.trigger-meta.xml", "modified:CaseEscalationOwnerService.cls",
    ].sort());
    const mf = await buildDeployManifest(T, p);
    assert.deepEqual(mf.components.map((c) => `${c.action} ${c.key}`), [
      "added ApexClass:CaseEscalationOwnerAssignmentTest", "modified ApexClass:CaseEscalationOwnerService", "deleted ApexTrigger:LegacyCaseTrigger", "added CustomField:Case.Escalation_Queue_Name__c",
    ]);
    assert.equal(mf.api_version, "64.0", "from org/sfdx-project.json");
    const pkg = fs.readFileSync(path.join(root, mf.package_xml), "utf8");
    assert.match(pkg, /<members>CaseEscalationOwnerAssignmentTest<\/members>\s*<members>CaseEscalationOwnerService<\/members>\s*<name>ApexClass<\/name>/);
    assert.match(pkg, /<members>Case\.Escalation_Queue_Name__c<\/members>\s*<name>CustomField<\/name>/);
    assert.doesNotMatch(pkg, /LegacyCaseTrigger/, "deleted components are not in package.xml");
    assert.match(pkg, /<version>64\.0<\/version>/);
    const destructive = fs.readFileSync(path.join(root, mf.destructive_xml), "utf8");
    assert.match(destructive, /<members>LegacyCaseTrigger<\/members>\s*<name>ApexTrigger<\/name>/);
    const md = fs.readFileSync(path.join(root, "work", T, "06c-deploy-manifest.md"), "utf8");
    assert.match(md, /\| 2 \| ApexClass \| `CaseEscalationOwnerService` \| modified \|/);
    assert.match(md, /not Salesforce components[\s\S]*case-escalation-modal\.spec\.ts/, "the UI spec is listed but not deployable");
    assert.match(md, /no agent wrote this/);
    // fingerprints are path-independent so a preprod retrieve into another layout compares equal
    const a = componentContentFingerprint(root, ["org/force-app/main/default/classes/CaseEscalationOwnerService.cls", "org/force-app/main/default/classes/CaseEscalationOwnerService.cls-meta.xml"]);
    fs.mkdirSync(path.join(root, "tmp-retrieve/classes"), { recursive: true });
    for (const f of ["CaseEscalationOwnerService.cls", "CaseEscalationOwnerService.cls-meta.xml"]) fs.copyFileSync(path.join(root, "org/force-app/main/default/classes", f), path.join(root, "tmp-retrieve/classes", f));
    const b = componentContentFingerprint(path.join(root, "tmp-retrieve"), ["classes/CaseEscalationOwnerService.cls", "classes/CaseEscalationOwnerService.cls-meta.xml"]);
    assert.equal(a, b, "same content, different layout → equal");
    assert.notEqual(componentFingerprint(root, ["org/force-app/main/default/classes/CaseEscalationOwnerService.cls"]), componentFingerprint(path.join(root, "tmp-retrieve"), ["classes/CaseEscalationOwnerService.cls"]), "the path-inclusive fingerprint would have differed — which is why parity uses the content one");
    // the files hash moves when a listed source file changes, and is stable otherwise
    const h1 = await computeDeployFilesHash(p, T);
    assert.equal(h1, mf.files_hash);
    fs.appendFileSync(path.join(root, "org/force-app/main/default/classes/CaseEscalationOwnerService.cls"), "// touched\n");
    assert.notEqual(await computeDeployFilesHash(p, T), h1);
    const cli = agentCli(root, ["deploy-manifest", T]); assert.equal(cli.code, 0, cli.stderr); assert.match(cli.stdout, /4 component\(s\) \(2 added, 1 modified, 1 deleted\)/);
  } finally { cleanup(root); }
});

test("D-100: renderPackageXml groups members by type, sorted, and escapes", () => {
  const xml = renderPackageXml(["Flow:Case_Route_Escalation", "ApexClass:B", "ApexClass:A", "CustomField:Case.X__c"], "64.0");
  assert.match(xml, /<types>\s*<members>A<\/members>\s*<members>B<\/members>\s*<name>ApexClass<\/name>\s*<\/types>\s*<types>\s*<members>Case\.X__c<\/members>\s*<name>CustomField<\/name>\s*<\/types>\s*<types>\s*<members>Case_Route_Escalation<\/members>\s*<name>Flow<\/name>/);
  assert.equal(renderPackageXml([], "64.0").includes("<types>"), false);
});

/* ---------------- D-099 UAT parity ---------------- */

const { uatParity, parityAccept, renderParityMd } = await import(path.join(REPO, "dist/privileged/index.js"));
const { buildContext, runGate } = await import(path.join(REPO, "dist/gates/registry.js"));

test("D-099: uat_verify is skipped in a dev-only run (no preprod) and the uat-parity gate passes by config", async () => {
  const root = makeProject();
  try {
    const { T, p } = openTicketWithSource(root);
    const m = loadManifest(T, p); m.flags.no_preprod = true; saveManifest(m, p);
    const r = await uatParity(T, p);
    assert.equal(r.ok, true); assert.equal(r.source, "skipped"); assert.match(r.skipped, /no preprod/);
    const g = await runGate("uat-parity", buildContext(T, "qa_uat", {}, p), { persist: false });
    assert.equal(g.status, "passed"); assert.match(g.reason, /skipped by config/);
  } finally { cleanup(root); }
});

test("D-099: offline, parity is NOT VERIFIED (never ok); the gate refuses; a human acceptance needs a reason, records the decision, and is voided when the source changes", async () => {
  const root = makeProject();
  try {
    const { T, p } = openTicketWithSource(root);
    const ctx = () => buildContext(T, "qa_uat", {}, p);
    let g = await runGate("uat-parity", ctx(), { persist: false });
    assert.equal(g.status, "unavailable", "no verdict yet → unavailable, never passed");
    const r = await uatParity(T, p);
    assert.equal(r.ok, false); assert.match(r.unavailable, /could not retrieve from PartialUAT/); assert.equal(r.rows.length, 4);
    assert.ok(r.rows.every((x) => ["MISSING_IN_UAT", "STILL_IN_UAT"].includes(x.status)), "unverified rows are never MATCH");
    assert.ok(fs.existsSync(path.join(root, "work", T, "07a-uat-parity.md")));
    g = await runGate("uat-parity", ctx(), { persist: false });
    assert.equal(g.status, "failed"); assert.match(g.reason, /not verified/);
    await assert.rejects(() => parityAccept(T, { all: true, reason: "short", p }), /reason of at least 8/);
    await assert.rejects(() => parityAccept(T, { keys: ["ApexClass:Nope"], reason: "long enough reason", p }), /not in the deploy manifest/);
    const a1 = await parityAccept(T, { keys: ["ApexClass:CaseEscalationOwnerService"], reason: "compared in the deploy tool log #42", p });
    assert.equal(a1.ok, false, "one accepted, three still unverified");
    assert.equal(a1.rows.find((x) => x.key === "ApexClass:CaseEscalationOwnerService").status, "ACCEPTED");
    const a2 = await parityAccept(T, { all: true, reason: "all four compared in the deploy tool log #42", p });
    assert.equal(a2.ok, true); assert.equal(a2.source, "human"); assert.deepEqual(a2.accepted.keys.length, 3, "only the rows that were not ok are accepted this time");
    g = await runGate("uat-parity", ctx(), { persist: false });
    assert.equal(g.status, "passed"); assert.match(g.reason, /accepted by human/);
    // a fresh uatParity honours the human verdict for the same source (no retrieve attempted)
    const again = await uatParity(T, p);
    assert.equal(again.source, "human"); assert.equal(again.ok, true);
    // the source moves on → the human verdict is void, the gate fails, and parity must be re-verified
    fs.appendFileSync(path.join(root, "org/force-app/main/default/classes/CaseEscalationOwnerService.cls"), "// one more line\n");
    g = await runGate("uat-parity", ctx(), { persist: false });
    assert.equal(g.status, "failed"); assert.match(g.reason, /source changed after the parity verdict/);
    const after = await uatParity(T, p);
    assert.equal(after.source, "retrieve"); assert.equal(after.ok, false);
    const md = renderParityMd(after);
    assert.match(md, /NOT VERIFIED/); assert.match(md, /sfsmiths-human parity DEMO-101 --accept-all/);
    const cli = humanCli(root, ["parity", T]); assert.notEqual(cli.code, 0); assert.match(cli.stdout, /NOT VERIFIED/);
  } finally { cleanup(root); }
});

/* ---------------- D-097 ---------------- */

test("D-097: doctor #10 marks a stale canary PASS as WARN (what data-guard will deny), a fresh one OK, none as WARN", async () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const cfg = loadConfig(p);
    const { doctor } = await import(path.join(REPO, "dist/doctor/index.js"));
    const dev = cfg.orgs.orgs.find((o) => o.role === "development").alias;
    const file = path.join(root, ".sfsmiths", "canary", `${dev}.json`);
    const check = async () => (await doctor({ quick: true, p })).checks.find((c) => c.id === "10");

    let c = await check();
    assert.equal(c.level, "warn"); assert.match(c.detail, /never run/);

    writeJson(file, { at: new Date(Date.now() - 27 * 3600_000).toISOString(), org: dev, result: "pass", detail: "NO_SINGLE_MAIL_PERMISSION", recipient_masked: "s***@example.com" });
    c = await check();
    assert.equal(c.level, "warn", "27 h old PASS is stale"); assert.match(c.detail, /min old|stale|rerun/i); assert.match(c.detail, /DENY/);

    writeJson(file, { at: new Date(Date.now() - 5 * 60_000).toISOString(), org: dev, result: "pass", detail: "NO_SINGLE_MAIL_PERMISSION", recipient_masked: "s***@example.com" });
    c = await check();
    assert.equal(c.level, "ok"); assert.match(c.detail, /fresh/);

    writeJson(file, { at: new Date().toISOString(), org: dev, result: "fail", detail: "email SENT", recipient_masked: "s***@example.com" });
    c = await check();
    assert.equal(c.level, "warn"); assert.match(c.detail, /FAIL/);
  } finally { cleanup(root); }
});
