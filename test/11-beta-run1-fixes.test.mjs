/**
 * Fixes from the first setup on a real machine (D-088): machine-specific static denies for every non-development org in
 * the agent keychain, default alias denies never dropped, `sf plugins` short names, and pasted-default e-mail patterns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, cleanup, REPO } from "./helpers.mjs";
import { projectPaths } from "../dist/core/paths.js";
import { loadConfig, writeConfigFile, loadConfigFile } from "../dist/core/config.js";
import { keychainDenyRules, syncKeychainDenies, syncSettingsDenies, KEYCHAIN_DENY_RE } from "../dist/engines/sync.js";
import { parseSfPlugins } from "../dist/doctor/index.js";
import { sanitizeEmailPatterns } from "../dist/engines/setup.js";

// shape of `sf org list --all --json` result entries on a developer's machine: other sandboxes, an admin production login (DevHub), an expired one
const KEYCHAIN = [
  { alias: "acme-prod", username: "dev@example.com", isDevHub: true },
  { alias: "advcomm", username: "dev@example.com.advcomm", isSandbox: true },
  { alias: "devsbx", username: "dev@example.com.devbox", isSandbox: true },
  { alias: "oldbox", username: "dev@example.com.oldbox", isSandbox: true, connectedStatus: "expired access/refresh token" },
  { alias: "uat", aliases: ["uat", "partial"], username: "dev@example.com.partialuat", isSandbox: true },
];

test("keychainDenyRules: every non-development org is denied by alias AND username, in both flag spellings; the dev org is not", () => {
  const { rules, targets } = keychainDenyRules(KEYCHAIN, ["devsbx"]);
  assert.deepEqual(targets, ["acme-prod", "advcomm", "dev@example.com", "dev@example.com.advcomm", "dev@example.com.oldbox", "dev@example.com.partialuat", "oldbox", "partial", "uat"]);
  assert.ok(rules.includes("Bash(sf * -o acme-prod)") && rules.includes("Bash(sf * --target-org acme-prod)") && rules.includes("Bash(sf * -o=acme-prod)") && rules.includes("Bash(sf * --target-org=dev@example.com)"));
  assert.ok(!rules.some((r) => /devsbx|devbox/.test(r)), "the development org and its username are never denied");
  for (const r of rules) assert.match(r, KEYCHAIN_DENY_RE);
});

test("syncKeychainDenies writes .claude/settings.local.json (gitignored), keeps foreign entries, and is idempotent", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const orgs = loadConfigFile("orgs", p);
    orgs.orgs = [{ ...orgs.orgs[0], alias: "devsbx" }];
    writeConfigFile("orgs", orgs, p);
    const cfg = loadConfig(p, { fresh: true });
    const file = path.join(root, ".claude", "settings.local.json");
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(ls *)"], deny: ["Bash(rm -rf *)"] } }, null, 2));
    const warnings = [];
    const r = syncKeychainDenies(p, cfg, warnings, KEYCHAIN);
    assert.equal(r.written, true); assert.deepEqual(warnings, []);
    const local = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(local.permissions.allow.includes("Bash(ls *)") && local.permissions.deny.includes("Bash(rm -rf *)"), "foreign entries survive");
    assert.ok(local.permissions.deny.includes("Bash(sf * -o acme-prod)"));
    assert.ok(typeof local._sfsmiths === "string", "managed-file note present");
    // second run: nothing changes; a removed org disappears from the managed block
    assert.equal(syncKeychainDenies(p, cfg, warnings, KEYCHAIN).written, false);
    syncKeychainDenies(p, cfg, warnings, KEYCHAIN.filter((e) => e.alias !== "advcomm"));
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(!after.permissions.deny.some((d) => /advcomm/.test(d)) && after.permissions.deny.includes("Bash(sf * -o acme-prod)"));
    assert.match(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8"), /settings\.local\.json/, "the file must stay out of git");
    // no sf CLI available → best effort, warning, nothing written
    const w2 = [];
    const r2 = syncKeychainDenies(p, cfg, w2, undefined);
    if (!r2.written) assert.ok(w2.length === 0 || /keychain denies/.test(w2[0]));
  } finally {
    cleanup(root);
  }
});

test("configured-alias denies go to settings.local.json; settings.json is never rewritten and keeps its static Production*/PartialUAT* rules", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const settingsFile = path.join(root, ".claude", "settings.json");
    const beforeSettings = fs.readFileSync(settingsFile, "utf8");
    const orgs = loadConfigFile("orgs", p);
    orgs.orgs = [{ ...orgs.orgs[0], alias: "devsbx" }, { alias: "uat", role: "preprod", keychain: "engine", write: false, email_deliverability: "unknown", deliverability_verified_on: null, deliverability_verified_by: null }];
    writeConfigFile("orgs", orgs, p);
    const cfg = loadConfig(p, { fresh: true });
    assert.equal(syncSettingsDenies(p, cfg, []), true);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), beforeSettings, "tracked settings.json untouched");
    const staticDeny = JSON.parse(beforeSettings).permissions.deny;
    assert.ok(staticDeny.includes("Bash(sf project deploy * -o Production*)") && staticDeny.includes("Bash(sf data query * --target-org PartialUAT*)"));
    const local = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8")).permissions.deny;
    assert.ok(local.includes("Bash(sf project deploy * -o uat*)") && local.includes("Bash(sf data query * --target-org uat*)"));
    assert.ok(!local.some((d) => /devsbx/.test(d)));
    // the personal config never touches git: it is ignored, the defaults are tracked
    assert.match(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8"), /^config\/\*\.yaml$/m);
    assert.ok(fs.existsSync(path.join(REPO, "config", "defaults", "orgs.yaml")));
  } finally {
    cleanup(root);
  }
});

test("parseSfPlugins reads short names from the installed section and ignores the JIT list", () => {
  const before = "code-analyzer 5.13.0\ncommunity 3.3.65 (3.3.65)\n\nUninstalled JIT Plugins:\ncustom-metadata 3.3.111\nflow 1.0.5\n";
  assert.deepEqual(parseSfPlugins(before), { codeAnalyzer: "5.13.0", flow: undefined });
  const after = "code-analyzer 5.13.0\ncommunity 3.3.65 (3.3.65)\nflow 2.0.1\n\nUninstalled JIT Plugins:\ncustom-metadata 3.3.111\n";
  assert.deepEqual(parseSfPlugins(after), { codeAnalyzer: "5.13.0", flow: "2.0.1" });
  assert.deepEqual(parseSfPlugins("@salesforce/plugin-flow 2.0.1\n@salesforce/plugin-code-analyzer 5.0.0\n"), { codeAnalyzer: "5.0.0", flow: "2.0.1" });
});

test("sanitizeEmailPatterns strips a pasted bracketed default and duplicates", () => {
  assert.deepEqual(sanitizeEmailPatterns(["*@example.com", "*.invalid", "me@example.com", "me+*@example.com", "[*@example.com", "*.invalid]"]), ["*@example.com", "*.invalid", "me@example.com", "me+*@example.com"]);
  assert.deepEqual(sanitizeEmailPatterns([" '*@example.com' ", ""]), ["*@example.com"]);
});
