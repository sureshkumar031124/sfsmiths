import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { makeProject, cleanup, agentCli, humanCli, write } from "./helpers.mjs";
import { projectPaths } from "../dist/core/paths.js";
import { loadConfig } from "../dist/core/config.js";
import { loadManifest } from "../dist/core/manifest.js";
import { classifyTicketDiff, openTicket, holdTicket, resumeTicket } from "../dist/engines/lifecycle.js";
import { emitEvent, readAllEvents } from "../dist/core/events.js";
import { computeRewards, learnSync, allLessons, lessonFromHumanFeedback, decideLesson, learnDaily, mergeCoachConfirmations } from "../dist/engines/learn.js";
import { parseMarkdownTicket, FileAdapter } from "../dist/engines/tracker/file.js";
import { doctor } from "../dist/doctor/index.js";

const snap = (over = {}) => ({ key: "DEMO-101", tracker: "file", fetched_at: "x", title: "t", description: "d", status: "Open", labels: [], components: ["Case"], comments: [], attachments: [], links: [], raw_hash: "", ...over });

test("hold/resume classification of tracker changes", () => {
  assert.equal(classifyTicketDiff(snap(), snap()).cls, "NONE");
  assert.equal(classifyTicketDiff(snap(), snap({ comments: [{ id: "1", body: "hi", created: "x" }] })).cls, "COMMENTS_ONLY");
  assert.equal(classifyTicketDiff(snap(), snap({ description: "changed" })).cls, "DESCRIPTION_AC");
  assert.equal(classifyTicketDiff(snap(), snap({ acceptance_criteria: "new AC" })).cls, "DESCRIPTION_AC");
  assert.equal(classifyTicketDiff(snap(), snap({ components: ["Case", "Account"] })).cls, "SCOPE_CHANGED");
  assert.equal(classifyTicketDiff(snap(), snap({ status: "Done" })).cls, "CANCELLED_DONE");
  assert.equal(classifyTicketDiff(snap({ status: "Closed" }), snap({ status: "Closed" })).cls, "NONE", "already closed before → not a new cancellation");
});

test("file tracker adapter: frontmatter + heading formats, search, probe hash changes with content", async () => {
  const root = makeProject();
  try {
    const a = new FileAdapter(path.join(root, "inbox"));
    const s = await a.fetch("DEMO-101");
    assert.match(s.title, /lose their owner/);
    assert.equal(s.issue_type, "Bug");
    assert.ok(s.acceptance_criteria && s.acceptance_criteria.includes("regional escalation queue"));
    const b = parseMarkdownTicket("DEMO-2", "# Flow sends duplicate emails\nstatus: Open\npriority: Low\nlabels: flow, email\n\nBody text here\n\n## Comments\n- Priya (2026-09-01): still happening\n");
    assert.equal(b.title, "Flow sends duplicate emails"); assert.deepEqual(b.labels, ["flow", "email"]); assert.equal(b.comments.length, 1); assert.equal(b.comments[0].author, "Priya");
    const hits = await a.search("owner priority critical");
    assert.ok(hits.length >= 1 && hits[0].key === "DEMO-101");
    const h1 = (await a.probe("DEMO-101")).raw_hash;
    fs.appendFileSync(path.join(root, "inbox", "DEMO-101.md"), "\nOne more line of description.\n");
    const h2 = (await a.probe("DEMO-101")).raw_hash;
    assert.notEqual(h1, h2);
    await assert.rejects(() => a.fetch("DEMO-404"), /No ticket file/);
  } finally { cleanup(root); }
});

test("openTicket → vault with envelope-wrapped ticket.md, manifest, prior-art index; hold; resume re-checks the tracker", async () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const r = await openTicket("DEMO-101", { p, sessionId: "s1" });
    assert.equal(r.created, true);
    const vault = path.join(root, "work", "DEMO-101");
    const md = fs.readFileSync(path.join(vault, "ticket.md"), "utf8");
    assert.match(md, /<untrusted source="/, "ticket text is envelope-wrapped (P7)");
    assert.ok(fs.existsSync(path.join(vault, "manifest.yaml")));
    assert.ok(fs.existsSync(path.join(vault, ".state.json")));
    assert.ok(fs.existsSync(path.join(vault, "00c-prior-art.index.json")), "prior-art index written by the toolkit");
    assert.ok(fs.existsSync(path.join(root, "work", ".active-ticket")));
    // second open continues
    const r2 = await openTicket("DEMO-101", { p });
    assert.equal(r2.created, false);
    // hold
    const held = holdTicket("DEMO-101", "waiting for reporter", p);
    assert.equal(held.status, "on_hold");
    // change the tracker text, resume → DESCRIPTION_AC classification + ticket-diff.md
    fs.appendFileSync(path.join(root, "inbox", "DEMO-101.md"), "\nAlso affects Email-to-Case origin.\n");
    const res = await resumeTicket("DEMO-101", { p, skipBaselineCheck: true });
    assert.equal(res.diff.cls, "DESCRIPTION_AC");
    assert.ok(fs.existsSync(path.join(vault, "ticket-diff.md")));
    assert.equal(loadManifest("DEMO-101", p).status, "running");
    const ev = readAllEvents(p).map((e) => e.type);
    assert.ok(ev.includes("ticket.opened") && ev.includes("ticket.held") && ev.includes("ticket.resumed") && ev.includes("tracker.changed"));
  } finally { cleanup(root); }
});

test("agent CLI end-to-end (offline): open → handoff prints a SPAWN prompt with the rendered template; status works", () => {
  const root = makeProject();
  try {
    let r = agentCli(root, ["open", "DEMO-101"]);
    assert.equal(r.code, 0, r.stderr);
    r = agentCli(root, ["handoff", "DEMO-101"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ACTION: SPAWN subagent "a1-intake" for stage "prior_art"/);
    assert.match(r.stdout, /--- PROMPT ---/);
    assert.match(r.stdout, /Ticket \*\*DEMO-101\*\*/, "template rendered with the ticket key");
    assert.ok(!r.stdout.includes("{{"), "no unfilled placeholders");
    r = agentCli(root, ["status", "DEMO-101", "--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.stage ?? j.manifest?.stage ?? j.ticket?.stage ?? "prior_art", "prior_art");
    // human-only verb through the agent binary does not exist
    r = agentCli(root, ["approve", "DEMO-101"]);
    assert.notEqual(r.code, 0);
  } finally { cleanup(root); }
});

test("rewards from events, human feedback → approved lesson → skills regenerated, coach confirmation merge", async () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const cfg = loadConfig(p, { fresh: true });
    await openTicket("DEMO-101", { p });
    emitEvent({ ticket: "DEMO-101", type: "gate.passed", stage: "plan", agent: "a3-architect", data: { gate: "plan-lint", first_try: true } }, p);
    emitEvent({ ticket: "DEMO-101", type: "gate.failed", stage: "plan", agent: "a3-architect", data: { gate: "plan-lint", reason: "unresolved Region__c" } }, p);
    emitEvent({ ticket: "DEMO-101", type: "gate.failed", stage: "plan", agent: "a3-architect", data: { gate: "plan-lint", reason: "unresolved Region__c" } }, p);
    emitEvent({ ticket: "DEMO-101", type: "email_guard.blocked", stage: "repro", agent: "a2-repro", data: { why: "x" } }, p);
    emitEvent({ ticket: "DEMO-101", type: "policy.denied", stage: "develop", agent: "a4-developer", data: { rule: "R7" } }, p);
    const rw = computeRewards(readAllEvents(p), cfg);
    assert.ok(rw.by_agent["a2-repro"] < 0, "email guard block costs points");
    assert.ok(rw.by_agent["a4-developer"] < 0, "policy denial costs points");
    assert.ok(typeof rw.total === "number");
    // human feedback → approved lesson for a3
    const l = lessonFromHumanFeedback(p, "Before planning a Flow change, retrieve its current version — plan-lint failed on stale field names.", { ticket: "DEMO-101", agents: ["a3-architect"], type: "process" });
    assert.equal(l.status, "approved");
    const synced = learnSync(p);
    assert.ok(synced.some((s) => s.startsWith("lessons-a3-architect (1)")), synced.join(","));
    const skill = fs.readFileSync(path.join(root, ".claude/skills/lessons-a3-architect/SKILL.md"), "utf8");
    assert.match(skill, /retrieve its current version/);
    assert.match(fs.readFileSync(path.join(root, ".claude/skills/lessons-a4-developer/SKILL.md"), "utf8"), /No approved lessons yet/);
    // coach confirmation file → merged by the daily learn run
    write(path.join(root, "knowledge/lessons/PENDING", `CONFIRM-${l.id}-2026-09-06.md`), `---\nevidence:\n  - events:DEMO-101:2026-09-06T10:00:00Z:gate.failed\n  - vault:DEMO-101:notes.md\n---\nconfirmed again\n`);
    const merged = mergeCoachConfirmations(p);
    assert.deepEqual(merged, [l.id]);
    const after = allLessons(p).find((x) => x.id === l.id);
    assert.equal(after.confirmations, 1);
    assert.ok(after.evidence.some((e) => e.startsWith("events:")) && !after.evidence.some((e) => e.startsWith("vault:")), "only event/reward/human refs merged (P6)");
    // daily learn produces candidates from the repeated plan-lint failures and a digest
    const day = await learnDaily(p, { sync: true });
    assert.ok(fs.existsSync(path.join(root, day.digest_file)));
    const pending = allLessons(p).filter((x) => x.status === "pending");
    assert.ok(pending.some((x) => /plan-lint failed 2/.test(x.title)), pending.map((x) => x.title).join(" | "));
    // reject one with a reason
    const rej = decideLesson(p, pending[0].id, "reject", { reason: "not actionable" });
    assert.equal(rej.status, "rejected");
  } finally { cleanup(root); }
});

test("doctor runs offline (quick) and reports config/tools/hooks without crashing; human CLI status/version work", async () => {
  const root = makeProject();
  try {
    const p = projectPaths(root);
    const d = await doctor({ p, quick: true });
    assert.ok(d.checks.length >= 8);
    assert.ok(d.checks.some((c) => c.id === "1" || /config/i.test(c.title)));
    let r = humanCli(root, ["version"]);
    assert.equal(r.code, 0); assert.match(r.stdout, /\d+\.\d+\.\d+/);
    r = humanCli(root, ["status"]);
    assert.equal(r.code, 0, r.stderr);
    r = humanCli(root, ["sync"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(root, ".mcp.json")), ".mcp.json generated");
    const mcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers["sf-dev"].args.includes("DevSandbox"), "sf-dev bound to the development alias only");
    assert.ok(!JSON.stringify(mcp).includes("PartialUAT"), "no preprod MCP server");
    assert.ok(fs.existsSync(path.join(root, ".sfsmiths/policy.compiled.json")));
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
    assert.ok(settings.permissions.deny.some((x) => x.includes("-o PartialUAT")), "alias denies synced into settings");
  } finally { cleanup(root); }
});
