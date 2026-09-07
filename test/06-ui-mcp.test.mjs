import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { makeProject, cleanup, REPO } from "./helpers.mjs";
import { projectPaths } from "../dist/core/paths.js";
import { openTicket } from "../dist/engines/lifecycle.js";
import { startUi } from "../dist/ui/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("UI server: 127.0.0.1 only, token required, Host/Origin checked, config writes validated, approvals recorded", async () => {
  const root = makeProject();
  const p = projectPaths(root);
  await openTicket("DEMO-101", { p });
  const ui = await startUi({ p, open: false, log: () => {} });
  try {
    const u = new URL(ui.url);
    const token = u.hash.replace(/^#t=/, "");
    const base = `http://127.0.0.1:${u.port}`;
    const api = (m, pth, body, headers = {}) => fetch(base + "/api/" + pth, { method: m, headers: { "X-SFsmiths-Token": token, "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    // static page served without token; token never in query string
    const page = await fetch(base + "/");
    assert.equal(page.status, 200); assert.match(await page.text(), /SFsmiths/);
    // API without token → 401
    let r = await fetch(base + "/api/dashboard"); assert.equal(r.status, 401);
    // wrong Host → 403 (DNS rebinding defence)
    // (fetch forbids overriding Host, so use node:http for the rebinding case)
    const hostStatus = await new Promise((resolve) => { const req = http.request({ host: "127.0.0.1", port: Number(u.port), path: "/api/dashboard", headers: { "X-SFsmiths-Token": token, Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", () => resolve(-1)); req.end(); });
    assert.equal(hostStatus, 403);
    // cross-site Origin → 403
    r = await api("GET", "dashboard", undefined, { Origin: "http://evil.example" }); assert.equal(r.status, 403);
    // happy path
    r = await api("GET", "dashboard"); assert.equal(r.status, 200);
    const d = await r.json(); assert.equal(d.counts.tickets, 1); assert.ok(d.recent[0].ticket === "DEMO-101");
    // canary card reads the state file runCanary writes (result/at), never a phantom `status`; stale passes are marked
    assert.equal(d.canary.DevSandbox.result, "never");
    fs.mkdirSync(path.join(root, ".sfsmiths", "canary"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sfsmiths", "canary", "DevSandbox.json"), JSON.stringify({ at: new Date().toISOString(), org: "DevSandbox", result: "pass", detail: "NO_SINGLE_MAIL_PERMISSION" }));
    let cs = (await (await api("GET", "dashboard")).json()).canary.DevSandbox; assert.equal(cs.result, "pass"); assert.equal(cs.fresh, true);
    fs.writeFileSync(path.join(root, ".sfsmiths", "canary", "DevSandbox.json"), JSON.stringify({ at: new Date(Date.now() - 3 * 3600_000).toISOString(), org: "DevSandbox", result: "pass", detail: "x" }));
    cs = (await (await api("GET", "dashboard")).json()).canary.DevSandbox; assert.equal(cs.result, "pass"); assert.equal(cs.fresh, false, "a 3-hour-old pass is stale");
    r = await api("GET", "tickets/DEMO-101"); assert.equal(r.status, 200); const t = await r.json(); assert.equal(t.manifest.ticket, "DEMO-101"); assert.ok(Array.isArray(t.stage_defs));
    r = await api("GET", "agents"); const ag = await r.json(); assert.equal(ag.agents.length, 12); assert.ok(ag.agents.every((a) => a.agent_file_exists), "all 12 agent files present");
    r = await api("GET", "orgs"); assert.equal(r.status, 200); const o = await r.json(); assert.equal(o.config.orgs.length, 3);
    r = await api("GET", "lessons"); assert.equal(r.status, 200);
    r = await api("GET", "tokens"); assert.equal(r.status, 200);
    r = await api("GET", "config"); const c = await r.json(); assert.equal(c.files.length, 14);
    // config write: invalid → 400 and unchanged; valid → 200 + sync
    const before = fs.readFileSync(path.join(root, "config/defaults/budgets.yaml"), "utf8");
    assert.ok(!fs.existsSync(path.join(root, "config/budgets.yaml")), "no personal copy before the first edit");
    r = await api("PUT", "config/budgets", { yaml: "version: 1\nper_ticket: { tokens: -1, usd: 1, wall_minutes: 1 }\ndaily_usd: 1\non_exceed: park\npipeline_max_budget_usd: 1\n" });
    assert.equal(r.status, 400); assert.ok(!fs.existsSync(path.join(root, "config/budgets.yaml")), "an invalid edit writes nothing");
    r = await api("PUT", "config/budgets", { yaml: before.replace(/daily_usd: \d+/, "daily_usd: 77") });
    assert.equal(r.status, 200); assert.match(fs.readFileSync(path.join(root, "config/budgets.yaml"), "utf8"), /daily_usd: 77/);
    // unknown config name → 404; path traversal in file view → 400
    r = await api("GET", "config/../../etc/passwd"); assert.ok([400, 404].includes(r.status));
    r = await api("GET", "tickets/DEMO-101/file?name=../../config/orgs.yaml"); assert.equal(r.status, 400);
    r = await api("GET", "tickets/DEMO-101/file?name=ticket.md"); assert.equal(r.status, 200);
    // models write through the Agents screen shape → agent files re-synced
    const models = (await (await api("GET", "config/models")).json());
    const yaml = (await import("yaml")).default;
    const mv = yaml.parse(models.yaml); mv.agents["a4-developer"] = "sonnet";
    r = await api("PUT", "config/models", { value: mv }); assert.equal(r.status, 200);
    const sync = (await r.json()).sync; assert.ok(sync.agents_updated.some((x) => x.startsWith("a4-developer")), JSON.stringify(sync));
    assert.match(fs.readFileSync(path.join(root, ".claude/agents/a4-developer.md"), "utf8"), /^model: sonnet$/m);
    // approval through the UI has origin "ui" and is refused when nothing waits with the wrong stage
    r = await api("POST", "tickets/DEMO-101/reject", { reason: "" }); assert.equal(r.status, 400, "rejection needs a reason");
    r = await api("POST", "tickets/DEMO-101/approve", { stage: "intake", answer: "checked the scope list" }); assert.equal(r.status, 200);
    const appr = (await r.json()).approval; assert.equal(appr.origin, "ui");
    // hold from the UI
    r = await api("POST", "tickets/DEMO-101/hold", { reason: "ui hold" }); assert.equal(r.status, 200); assert.equal((await r.json()).status, "on_hold");
  } finally { ui.close(); cleanup(root); }
});

test("MCP evidence server exposes exactly the four read-only production tools and refuses without an evidence org login", async () => {
  const root = makeProject();
  const transport = new StdioClientTransport({ command: "node", args: [path.join(REPO, "bin", "sfsmiths-mcp-evidence.js")], env: { ...process.env, SFSMITHS_PROJECT_DIR: root } });
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["prod_describe", "prod_row_count", "prod_soql", "prod_tooling"]);
    for (const t of (await client.listTools()).tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is read-only`);
    // a DELETE-shaped query is refused at the parser before any org call; a SELECT fails cleanly without sf login (no crash)
    const r = await client.callTool({ name: "prod_soql", arguments: { query: "SELECT Id FROM Case LIMIT 1", purpose: "test refusal path", ticket: "DEMO-101" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /EVIDENCE REFUSED|FAILED/);
    const r2 = await client.callTool({ name: "prod_soql", arguments: { query: "SELECT Id, Description FROM Case", purpose: "test allowlist refusal" } });
    assert.equal(r2.isError, true); assert.match(r2.content[0].text, /Description|refused/i);
  } finally { await client.close().catch(() => {}); cleanup(root); }
});

test("MCP UI server exposes the fenced browser verbs and answers 'unavailable' without Playwright instead of crashing", async () => {
  const root = makeProject();
  const transport = new StdioClientTransport({ command: "node", args: [path.join(REPO, "bin", "sfsmiths-mcp-ui.js")], env: { ...process.env, SFSMITHS_PROJECT_DIR: root } });
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["ui_click", "ui_close", "ui_current", "ui_fill", "ui_goto", "ui_login", "ui_screenshot", "ui_select", "ui_text", "ui_wait_for"]);
    const cur = await client.callTool({ name: "ui_current", arguments: {} });
    assert.match(cur.content[0].text, /"open": false/);
    // production login is refused by role before any browser is needed
    const login = await client.callTool({ name: "ui_login", arguments: { org_alias: "Production" } });
    assert.equal(login.isError, true); assert.match(login.content[0].text, /REFUSED/);
    let pw = false; try { await import("playwright"); pw = true; } catch { /* not installed */ }
    if (!pw) {
      const g = await client.callTool({ name: "ui_goto", arguments: { url: "https://example.sandbox.my.salesforce.com/" } });
      assert.equal(g.isError, true); assert.match(g.content[0].text, /Playwright is not installed/);
    }
  } finally { await client.close().catch(() => {}); cleanup(root); }
});
