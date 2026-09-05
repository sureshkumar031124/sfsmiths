import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { makeProject, cleanup, runHook, writeJson } from "./helpers.mjs";

const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const write = (root, rel, agent = "a4-developer") => ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(root, rel) }, agent_type: agent });
const spawn = (name) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: name, prompt: "x" } });

test("policy hook — production/preprod/human/keychain/push denials, dev work allowed", () => {
  const root = makeProject();
  try {
    const deny = [
      ["sf project deploy start --source-dir org/force-app -o Production", /production/],
      ["sf project deploy start --source-dir org/force-app --target-org PartialUAT", /preprod|engine-only/],
      ["sf data query -q 'SELECT Id FROM Case' -o Production", /masking|production/],
      ["sf data create record -s Case -v 'Subject=x'", /explicit --target-org|development/],
      ["sf data create record -s Case -v 'Subject=x' -o SomeOtherOrg", /not an allowed development/],
      ["sfsmiths-human approve DEMO-101", /human operator/],
      ["node bin/sfsmiths-human.js sync", /human operator/],
      ["HOME=/tmp/x sf org list", /HOME/],
      ["export SF_TARGET_ORG=Production; sf data query -q x", /SF_\*/],
      ["cat ~/.sfsmiths/engine/.sfdx/alias.json", /engine keychain/],
      ["git push origin main", /never push/],
      ["git push bluecanvas main", /Blue Canvas/],
      ["claude -p 'do things' --agent conductor", /claude sessions/],
      ["curl https://myorg.my.salesforce.com/services/data/v60.0/query?q=SELECT+Id+FROM+Case", /direct HTTP/],
      ["echo x > .claude/settings.json", /protected path/],
      ["sed -i 's/a/b/' config/orgs.yaml", /protected path/],
      ["rm -rf src/hooks", /protected path/],
      ["echo x >> work/DEMO-101/manifest.yaml", /toolkit only/],
      ["sf org login web -a Whatever", /human/],
      ["sfsmiths agent approve DEMO-101", /human-only/],
      ["cp /tmp/evil.json .claude/settings.json", /protected path/],
      ["mv work/DEMO-101/x.yaml config/orgs.yaml", /protected path/],
      ["cat /tmp/x | tee .claude/settings.json", /protected path/],
      ["cat /tmp/x | tee -a CLAUDE.md", /protected path/],
      ["rm -rf .claude/agents", /protected path/],
      ["python3 -c \"open('.claude/settings.json','w').write('x')\"", /protected path/],
      ["node -e \"require('fs').writeFileSync('config/orgs.yaml','x')\"", /protected path/],
      ["git checkout -- .claude/settings.json", /protected path/],
    ];
    for (const [cmd, re] of deny) {
      const r = runHook(root, "policy", bash(cmd));
      assert.equal(r.code, 0, `exit 0 for ${cmd}`);
      assert.ok(r.denied, `denied: ${cmd}`);
      assert.match(r.reason, re, `reason for ${cmd}: ${r.reason}`);
    }
    const allow = [
      "sfsmiths agent handoff DEMO-101",
      "sfsmiths agent evidence count Case --ticket DEMO-101 --purpose 'x'",
      "sf project deploy start --source-dir org/force-app -o DevSandbox --json",
      "sf data query -q 'SELECT Id FROM Case LIMIT 1' -o DevSandbox --json",
      "sf apex run test -o DevSandbox --synchronous --json",
      "git status && git diff --stat",
      "cat org/force-app/main/default/classes/CaseTrigger.cls",
      "mkdir -p work/DEMO-101/artifacts && cp templates/repro-data.apex work/DEMO-101/artifacts/",
      "grep -rn 'with sharing' org/force-app",
      "ls docs/",
      "echo '- fact' >> work/DEMO-101/facts.md",
      "cp org/force-app/main/default/classes/A.cls work/DEMO-101/artifacts/A.cls.bak",
      "cat config/naming.yaml",
      "grep -n pattern config/naming.yaml docs/SETUP.md",
      "node -e \"console.log(1)\"",
    ];
    for (const cmd of allow) {
      const r = runHook(root, "policy", bash(cmd));
      assert.equal(r.code, 0);
      assert.ok(!r.denied, `allowed: ${cmd} (got ${r.reason})`);
    }
  } finally { cleanup(root); }
});

test("write-guard — write areas, protected paths, other agents' memory, ticket state files", () => {
  const root = makeProject();
  try {
    fs.mkdirSync(path.join(root, "work", "DEMO-101"), { recursive: true });
    fs.writeFileSync(path.join(root, "work", ".active-ticket"), "DEMO-101");
    const ok = ["org/force-app/main/default/classes/CaseEscalationOwnerService.cls", "tests-ui/specs/case-escalation.spec.ts", "work/DEMO-101/02-repro.md", "work/DEMO-101/artifacts/repro-data.apex", ".claude/agent-memory/a4-developer/MEMORY.md", "inbox/DEMO-102.md"];
    for (const rel of ok) { const r = runHook(root, "write-guard", write(root, rel)); assert.ok(!r.denied, `allowed ${rel}: ${r.reason}`); }
    const bad = [".claude/settings.json", ".claude/agents/a4-developer.md", ".claude/skills/std-apex-conventions/SKILL.md", "CLAUDE.md", "config/orgs.yaml", "knowledge/lessons/L-1.md", "templates/prompts/a4-developer.md", "src/hooks/fast.ts", "bin/sfsmiths.js", "package.json", ".mcp.json", "work/DEMO-101/manifest.yaml", "work/DEMO-101/.state.json", "work/DEMO-101/validations/x.json", "work/DEMO-101/approvals/plan.json", "work/DEMO-999/02-repro.md", ".claude/agent-memory/a3-architect/MEMORY.md", "docs/SETUP.md", ".sfsmiths/policy.compiled.json"];
    for (const rel of bad) { const r = runHook(root, "write-guard", write(root, rel)); assert.ok(r.denied, `denied ${rel}`); }
    // role exceptions
    assert.ok(!runHook(root, "write-guard", write(root, "docs/org-map/Case.md", "a0-cartographer")).denied, "cartographer may write the org map");
    assert.ok(runHook(root, "write-guard", write(root, "docs/org-map/Case.md", "a4-developer")).denied, "developer may not");
    assert.ok(!runHook(root, "write-guard", write(root, "knowledge/lessons/PENDING/L-20260905-x.md", "a7-coach")).denied, "coach files candidates");
    assert.ok(runHook(root, "write-guard", write(root, "knowledge/lessons/L-20260905-x.md", "a7-coach")).denied, "coach may not touch approved lessons");
    // outside project: engine home + sf keychain denied, /tmp scratch allowed
    assert.ok(runHook(root, "write-guard", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(process.env.HOME || "/root", ".sfdx", "alias.json") } }).denied);
    assert.ok(!runHook(root, "write-guard", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/tmp/sfsmiths-scratch.txt" } }).denied);
    // events recorded
    const ev = fs.readFileSync(path.join(root, ".sfsmiths", "events.jsonl"), "utf8");
    assert.ok(ev.includes('"write.denied"'));
  } finally { cleanup(root); }
});

test("agent-gate — denied agents, no ticket, wrong stage, waiting_human; allowed when the sidecar says so", () => {
  const root = makeProject();
  try {
    assert.ok(runHook(root, "agent-gate", spawn("salesforce-dev")).denied);
    assert.ok(runHook(root, "agent-gate", spawn("salesforce-development:salesforce-dev")).denied);
    let r = runHook(root, "agent-gate", spawn("a4-developer"));
    assert.ok(r.denied); assert.match(r.reason, /no active ticket/);
    assert.ok(!runHook(root, "agent-gate", spawn("a0-cartographer")).denied, "maintenance agent allowed without a ticket");
    fs.mkdirSync(path.join(root, "work", "DEMO-101"), { recursive: true });
    fs.writeFileSync(path.join(root, "work", ".active-ticket"), "DEMO-101");
    writeJson(path.join(root, "work", "DEMO-101", ".state.json"), { ticket: "DEMO-101", status: "running", stage: "intake", tier: "HIGH", next_allowed_stages: ["a1-intake"], waiting: null });
    assert.ok(!runHook(root, "agent-gate", spawn("a1-intake")).denied);
    r = runHook(root, "agent-gate", spawn("a4-developer")); assert.ok(r.denied); assert.match(r.reason, /out of order/);
    writeJson(path.join(root, "work", "DEMO-101", ".state.json"), { ticket: "DEMO-101", status: "waiting_human", stage: "plan", tier: "HIGH", next_allowed_stages: ["a3-architect"], waiting: { kind: "approval", stage: "plan" } });
    r = runHook(root, "agent-gate", spawn("a3-architect")); assert.ok(r.denied); assert.match(r.reason, /waiting for human/);
    writeJson(path.join(root, "work", "DEMO-101", ".state.json"), { ticket: "DEMO-101", status: "running", stage: "repro", tier: "HIGH", next_allowed_stages: ["a2-repro", "a8-ui"], waiting: null });
    assert.ok(!runHook(root, "agent-gate", spawn("a8-ui")).denied, "support agent allowed during repro");
  } finally { cleanup(root); }
});

test("data-guard — MCP writes need a fresh PASS canary; reads never do", () => {
  const root = makeProject();
  try {
    const mcp = (tool) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} });
    assert.ok(!runHook(root, "data-guard", mcp("mcp__sf-dev__run_soql_query")).denied);
    assert.ok(!runHook(root, "data-guard", mcp("mcp__sf-dev__retrieve_metadata")).denied);
    assert.ok(!runHook(root, "data-guard", mcp("mcp__sf-dev__run_apex_test")).denied, "tests never deliver mail");
    assert.ok(!runHook(root, "data-guard", mcp("mcp__sf-dev__deploy_metadata")).denied, "metadata deploy is not a data side effect");
    const dataTool = "mcp__sf-dev__assign_permission_set"; // a side-effect tool (statically denied too — the hook logic is what we test)
    let r = runHook(root, "data-guard", mcp(dataTool));
    assert.ok(r.denied); assert.match(r.reason, /canary/);
    const canary = path.join(root, ".sfsmiths", "canary", "devsandbox.json");
    writeJson(canary, { org: "DevSandbox", at: new Date().toISOString(), result: "fail", detail: "email delivered — deliverability is ON" });
    r = runHook(root, "data-guard", mcp(dataTool)); assert.ok(r.denied); assert.match(r.reason, /FAIL/);
    writeJson(canary, { org: "DevSandbox", at: new Date(Date.now() - 3 * 3600_000).toISOString(), result: "pass", detail: "NO_MASS_MAIL_PERMISSION" });
    r = runHook(root, "data-guard", mcp(dataTool)); assert.ok(r.denied); assert.match(r.reason, /min old/);
    writeJson(canary, { org: "DevSandbox", at: new Date().toISOString(), result: "pass", detail: "NO_MASS_MAIL_PERMISSION" });
    assert.ok(!runHook(root, "data-guard", mcp(dataTool)).denied);
  } finally { cleanup(root); }
});

test("kill switch SFSMITHS_HOOKS_OFF=1 disables hooks (documented escape hatch) and fast hooks fail closed on garbage input", () => {
  const root = makeProject();
  try {
    assert.ok(!runHook(root, "policy", bash("sfsmiths-human approve X"), { SFSMITHS_HOOKS_OFF: "1" }).denied);
    const r = import_child.spawnSync("node", [path.join(process.cwd(), "bin", "sfsmiths-hook.js"), "policy"], { input: "{not json", encoding: "utf8", env: { ...process.env, SFSMITHS_PROJECT_DIR: root } });
    assert.equal(r.status, 0, "garbage input → no crash");
  } finally { cleanup(root); }
});

import * as import_child from "node:child_process";
