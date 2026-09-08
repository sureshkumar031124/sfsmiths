/**
 * `sfsmiths agent <verb>` — the AGENT-SAFE surface. Nothing here approves, deploys to preprod/production,
 * marks deploys, syncs config or touches lessons/learning decisions. Those live in sfsmiths-human.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, fail, say, json } from "./args.js";
import { loadConfig } from "../core/config.js";
import { emitEvent } from "../core/events.js";
import { loadManifest, saveManifest, listTickets, latestGates, stageRecord } from "../core/manifest.js";
import { projectPaths, vaultDir, sanitizeTicket, packageRoot } from "../core/paths.js";
import { decideHandoff, STAGE_BY_ID, STAGES, AGENT_WAIT_CAP, type HandoffAction } from "../core/state-machine.js";
import { exists, readTextOr, readJsonOr, writeJsonAtomic, nowIso, tsCompact, appendLine } from "../core/util.js";
import { buildContext, runGate, runStageGates, formatOutcomes, gateNames } from "../gates/registry.js";
import { openTicket, prodVerify, ticketSummary, configSnapshotForPrompt } from "../engines/lifecycle.js";
import { runBaseline } from "../engines/baseline.js";
import { buildPriorArt, rebuildTicketIndex } from "../engines/priorart.js";
import { evidenceQuery, evidenceTooling, evidenceDescribe } from "../engines/evidence/query.js";
import { privilegedTest, uatValidate, deployDev, privilegedRetrieve, apexRunDev, runAnalyzer, cacheFreshen, runCanary, canaryFresh } from "../privileged/index.js";
import { ticketRetro } from "../engines/learn.js";
import { notify } from "../engines/notify.js";

const argv = process.argv.slice(2);
if (argv[0] === "agent") argv.shift(); // allow both `sfsmiths agent x` and `sfsmiths x`
const a = parseArgs(argv);
const verb = a.positional[0];
const p = projectPaths();

function ticketArg(i = 1): string {
  const t = a.positional[i] ?? a.str("ticket");
  if (!t) fail("ticket key required (positional or --ticket)");
  return sanitizeTicket(t);
}

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? "");
}

function buildPrompt(ticket: string, action: Extract<HandoffAction, { action: "SPAWN" }>): string {
  const m = loadManifest(ticket, p);
  const cfg = loadConfig(p);
  const vault = path.relative(p.root, vaultDir(p, ticket));
  const stage = STAGE_BY_ID[action.stage];
  // stage-specific template wins (a1-intake.prior_art.md, a5-qa.qa_uat.md), then the agent's generic one; project templates/ before the package's
  const tplPath = [
    path.join(p.templates, "prompts", `${action.agent}.${action.stage}.md`), path.join(p.templates, "prompts", `${action.agent}.md`),
    path.join(packageRoot(), "templates", "prompts", `${action.agent}.${action.stage}.md`), path.join(packageRoot(), "templates", "prompts", `${action.agent}.md`),
  ].find(exists);
  const note = stageRecord(m, action.stage).note ?? "";
  const rejection = [...m.approvals].reverse().find((x) => x.stage === action.stage && x.decision === "rejected");
  const vars = {
    TICKET: ticket, VAULT: vault, STAGE: action.stage, STAGE_TITLE: stage?.title ?? action.stage, AGENT: action.agent,
    ATTEMPT: String(action.attempt), TIER: m.tier, TITLE: m.title ?? "", NOTE: note, REJECTION: rejection?.reason ?? "",
    OUTPUT: stage?.output ?? "", GATES: (stage?.gates ?? []).join(", "), CONFIG: configSnapshotForPrompt(cfg),
    FACTS: readTextOr(path.join(vaultDir(p, ticket), "facts.md"), "").split("\n").filter((l) => l.startsWith("- ")).slice(-10).join("\n"),
    TAG_FIELD: cfg.safety.test_tag_field, TAG: `${cfg.safety.test_tag_prefix} ${ticket}]`, ALLOWED_EMAILS: cfg.safety.allowed_test_emails.join(", "),
  };
  const tpl = tplPath ? fs.readFileSync(tplPath, "utf8") : `You are ${action.agent} working on ticket {{TICKET}} (stage {{STAGE}}, attempt {{ATTEMPT}}).\nVault: {{VAULT}}. Read manifest.yaml, ticket.md and the previous stage outputs there. Produce {{OUTPUT}} (+ its .json contract). Gates: {{GATES}}.\n{{NOTE}}`;
  return fill(tpl, vars);
}

function printDecision(ticket: string, d: HandoffAction, notes: string[]): void {
  const m = loadManifest(ticket, p);
  const head = `SFSMITHS HANDOFF · ${ticket} · tier ${m.tier} · stage ${m.stage} · status ${m.status}`;
  if (a.bool("json")) { json({ ticket, decision: d, notes, stage: m.stage, status: m.status }); return; }
  say(head);
  say("=".repeat(head.length));
  for (const n of notes) say(`note: ${n}`);
  switch (d.action) {
    case "SPAWN":
      say(`ACTION: SPAWN subagent "${d.agent}" for stage "${d.stage}" (attempt ${d.attempt}). Allowed now: ${d.allowed_agents.join(", ")}`);
      { const support = d.allowed_agents.filter((x) => x !== d.agent); if (support.length) say(`Support agents allowed during this stage (only when the specialist asks for it, via \`sfsmiths agent handoff ${ticket} --support <name>\`): ${support.join(", ")}`); }
      say(`Use the Agent tool with subagent_type="${d.agent}" and EXACTLY this prompt:`);
      say("--- PROMPT ---");
      say(buildPrompt(ticket, d));
      say("--- END PROMPT ---");
      say(`After it returns, run: sfsmiths agent handoff ${ticket}`);
      break;
    case "RUN_TOOLKIT": say(`ACTION: toolkit step "${d.verb}" (already executed). Run: sfsmiths agent handoff ${ticket}`); break;
    case "WAIT_AGENT":
      say(`ACTION: WAIT_AGENT — "${d.agent}" is still working on stage "${d.stage}" (started ${d.since ?? "?"}, wait ${d.waits}/${AGENT_WAIT_CAP}).`);
      say(`Do NOT spawn it again, do NOT bounce the stage, do NOT tell the human it failed.`);
      say(`If you called the Agent tool and are waiting on its result: keep waiting — the result comes back to you.`);
      say(`If you called it in the background (not allowed — the agent-gate hook denies that): wait for its task notification, then run: sfsmiths agent handoff ${ticket}`);
      break;
    case "WAIT_HUMAN":
      say(`ACTION: WAIT_HUMAN (${d.kind}) at stage "${d.stage}".`);
      say(`Tell the human exactly this, then STOP (do not spawn anything):`);
      say(`  ${d.prompt}`);
      break;
    case "HOLD": say(`ACTION: HOLD — ${d.reason}. Nothing to do until /resume ${ticket}.`); break;
    case "PARKED": say(`ACTION: PARKED — ${d.reason}. Tell the human; stop.`); break;
    case "ESCALATED": say(`ACTION: ESCALATED at "${d.stage}" — ${d.reason}. Tell the human what happened (honest, with evidence paths); stop.`); break;
    case "FAILED": say(`ACTION: FAILED — ${d.reason}. Tell the human; stop.`); break;
    case "DONE": say(`ACTION: DONE — ticket ${ticket} finished. Tell the human: deploy brief + comms drafts are in ${path.relative(p.root, vaultDir(p, ticket))}/.`); break;
  }
}

/** `handoff <KEY> --support a8-ui`: render the prompt for a SUPPORT agent (allowed alongside the stage agent, e.g. a8-ui during repro/qa). */
function supportHandoff(ticket: string, support: string): void {
  const m = loadManifest(ticket, p);
  if (m.status !== "running") fail(`${ticket} is ${m.status} — no support agent may run now`);
  if (!m.next_allowed_stages.includes(support)) fail(`"${support}" is not allowed during stage "${m.stage}" (allowed: ${m.next_allowed_stages.join(", ") || "none"})`);
  const req = path.join(vaultDir(p, ticket), "ui-request.md");
  if (support === "a8-ui" && !exists(req)) fail(`work/${ticket}/ui-request.md is missing — the specialist must write what to observe before a8-ui is spawned`);
  const prompt = buildPrompt(ticket, { action: "SPAWN", stage: m.stage, agent: support, allowed_agents: m.next_allowed_stages, attempt: 1 });
  emitEvent({ ticket, type: "stage.started", stage: m.stage, agent: support, data: { support: true } }, p);
  say(`SFSMITHS SUPPORT HANDOFF · ${ticket} · stage ${m.stage}`);
  say(`ACTION: SPAWN support agent "${support}" (the stage agent "${STAGE_BY_ID[m.stage]?.agent}" stays the owner of this stage).`);
  say(`Use the Agent tool with subagent_type="${support}" and EXACTLY this prompt:`);
  say("--- PROMPT ---"); say(prompt); say("--- END PROMPT ---");
  say(`After it returns, run: sfsmiths agent handoff ${ticket}   (the stage agent is re-spawned with the support report available)`);
}

async function handoff(ticket: string): Promise<void> {
  if (a.str("support")) return supportHandoff(ticket, a.str("support")!);
  const cfg = loadConfig(p);
  let m = loadManifest(ticket, p);
  let notes: string[] = [];
  let decision: HandoffAction | undefined;
  for (let i = 0; i < 6; i++) {
    const bouncesBefore = m.bounces.length;
    const r = decideHandoff(m, cfg);
    saveManifest(r.manifest, p);
    notes.push(...r.notes);
    decision = r.decision;
    for (const b of r.manifest.bounces.slice(bouncesBefore)) emitEvent({ ticket, type: "stage.bounced", stage: b.from, data: { from: b.from, to: b.to, reason: b.reason } }, p);
    if (decision.action === "ESCALATED") {
      // honest escalation = evidence-backed after the allowed tries (repro: 2); weak = no evidence files
      const evDir = path.join(vaultDir(p, ticket), "evidence");
      const evidenceFiles = exists(evDir) ? fs.readdirSync(evDir).length : 0;
      const attempts = r.manifest.stages[decision.stage]?.attempts ?? 0;
      const honest = evidenceFiles > 0 && attempts >= 2;
      emitEvent({ ticket, type: honest ? "escalation.honest" : "escalation.weak", stage: decision.stage, agent: STAGE_BY_ID[decision.stage]?.agent, data: { attempts, evidence_files: evidenceFiles, reason: decision.reason } }, p);
    }
    if (decision.action === "SPAWN") {
      emitEvent({ ticket, type: "stage.started", stage: decision.stage, agent: decision.agent, data: { attempt: decision.attempt } }, p);
      break;
    }
    if (decision.action === "WAIT_HUMAN") {
      await notify(cfg, decision.kind === "deploy" ? "ready_for_deploy" : "gate_manual", `${ticket}: ${decision.prompt}`);
      break;
    }
    // D-093: the stage agent has not reported back — no notification, no bounce, nothing to do but wait
    if (decision.action === "WAIT_AGENT") {
      emitEvent({ ticket, type: "stage.waiting_agent", stage: decision.stage, agent: decision.agent, data: { waits: decision.waits, since: decision.since } }, p);
      break;
    }
    if (decision.action === "ESCALATED") { emitEvent({ ticket, type: "ticket.escalated", stage: decision.stage, data: { reason: decision.reason } }, p); await notify(cfg, "escalation", `${ticket}: ${decision.reason}`); break; }
    if (decision.action === "PARKED") { emitEvent({ ticket, type: "ticket.parked", stage: m.stage, data: { reason: decision.reason } }, p); await notify(cfg, "budget", `${ticket}: ${decision.reason}`); break; }
    if (decision.action === "DONE") {
      emitEvent({ ticket, type: "ticket.done", stage: "done", data: {} }, p);
      try { const f = path.join(p.work, ".active-ticket"); if (exists(f) && fs.readFileSync(f, "utf8").trim() === ticket) fs.unlinkSync(f); } catch { /* ignore */ }
      break;
    }
    if (decision.action === "RUN_TOOLKIT") {
      m = loadManifest(ticket, p);
      await runToolkitStage(ticket, decision.verb, notes);
      m = loadManifest(ticket, p);
      continue;
    }
    break;
  }
  if (decision) printDecision(ticket, decision, notes);
}

async function runToolkitStage(ticket: string, verb: string, notes: string[]): Promise<void> {
  const m = loadManifest(ticket, p);
  const stage = m.stage;
  const rec = stageRecord(m, stage);
  try {
    if (verb === "prod-verify") { const r = await prodVerify(ticket, { p }); notes.push(`prod verify: ${r.results.filter((x) => x.pass).length}/${r.results.length} checks passed`); return; }
    if (verb === "learn-digest") { const r = await ticketRetro(ticket, p); notes.push(`retro: ${r.rewards.total} points, ${r.candidates.length} lesson candidate(s)`); }
    const m2 = loadManifest(ticket, p);
    const r2 = stageRecord(m2, stage);
    r2.status = "done";
    r2.ended_at = nowIso();
    saveManifest(m2, p);
  } catch (e) {
    rec.status = "failed";
    rec.note = (e as Error).message;
    saveManifest(m, p);
    notes.push(`toolkit stage ${stage} failed: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  switch (verb) {
    case "open": {
      const t = ticketArg();
      const r = await openTicket(t, { restart: a.bool("restart"), p, sessionId: process.env.CLAUDE_SESSION_ID });
      say(`${r.created ? "opened" : "continuing"} ${r.manifest.ticket} — "${r.ticket.title}" (${r.ticket.tracker})`);
      for (const n of r.notes) say(`note: ${n}`);
      say(`vault: ${path.relative(p.root, vaultDir(p, t))}  → next: sfsmiths agent handoff ${t}`);
      return;
    }
    case "handoff": return handoff(ticketArg());
    case "status": {
      const t = a.positional[1];
      const tickets = t ? [sanitizeTicket(t)] : listTickets(p);
      if (a.bool("json")) { json(tickets.map((k) => loadManifest(k, p))); return; }
      if (!tickets.length) say("no tickets yet — /ticket <KEY>");
      for (const k of tickets) {
        const m = loadManifest(k, p);
        say(ticketSummary(m));
        if (t) {
          for (const s of STAGES) { const r = m.stages[s.id]; if (r) say(`  ${s.id.padEnd(12)} ${r.status.padEnd(8)} attempts=${r.attempts} ${Object.values(latestGates(m, s.id)).map((g) => `${g.name}=${g.status}`).join(" ")}`); }
          if (m.waiting) say(`  waiting: ${m.waiting.prompt}`);
        }
      }
      return;
    }
    case "context": {
      const t = ticketArg();
      const m = loadManifest(t, p);
      say(ticketSummary(m));
      const vault = vaultDir(p, t);
      for (const f of fs.readdirSync(vault).sort()) { const st = fs.statSync(path.join(vault, f)); say(`  ${st.isDirectory() ? "d " : "  "}${f}${st.isFile() ? ` (${st.size} B)` : ""}`); }
      return;
    }
    case "gate": {
      const name = a.positional[1];
      if (!name) fail(`gate name required. Known: ${gateNames().join(", ")}`);
      const t = ticketArg(2);
      const stage = a.str("stage") ?? loadManifest(t, p).stage;
      const opts: Record<string, string> = {};
      for (const k of ["scope", "phase"]) { const v = a.str(k); if (v) opts[k] = v; }
      const ctx = buildContext(t, stage, opts, p);
      // agent self-checks are advisory: no manifest/validations write, no reward events (the SubagentStop run is the one that counts)
      const o = await runGate(name, ctx, { persist: a.bool("persist") });
      say(formatOutcomes([o]));
      process.exit(o.status === "passed" ? 0 : o.status === "failed" ? 1 : 2);
    }
    // eslint-disable-next-line no-fallthrough
    case "gates": {
      const t = ticketArg();
      const stage = a.str("stage") ?? loadManifest(t, p).stage;
      const r = await runStageGates(t, stage, {}, p, { persist: a.bool("persist") }); // advisory unless --persist
      say(formatOutcomes(r.outcomes));
      process.exit(r.ok ? 0 : 1);
    }
    // eslint-disable-next-line no-fallthrough
    case "scope": {
      // sfsmiths agent scope set <KEY> --components "ApexClass:X,Flow:Y" --objects Case,Account
      const t = ticketArg(2);
      const comps = a.list("components").flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean);
      const objs = a.list("objects").flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean);
      const bad = comps.filter((c) => !/^[A-Za-z]+:[A-Za-z0-9_.]+$/.test(c));
      if (bad.length) fail(`components must be Type:Name — bad: ${bad.join(", ")}`);
      writeJsonAtomic(path.join(vaultDir(p, t), "scope.json"), { components: comps, objects: objs, source: "intake", at: nowIso() });
      say(`scope.json written: ${comps.length} component(s), ${objs.length} object(s)`);
      return;
    }
    case "baseline": {
      const t = ticketArg();
      const rep = await runBaseline({ mode: a.bool("check") ? "check" : "full", ticket: t, p, log: (s) => say(`· ${s}`) });
      say(rep.stopped ? `STOPPED: ${rep.stop_reason}` : `baseline ok: ${rep.components.length} component(s), ${rep.components.filter((c) => c.action.startsWith("taken")).length} taken from preprod, ${rep.excluded.length} excluded`);
      if (a.bool("json")) json(rep);
      return;
    }
    case "prior-art": {
      const t = ticketArg();
      const snap = readJsonOr(path.join(vaultDir(p, t), "ticket.json"), undefined as never);
      if (!snap) fail("no ticket.json — run `sfsmiths agent open` first");
      if (a.bool("rebuild-index")) rebuildTicketIndex(p);
      const r = await buildPriorArt(t, { p, cfg: loadConfig(p), snapshot: snap });
      say(`prior art for ${t}: ${r.related.length} related vault(s), ${r.tracker_hits.length} tracker hit(s), ${r.history.length} git commit(s), ${r.lessons.length} lesson(s) → ${path.relative(p.root, vaultDir(p, t))}/00c-prior-art.index.json`);
      for (const w of r.warnings) say(`⚠ ${w}`);
      return;
    }
    case "evidence": {
      const sub = a.positional[1];
      const cfg = loadConfig(p);
      const t = a.str("ticket") ? sanitizeTicket(a.str("ticket")!) : undefined;
      const purpose = a.str("purpose") ?? "evidence";
      if (sub === "soql") { const r = await evidenceQuery(a.positional.slice(2).join(" "), { cfg, p, purpose, ticket: t }); json({ totalSize: r.totalSize, aggregate: r.aggregate, records: r.records, truncated: r.truncated, file: r.file, masked_fields: r.masked_fields }); return; }
      if (sub === "tooling") { const r = await evidenceTooling(a.positional.slice(2).join(" "), { cfg, p, purpose, ticket: t }); json({ totalSize: r.totalSize, records: r.records, truncated: r.truncated, file: r.file }); return; }
      if (sub === "describe") { const r = await evidenceDescribe(a.positional[2], { cfg, p }); json(r); return; }
      if (sub === "count") { const where = a.str("where"); const r = await evidenceQuery(`SELECT COUNT() FROM ${a.positional[2]}${where ? ` WHERE ${where}` : ""}`, { cfg, p, purpose: `count-${purpose}`, ticket: t }); json({ count: r.totalSize }); return; }
      fail("evidence soql <query> | tooling <query> | describe <Object> | count <Object> [--where ...]  (--ticket KEY --purpose why)");
    }
    // eslint-disable-next-line no-fallthrough
    case "privileged": {
      const sub = a.positional[1];
      if (sub === "test") { const t = ticketArg(2); const phase = (a.str("phase") ?? "dev") as "repro" | "dev" | "uat"; const r = await privilegedTest({ ticket: t, phase, classNames: a.list("class"), tests: a.list("test"), p }); say(`tests (${phase} on ${r.org}): ${r.apex?.summary?.outcome ?? "n/a"} — ${r.apex?.summary?.passing ?? 0}/${r.apex?.summary?.testsRan ?? 0} passing; ${r.soql_assertions?.filter((x) => x.pass).length ?? 0}/${r.soql_assertions?.length ?? 0} SOQL assertions; ${r.flow_tests?.length ?? 0} flow test(s) → validations/tests-${phase}.json`); for (const f of r.apex?.tests?.filter((x) => x.Outcome !== "Pass") ?? []) say(`  ✗ ${f.ApexClass?.Name}.${f.MethodName}: ${f.Message ?? f.Outcome}`); return; }
      if (sub === "uat-validate") { const t = ticketArg(2); const r = await uatValidate(t, p) as { status?: string; numberComponentErrors?: number; numberTestErrors?: number; _error?: string }; say(`preprod validate-only: ${r.status} (component errors ${r.numberComponentErrors ?? 0}, test errors ${r.numberTestErrors ?? 0})${r._error ? ` — ${r._error}` : ""} → validations/uat-validate.json`); return; }
      if (sub === "deploy-dev") { const t = ticketArg(2); const r = await deployDev(t, p) as { status?: string; numberComponentErrors?: number; id?: string; _error?: string; _components?: string[] }; say(`development deploy ${r.id ?? ""}: ${r.status} (${r._components?.length ?? 0} component(s), errors ${r.numberComponentErrors ?? 0})${r._error ? ` — ${r._error}` : ""} → validations/deploy-dev.json`); return; }
      if (sub === "retrieve") { const which = (a.str("org") ?? "uat") as "dev" | "uat"; const out = a.str("out") ?? path.join(p.baseline, "manual", tsCompact()); await privilegedRetrieve(which, a.list("metadata"), out, p); say(`retrieved to ${out}`); return; }
      if (sub === "apex-run") { const t = ticketArg(2); const file = a.str("file"); if (!file) fail("--file <script.apex> required"); const r = await apexRunDev(t, file, p); json(r); return; }
      fail("privileged test|uat-validate|deploy-dev|retrieve|apex-run");
    }
    // eslint-disable-next-line no-fallthrough
    case "canary": {
      const alias = a.str("org") ?? loadConfig(p).orgs.orgs.find((o) => o.role === "development")!.alias;
      if (a.bool("check")) { const c = canaryFresh(loadConfig(p), p, alias); say(`${c.fresh ? "FRESH" : "NOT FRESH"}: ${c.reason}`); process.exit(c.fresh ? 0 : 1); }
      const st = await runCanary(alias, { p });
      say(`canary ${st.org}: ${st.result.toUpperCase()} — ${st.detail}`);
      process.exit(st.result === "pass" ? 0 : 1);
    }
    // eslint-disable-next-line no-fallthrough
    case "analyze": { const t = ticketArg(); const r = await runAnalyzer(t, p, a.num("threshold", 3)); say(r.available ? `analyzer: ${r.violations.length} finding(s), ${r.violations.filter((v) => v.severity <= r.threshold).length} at/below severity ${r.threshold} → validations/analyzer.json` : `analyzer unavailable: ${r.reason}`); return; }
    case "cache": {
      if (a.positional[1] !== "freshen") fail("cache freshen [KEY | --ticket KEY] [--objects Case,Account] [--types ApexClass,Flow]");
      const ticketOpt = a.str("ticket") ?? (a.positional[2] ? sanitizeTicket(a.positional[2]) : undefined);
      const r = await cacheFreshen({ objects: a.list("objects").flatMap((x) => x.split(",")), types: a.list("types").flatMap((x) => x.split(",")).filter(Boolean).length ? a.list("types").flatMap((x) => x.split(",")) : undefined, ticket: ticketOpt, p });
      say(`cache: ${r.objects.length} object describe(s), ${r.types.length} metadata type list(s)${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`);
      return;
    }
    case "feedback-note": {
      const t = ticketArg();
      const text = a.positional.slice(2).join(" ");
      if (!text) fail("text required");
      appendLine(path.join(vaultDir(p, t), "agent-notes.md"), `- ${nowIso()} [${process.env.CLAUDE_AGENT_TYPE ?? "agent"}] ${text.replace(/\n/g, " ")}`);
      say("noted (agent-notes.md — unverified until the coach reviews it)");
      return;
    }
    case "learn-digest": { const t = ticketArg(); const r = await ticketRetro(t, p); say(`retro for ${t}: ${r.rewards.total} points; ${r.candidates.length} lesson candidate(s) → 09-retro.md`); return; }
    case "help":
    default:
      if (verb) process.exitCode = 1; // unknown verb (e.g. a human-only one) → non-zero so callers notice
      say(`sfsmiths agent <verb>  (agent-safe verbs)
  open <KEY> [--restart]              open/continue a ticket vault (tracker read-only)
  handoff <KEY> [--json]              what happens next — follow it exactly
  status [KEY] [--json]               ticket state
  context <KEY>                       vault file list
  scope set <KEY> --components "Type:Name,..." --objects Case,...
  baseline <KEY> [--check]            preprod → dev baseline sync (3-way)
  prior-art <KEY> [--rebuild-index]   related tickets / history / lessons index
  gate <name> <KEY> [--stage S] [--scope tests] [--phase repro|dev|uat]
  gates <KEY> [--stage S]             run all gates of a stage
  evidence soql|tooling|describe|count …  --ticket KEY --purpose why   (masked production reads)
  privileged test <KEY> --phase repro|dev|uat [--class X] | uat-validate <KEY> | deploy-dev <KEY> | retrieve --org uat --metadata T:N --out dir | apex-run <KEY> --file x.apex
  canary [--org ALIAS] [--check]      email deliverability probe (must PASS before creating data)
  analyze <KEY> [--threshold 3]       Code Analyzer on changed files
  cache freshen [--ticket KEY] [--objects ...] [--types ...]   oracle caches for plan-lint/semantic-check
  feedback-note <KEY> "text"          leave an unverified note for the coach
  learn-digest <KEY>                  rewards + lesson candidates for this ticket`);
  }
}

main().catch((e) => {
  const err = e as Error & { code?: string };
  process.stderr.write(`sfsmiths: ${err.message}${err.code ? ` [${err.code}]` : ""}\n`);
  process.exit(1);
});
