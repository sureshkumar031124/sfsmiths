/**
 * test/14-hard-rules.test.mjs — the four rules the first end user said the system may NEVER skip, written as red-team tests
 * (20 Sept 2026). Each block tries to break the rule the way a careless or manipulated agent would, and asserts the
 * mechanism (hook / parser / gate / config) says no. If one of these ever goes red, the rule is a promise, not a property.
 *
 *   1. Production is read-only — no write of data or metadata by any spelling; reads only through the masked evidence layer.
 *   2. E-mail: only allowlisted addresses, edited by the human in the UI; delivery is contained (blocked, or census-proven).
 *   3. Nothing is guessed — every gate refuses "unavailable" as a pass; every contract needs evidence refs.
 *   4. Knowledge comes from Salesforce documentation domains and human-curated notes with provenance; agents cannot browse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, cleanup, write, writeJson, readJson, runHook, humanCli, REPO } from "./helpers.mjs";

const { projectPaths } = await import(path.join(REPO, "dist/core/paths.js"));
const { loadConfig, loadConfigFile, writeConfigFile, emailDeliveryMode, emailCensusFields } = await import(path.join(REPO, "dist/core/config.js"));
const { syncAll } = await import(path.join(REPO, "dist/engines/sync.js"));
const { parseSoql, checkAllowlist } = await import(path.join(REPO, "dist/engines/evidence/query.js"));
const { checkUrl, relatedHosts } = await import(path.join(REPO, "dist/mcp/ui-fence.js"));
const { classifyCanaryResult, censusQuery, CANARY_BLOCKED_STATUSES } = await import(path.join(REPO, "dist/privileged/index.js"));
const { emailAllowed } = await import(path.join(REPO, "dist/gates/hygiene.js"));
const { sourceTrusted, curatedLint, DEFAULT_TRUSTED_DOMAINS, loadTrustedDomains } = await import(path.join(REPO, "dist/engines/mirror.js"));
const { startUi } = await import(path.join(REPO, "dist/ui/server.js"));

const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

/* ================= RULE 1 — production is read-only ================= */

test("RULE 1: every sf write or read aimed at production/preprod (alias, username, URL, any flag spelling) is denied by the policy hook; only the dev alias passes", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    // a realistic keychain: the admin's production login under an innocent alias + a read-only user
    const orgs = loadConfigFile("orgs", p);
    orgs.orgs.find((o) => o.role === "evidence").readonly_user = "sfsmiths.readonly@example.com";
    writeConfigFile("orgs", orgs, p);
    syncAll(p, { skipSkills: true });
    const prodTargets = ["Production", "production", "PROD", "-o Production", "--target-org Production", "-o sfsmiths.readonly@example.com", "--target-org sfsmiths.readonly@example.com", "-o PartialUAT", "--target-org PartialUAT", "-o admin@example.com", "-o some-other-sandbox"];
    const writes = [
      (t) => `sf data create record --sobject Case --values "Subject=x" ${t}`,
      (t) => `sf data update record --sobject Case --record-id 500x --values "Status=Closed" ${t}`,
      (t) => `sf data delete record --sobject Case --record-id 500x ${t}`,
      (t) => `sf data upsert bulk --sobject Contact --file c.csv --external-id Ext__c ${t}`,
      (t) => `sf data import tree --files x.json ${t}`,
      (t) => `sf project deploy start --source-dir org/force-app ${t}`,
      (t) => `sf project deploy quick --job-id 0Af ${t}`,
      (t) => `sf apex run --file x.apex ${t}`,
      (t) => `sf project delete source --metadata ApexClass:X ${t}`,
      (t) => `sf org assign permset --name X ${t}`,
      (t) => `sf data query --query "SELECT Id FROM Case" ${t}`,            // even READS bypassing the mask
      (t) => `sf project retrieve start --metadata ApexClass:X ${t}`,
    ];
    let denied = 0;
    for (const t of prodTargets.filter((x) => x.startsWith("-"))) for (const w of writes) {
      const r = runHook(root, "policy", bash(w(t)));
      assert.ok(r.denied, `MUST deny: ${w(t)} — got ${r.reason}`);
      denied++;
    }
    assert.ok(denied >= 90, `${denied} denials`);
    // writes to the configured development alias are allowed (that is where agents work)
    for (const w of writes.slice(0, 8)) assert.ok(!runHook(root, "policy", bash(w("-o DevSandbox"))).denied, `dev alias must pass: ${w("-o DevSandbox")}`);
    // no target at all on a write → denied (fail closed: a default org could be production)
    assert.ok(runHook(root, "policy", bash("sf project deploy start --source-dir org/force-app")).denied, "write without explicit target is denied");
    // logging in / switching orgs / redirecting the keychain is never an agent's business
    for (const c of ["sf org login web", "sf org login sfdx-url --sfdx-url-file x", "sf config set target-org Production", "HOME=/tmp/other sf data query -q 'SELECT Id FROM Case' -o Production", "SF_TARGET_ORG=Production sf data query -q x", "curl -H 'Authorization: Bearer x' https://acme.my.salesforce.com/services/data/v60.0/sobjects/Case", "sfsmiths-human deployed DEMO-101 --org production", "git push origin main", "claude --agent conductor"]) {
      assert.ok(runHook(root, "policy", bash(c)).denied, `MUST deny: ${c}`);
    }
    // the static belt exists too: settings.json carries Production/PartialUAT denies even in a dev-only config
    const settings = readJson(path.join(root, ".claude/settings.json"));
    assert.ok(settings.permissions.deny.some((d) => /Production/.test(d)), "static Production deny present");
    assert.ok(settings.permissions.deny.some((d) => /git push/.test(d)), "static git push deny present");
  } finally { cleanup(root); }
});

test("RULE 1: the only road to production is the evidence layer — SELECT only, no subqueries, allowlisted object+fields, no Email/Phone fields, masked", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const cfg = loadConfig(p);
    for (const q of ["INSERT INTO Case (Subject) VALUES ('x')", "UPDATE Case SET Status = 'Closed'", "DELETE FROM Case WHERE Id = '500'", "UPSERT Case", "SELECT Id, (SELECT Id FROM Contacts) FROM Account", "MERGE Account", "SELECT Id FROM Case; DELETE FROM Case", "sf data delete record"]) {
      assert.throws(() => parseSoql(q), /Only SELECT|Subqueries|Only one SELECT/, `must refuse: ${q}`);
    }
    const parsed = parseSoql("SELECT Id, Status FROM Case WHERE Status = 'New' LIMIT 5");
    assert.equal(parsed.object, "Case");
    // PII-typed fields are refused even when someone lists them
    const pii = parseSoql("SELECT Id, SuppliedEmail FROM Case");
    const r = checkAllowlist(pii, cfg, p);
    assert.equal(r.ok, false); assert.match(r.reason, /Email|refused/i);
    const unlisted = checkAllowlist(parseSoql("SELECT Id FROM SecretObject__c"), cfg, p);
    assert.equal(unlisted.ok, false); assert.match(unlisted.reason, /not in config\/masking.yaml/);
  } finally { cleanup(root); }
});

test("RULE 1: the fenced browser refuses production and login hosts, Setup paths and unknown hosts, including every derived host of the org", () => {
  const dev = relatedHosts("acme--dev.sandbox.my.salesforce.com");
  const prod = relatedHosts("acme.my.salesforce.com");
  assert.ok(dev.includes("acme--dev.sandbox.lightning.force.com") && dev.includes("acme--dev.sandbox.my.site.com"), "derived dev hosts");
  const hosts = { allow: new Set(["test.salesforce.com", ...dev]), deny: new Set(["login.salesforce.com", ...prod]), denyPaths: [/^\/lightning\/setup\/.*/, /^\/_ui\/system\/.*/] };
  for (const u of ["https://acme.my.salesforce.com/", "https://acme.lightning.force.com/lightning/r/Case/500/view", "https://login.salesforce.com/", "https://acme.my.site.com/portal"]) {
    const c = checkUrl(u, hosts); assert.equal(c.ok, false, u); assert.match(c.reason, /PRODUCTION\/LOGIN host refused/);
  }
  for (const u of ["https://acme--dev.sandbox.lightning.force.com/lightning/setup/ObjectManager/Case/view", "https://acme--dev.sandbox.my.salesforce.com/_ui/system/security/x"]) {
    const c = checkUrl(u, hosts); assert.equal(c.ok, false, u); assert.match(c.reason, /Setup\/system URL refused/);
  }
  assert.equal(checkUrl("https://evil.example.com/", hosts).ok, false, "unknown host refused (fail closed)");
  assert.equal(checkUrl("http://acme--dev.sandbox.my.salesforce.com/", hosts).ok, false, "plain http refused");
  assert.equal(checkUrl("https://acme--dev.sandbox.lightning.force.com/lightning/r/Case/500/view", hosts).ok, true, "dev record page allowed");
});

/* ================= RULE 2 — e-mail containment ================= */

test("RULE 2: the allowlist is the only source of addresses — exact entries and patterns match, everything else fails", () => {
  const allow = ["qa.inbox@example.com", "*@example.org", "*.invalid"];
  assert.equal(emailAllowed("qa.inbox@example.com", allow), true);
  assert.equal(emailAllowed("someone.else@example.com", allow), false, "an exact entry is exact — no sibling addresses");
  assert.equal(emailAllowed("anyone@example.org", allow), true);
  assert.equal(emailAllowed("user@acme.com.invalid", allow), true, "sandbox-refreshed user e-mails");
  assert.equal(emailAllowed("customer@realcompany.com", allow), false);
  assert.equal(emailAllowed("qa.inbox@example.com.evil.com", allow), false, "suffix tricks fail");
});

test("RULE 2: canary semantics per delivery mode — blocked: delivered = FAIL; allowlist_only: delivered = PASS only with a clean census; unknown is never a pass", () => {
  const delivered = { success: true, errors: [] };
  const blockedOrg = { success: false, errors: [{ status: CANARY_BLOCKED_STATUSES[0], message: "Single email is not enabled" }] };
  const weird = { success: false, errors: [{ status: "LIMIT_EXCEEDED", message: "x" }] };
  assert.equal(classifyCanaryResult(delivered, "blocked").result, "fail");
  assert.equal(classifyCanaryResult(blockedOrg, "blocked").result, "pass");
  assert.equal(classifyCanaryResult(weird, "blocked").result, "unknown");
  assert.equal(classifyCanaryResult(delivered).result, "fail", "default mode is blocked");
  assert.equal(classifyCanaryResult(delivered, "allowlist_only").result, "pass");
  assert.match(classifyCanaryResult(delivered, "allowlist_only").detail, /census/);
  assert.equal(classifyCanaryResult(blockedOrg, "allowlist_only").result, "pass");
  assert.equal(classifyCanaryResult(weird, "allowlist_only").result, "unknown");
  // the census query counts every address OUTSIDE the allowlist, per configured field
  const q = censusQuery("Contact.Email", ["*@example.com", "*.invalid", "qa.inbox@example.org"]);
  assert.equal(q, "SELECT COUNT() FROM Contact WHERE Email != null AND (NOT Email LIKE '%@example.com') AND (NOT Email LIKE '%.invalid') AND Email != 'qa.inbox@example.org'");
  assert.match(censusQuery("Case.SuppliedEmail", ["*@example.com"]), /^SELECT COUNT\(\) FROM Case WHERE SuppliedEmail != null AND \(NOT SuppliedEmail LIKE '%@example.com'\)$/);
  assert.match(censusQuery("Lead.Email", ["o'brien@example.com"]), /Email != 'o\\'brien@example.com'/, "quotes are escaped");
});

test("RULE 2: the Safety screen edits the allowlist and the delivery mode as a form — validated, schema-checked, refusing an empty list or junk; the config defaults stay blocked", async () => {
  const root = makeProject();
  const p = projectPaths(root);
  const ui = await startUi({ p, open: false, log: () => {} });
  try {
    const token = ui.url.split("#t=")[1];
    const base = ui.url.split("/#")[0];
    const api = async (m, pth, body) => { const r = await fetch(base + "/api/" + pth, { method: m, headers: { "X-SFsmiths-Token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
    let s = await api("GET", "safety");
    assert.equal(s.status, 200);
    assert.equal(s.json.email_delivery, "blocked", "shipped default is blocked");
    assert.deepEqual(s.json.email_census_fields, ["Contact.Email", "Lead.Email", "User.Email", "Case.SuppliedEmail"]);
    assert.ok(s.json.allowed_test_emails.includes("*@example.com"));
    assert.ok(s.json.enforcement.length >= 4);
    // junk is refused, nothing written
    let r = await api("PUT", "safety", { allowed_test_emails: ["not an email"] }); assert.equal(r.status, 400); assert.match(r.json.error, /not an address or pattern/);
    r = await api("PUT", "safety", { allowed_test_emails: [] }); assert.equal(r.status, 400); assert.match(r.json.error, /cannot be empty/);
    r = await api("PUT", "safety", { email_delivery: "open_bar" }); assert.equal(r.status, 400);
    r = await api("PUT", "safety", { email_census_fields: ["Contact"] }); assert.equal(r.status, 400); assert.match(r.json.error, /Object\.Field/);
    assert.ok(!fs.existsSync(path.join(root, "config", "safety.yaml")), "nothing written on refusals");
    // a real edit: Suresh's two inboxes + the sandbox-refresh pattern, allowlist_only with a narrower census
    r = await api("PUT", "safety", { allowed_test_emails: ["qa.inbox@example.com", "dev.inbox@example.com", "*.invalid"], email_delivery: "allowlist_only", email_census_fields: ["Contact.Email", "Case.SuppliedEmail"] });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.match(r.json.note, /census/);
    const saved = loadConfigFile("safety", p);
    assert.deepEqual(saved.allowed_test_emails, ["qa.inbox@example.com", "dev.inbox@example.com", "*.invalid"]);
    assert.equal(emailDeliveryMode(saved), "allowlist_only");
    assert.deepEqual(emailCensusFields(saved), ["Contact.Email", "Case.SuppliedEmail"]);
    assert.equal(saved.test_tag_field, "Test_Tag__c", "untouched keys survive");
    s = await api("GET", "safety"); assert.equal(s.json.source, "personal");
    // and the gates now use the new list: the old example.org pattern is gone
    assert.equal(emailAllowed("x@example.org", saved.allowed_test_emails), false);
    assert.equal(emailAllowed("qa.inbox@example.com", saved.allowed_test_emails), true);
    // the schema also protects the raw YAML path
    assert.throws(() => writeConfigFile("safety", { ...saved, email_delivery: "yolo" }, p), /Refusing to write invalid/);
  } finally { ui.close(); cleanup(root); }
});

test("RULE 2: a repro-data script or an artifact with a non-allowlisted address fails the email-guard gate", async () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const { agentCli } = await import("./helpers.mjs");
    let r = agentCli(root, ["open", "DEMO-101"]); assert.equal(r.code, 0, r.stderr);
    write(path.join(root, "work/DEMO-101/artifacts/repro-data.apex"), "Contact c = new Contact(LastName='Rollout', Email='real.customer@acme-corp.com');\ninsert c;\n");
    const { buildContext, runGate } = await import(path.join(REPO, "dist/gates/registry.js"));
    let g = await runGate("email-guard", buildContext("DEMO-101", "repro", {}, p), { persist: false });
    assert.equal(g.status, "failed"); assert.match(g.reason, /non-allowlisted/); assert.match(g.reason, /re\*\*\*@acme-corp\.com/, "the offender is masked in the report");
    write(path.join(root, "work/DEMO-101/artifacts/repro-data.apex"), "Contact c = new Contact(LastName='Rollout', Email='rollout.manager@example.com');\ninsert c;\n");
    g = await runGate("email-guard", buildContext("DEMO-101", "repro", {}, p), { persist: false });
    assert.equal(g.status, "passed");
  } finally { cleanup(root); }
});

/* ================= RULE 3 — nothing is guessed ================= */

test("RULE 3: 'unavailable' is never a pass — a stage whose gate could not run does not advance; contracts need evidence refs", async () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const { stageGatesAllPassed } = await import(path.join(REPO, "dist/core/manifest.js"));
    const m = { gates: { plan: [{ name: "plan-lint", status: "unavailable", at: "x" }, { name: "contract-check", status: "passed", at: "x" }] } };
    const g = stageGatesAllPassed(m, "plan", ["plan-lint", "contract-check"]);
    assert.equal(g.ok, false); assert.equal(g.failing[0].name, "plan-lint");
    // an unknown gate name is unavailable, not passed
    const { buildContext, runGate } = await import(path.join(REPO, "dist/gates/registry.js"));
    const { agentCli } = await import("./helpers.mjs");
    agentCli(root, ["open", "DEMO-101"]);
    const u = await runGate("no-such-gate", buildContext("DEMO-101", "plan", {}, p), { persist: false });
    assert.equal(u.status, "unavailable");
    // a contract whose evidence refs point at files that do not exist fails contract-check
    writeJson(path.join(root, "work/DEMO-101/00d-cartography.json"), { objects: [{ api_name: "Case", evidence: { source: "L1", ref: "evidence/does-not-exist.json" } }], components: [], automation: [], consumers: [], data_shape: [], drift: [], unknowns: [], evidence: [{ source: "L1", ref: "evidence/does-not-exist.json" }] });
    write(path.join(root, "work/DEMO-101/00d-cartography.md"), "# map\n");
    const c = await runGate("contract-check", buildContext("DEMO-101", "cartography", {}, p), { persist: false });
    assert.notEqual(c.status, "passed", c.reason);
  } finally { cleanup(root); }
});

/* ================= RULE 4 — official sources only, agents never browse ================= */

test("RULE 4: every agent denies WebFetch and WebSearch; the mirror fetches only Salesforce documentation domains; curated notes need provenance", () => {
  const agentsDir = path.join(REPO, ".claude", "agents");
  for (const f of fs.readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(agentsDir, f), "utf8"))[1];
    const tools = (/^tools:\s*(.+)$/m.exec(fm)?.[1] ?? "").split(",").map((s) => s.trim());
    const disallowed = (/^disallowedTools:\s*(.+)$/m.exec(fm)?.[1] ?? "").split(",").map((s) => s.trim());
    for (const t of ["WebFetch", "WebSearch"]) { assert.ok(!tools.includes(t), `${f} lists ${t}`); assert.ok(disallowed.includes(t), `${f} must disallow ${t}`); }
  }
  for (const u of ["https://developer.salesforce.com/docs/llms.txt", "https://help.salesforce.com/s/articleView?id=x", "https://architect.salesforce.com/decision-guides/x", "https://trailhead.salesforce.com/content/learn/modules/x", "https://github.com/forcedotcom/sf-skills", "https://github.com/salesforcecli/cli"]) assert.equal(sourceTrusted(u).ok, true, u);
  for (const u of ["https://medium.com/@someone/salesforce-tips", "https://stackoverflow.com/questions/1", "https://github.com/random-person/repo", "http://developer.salesforce.com/docs/llms.txt", "https://developer.salesforce.com.evil.com/x", "https://salesforce-blog.example.net/x"]) assert.equal(sourceTrusted(u).ok, false, u);
  assert.ok(DEFAULT_TRUSTED_DOMAINS.includes("help.salesforce.com"));
  const root = makeProject();
  try {
    const p = projectPaths(root);
    assert.deepEqual(loadTrustedDomains(p), DEFAULT_TRUSTED_DOMAINS, "the shipped sources.yaml carries the default trusted list");
    assert.equal(curatedLint(p).ok, true, "a fresh project has only the README");
    write(path.join(root, "knowledge/curated/trigger-framework-notes.md"), "# notes\nUse one trigger per object.\n");
    let l = curatedLint(p); assert.equal(l.ok, false); assert.match(l.problems[0], /no frontmatter/);
    write(path.join(root, "knowledge/curated/trigger-framework-notes.md"), "---\nsource_url: https://medium.com/@mvp/triggers\nauthor: An MVP\ntrust: official\nretrieved: 2026-09-20\nadded_by: operator\n---\n# notes\n");
    l = curatedLint(p); assert.equal(l.ok, false); assert.match(l.problems.join("; "), /trust "official" but source_url is not a Salesforce documentation domain/);
    write(path.join(root, "knowledge/curated/trigger-framework-notes.md"), "---\nsource_url: https://medium.com/@mvp/triggers\nauthor: An MVP\ntrust: mvp\nretrieved: 2026-09-20\nadded_by: operator\n---\n# notes\n");
    l = curatedLint(p); assert.equal(l.ok, true, l.problems.join("; ")); assert.equal(l.files, 1);
    // the doctor surfaces it (quick mode, no org calls)
    write(path.join(root, "knowledge/mirror/sources.yaml"), "trusted_domains:\n  - developer.salesforce.com\nsources:\n  - { name: blog.txt, url: https://medium.com/@x/y, kind: other }\n");
    const doctorMod = import(path.join(REPO, "dist/doctor/index.js"));
    return doctorMod.then(async ({ doctor }) => {
      const c = (await doctor({ quick: true, p })).checks.find((x) => x.id === "17");
      assert.equal(c.level, "fail"); assert.match(c.detail, /non-Salesforce host/);
    }).finally(() => cleanup(root));
  } catch (e) { cleanup(root); throw e; }
});
