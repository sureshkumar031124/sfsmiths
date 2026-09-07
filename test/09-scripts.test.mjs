/**
 * The verify/CI helper scripts: run-tests.mjs (explicit file list, filters) and repo-checks.mjs (settings hooks wired,
 * marketplace pinned, agent frontmatter). Regression for the first GitHub CI run (D-085): Node 20 glob + quote escaping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO } from "./helpers.mjs";

const node = (script, args = [], cwd = REPO) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });

/** A throwaway copy of just the Claude Code layer + the script, so the checks can be broken on purpose. */
function makeLayerCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsmiths-layer-"));
  fs.cpSync(path.join(REPO, ".claude"), path.join(root, ".claude"), { recursive: true });
  fs.cpSync(path.join(REPO, ".claude-plugin"), path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(REPO, "scripts", "repo-checks.mjs"), path.join(root, "scripts", "repo-checks.mjs"));
  return root;
}

test("run-tests: a filter that matches nothing fails; a matching filter runs only those files", () => {
  const none = node(path.join(REPO, "scripts", "run-tests.mjs"), ["no-such-test-file"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no test file matches/);
  // run file 01 with a test-name pattern nothing matches → the runner still exits 0 (the file was found and executed;
  // its output is inherited, so only the exit status is observable here)
  const one = node(path.join(REPO, "scripts", "run-tests.mjs"), ["01-config", "--test-name-pattern=__nothing_matches__"]);
  assert.equal(one.status, 0, one.stderr);
});

test("repo-checks: passes on the repository itself", () => {
  const r = node(path.join(REPO, "scripts", "repo-checks.mjs"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /repo-checks: ok/);
});

test("repo-checks: an unwired hook, a repo-relative hook path, an unpinned plugin and a misnamed agent all fail", () => {
  const root = makeLayerCopy();
  try {
    const script = path.join(root, "scripts", "repo-checks.mjs");
    const settingsFile = path.join(root, ".claude", "settings.json");
    const original = fs.readFileSync(settingsFile, "utf8");
    assert.equal(node(script, [], root).status, 0, "the untouched copy must pass");

    // 1. drop the Stop hook
    const s = JSON.parse(original);
    delete s.hooks.Stop;
    fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
    let r = node(script, [], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hook not wired.*stop-guard/);

    // 2. a hook that runs the repo copy instead of the installed one
    const s2 = JSON.parse(original);
    s2.hooks.Stop[0].hooks[0].command = "node bin/sfsmiths-hook.js stop-guard";
    fs.writeFileSync(settingsFile, JSON.stringify(s2, null, 2));
    r = node(script, [], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /installed copy/);
    fs.writeFileSync(settingsFile, original);

    // 3. plugin pinned to a short sha
    const mpFile = path.join(root, ".claude-plugin", "marketplace.json");
    const mp = JSON.parse(fs.readFileSync(mpFile, "utf8"));
    const mpOriginal = JSON.stringify(mp, null, 2);
    mp.plugins[0].source.sha = "7e04d474";
    fs.writeFileSync(mpFile, JSON.stringify(mp, null, 2));
    r = node(script, [], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not pinned to a 40-char sha/);
    fs.writeFileSync(mpFile, mpOriginal);

    // 4. agent whose frontmatter name differs from its file name
    const agentFile = path.join(root, ".claude", "agents", "a1-intake.md");
    fs.writeFileSync(agentFile, fs.readFileSync(agentFile, "utf8").replace(/^name: a1-intake$/m, "name: intake"));
    r = node(script, [], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a1-intake\.md: name must be "a1-intake"/);
    assert.match(r.stderr, /conductor\.md allows unknown agent "a1-intake"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
