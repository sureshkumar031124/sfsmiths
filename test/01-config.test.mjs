import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { makeProject, cleanup } from "./helpers.mjs";
import { loadConfig, loadConfigFile, writeConfigFile, CONFIG_FILES, tryLoadConfig } from "../dist/core/config.js";
import { projectPaths } from "../dist/core/paths.js";

test("all 14 default config files load and validate against their schemas", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const cfg = loadConfig(p, { fresh: true });
    assert.equal(CONFIG_FILES.length, 14);
    for (const n of CONFIG_FILES) assert.ok(cfg[n], `config ${n} loaded`);
    assert.equal(cfg.orgs.orgs.filter((o) => o.role === "development").length, 1, "exactly one development org by default");
    assert.ok(cfg.orgs.orgs.find((o) => o.role === "preprod").keychain === "engine", "preprod lives in the engine keychain");
    assert.ok(cfg.orgs.orgs.find((o) => o.role === "evidence").write === false, "evidence org is read-only");
    assert.ok(cfg.safety.allowed_test_emails.some((g) => g.includes("example.com")));
    assert.equal(cfg.tracker.post_draft, "disabled");
  } finally { cleanup(root); }
});

test("writeConfigFile refuses invalid config and writes nothing", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const before = loadConfigFile("budgets", p);
    assert.throws(() => writeConfigFile("budgets", { ...before, per_ticket: { tokens: -5, usd: 1, wall_minutes: 1 } }, p), /Refusing to write invalid/);
    assert.deepEqual(loadConfigFile("budgets", p), before, "file unchanged after refused write");
    writeConfigFile("budgets", { ...before, daily_usd: 42 }, p);
    assert.equal(loadConfigFile("budgets", p).daily_usd, 42);
  } finally { cleanup(root); }
});

test("tryLoadConfig reports a broken file without throwing", () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    fs.writeFileSync(path.join(root, "config", "notify.yaml"), "version: 1\nslack_webhook_env: 123\n: bad yaml\n");
    const { errors, cfg } = tryLoadConfig(p);
    assert.ok(errors.notify, "notify reported");
    assert.ok(cfg.orgs, "others still load");
  } finally { cleanup(root); }
});
