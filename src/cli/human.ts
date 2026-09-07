/**
 * `sfsmiths-human <verb>` — HUMAN-ONLY surface. Agents are denied this binary (settings deny + policy hook).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs, fail, say, json } from "./args.js";
import { loadConfig, tryLoadConfig, loadConfigFile, writeConfigFile, type OrgsConfig } from "../core/config.js";
import { emitEvent } from "../core/events.js";
import { loadManifest, listTickets, stageRecord, saveManifest } from "../core/manifest.js";
import { homePaths, packageRoot, projectPaths, sanitizeTicket, vaultDir } from "../core/paths.js";
import { keychainEnv, orgList } from "../core/sf.js";
import { exists, nowIso, readJsonOr } from "../core/util.js";
import { recordApproval } from "../engines/approvals.js";
import { holdTicket, resumeTicket, markDeployed, prodVerify, ticketSummary } from "../engines/lifecycle.js";
import { loadDecisions, saveDecisions, type Decision } from "../engines/baseline.js";
import { syncAll, ensureRuntimeDirs } from "../engines/sync.js";
import { doctor, formatChecks } from "../doctor/index.js";
import { learnDaily, learnSync, allLessons, decideLesson, memoryAudit, lessonFromHumanFeedback, computeRewards, type LessonType } from "../engines/learn.js";
import { readAllEvents } from "../core/events.js";
import { readAgentRuns } from "../engines/tokens.js";
import { runPipeline } from "../engines/pipeline.js";
import { askAll, applyAnswers } from "../engines/setup.js";
import { orgmapBuild } from "../engines/orgmap.js";
import { mirrorRefresh } from "../engines/mirror.js";
import { conventionsBuild } from "../engines/conventions.js";
import { goldenAdd, goldenList, goldenScore } from "../engines/golden.js";
import { runCanary } from "../privileged/index.js";
import { startUi } from "../ui/server.js";

const a = parseArgs(process.argv.slice(2));
const verb = a.positional[0];
const p = projectPaths();

function ticketArg(i = 1): string {
  const t = a.positional[i] ?? a.str("ticket");
  if (!t) fail("ticket key required");
  return sanitizeTicket(t);
}

async function main(): Promise<void> {
  switch (verb) {
    case "start": {
      const d = await doctor({ quick: true, p });
      const fails = d.checks.filter((c) => c.level === "fail");
      say(formatChecks(d.checks.filter((c) => c.level !== "ok")) || "✅ boot checks passed");
      if (fails.length && !a.bool("force")) fail(`${fails.length} boot check(s) failed — fix them or pass --force (not recommended)`);
      const mode = a.str("permission-mode") ?? "default";
      say(`\nlaunching: claude --agent conductor --permission-mode ${mode}   (in ${p.root})\n  → in the session: /ticket <KEY>\n`);
      // agents call `sfsmiths agent …` by bare name: prepend the INSTALLED launchers (~/.sfsmiths/bin) so the hooks and the
      // agents run the same copy — and the repo's own bin/ as a fallback for a fresh clone that has not run install:toolkit yet
      const sep = process.platform === "win32" ? ";" : ":";
      const PATH = [homePaths().bin, path.join(p.root, "node_modules", ".bin"), process.env.PATH ?? ""].filter(Boolean).join(sep);
      const child = spawn("claude", ["--agent", "conductor", "--permission-mode", mode, ...(a.list("claude-arg"))], { cwd: p.root, stdio: "inherit", env: { ...process.env, PATH, SFSMITHS_PROJECT_DIR: p.root } });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }
    case "approve":
    case "reject": {
      const t = ticketArg();
      const r = recordApproval({ ticket: t, stage: a.str("stage"), decision: verb === "approve" ? (a.str("edited") ? "approved_with_edits" : "approved") : "rejected", origin: "cli", answer: a.str("answer"), reason: a.str("reason"), edits: a.str("edited") }, p);
      say(`${r.approval.decision} recorded for ${t} stage ${r.approval.stage} → ${path.relative(p.root, r.file)}\nIn the conductor session run: sfsmiths agent handoff ${t}`);
      return;
    }
    case "hold": { const t = ticketArg(); holdTicket(t, a.str("reason") ?? "human hold", p); say(`${t} on hold`); return; }
    case "resume": { const t = ticketArg(); const r = await resumeTicket(t, { restartFrom: a.str("restart-from"), allowBudget: a.bool("allow-budget"), p }); say(`${t} resumed — diff ${r.diff.cls} (${r.diff.changes.join(", ") || "none"})`); for (const x of r.actions) say(`  · ${x}`); say(`next (conductor session): sfsmiths agent handoff ${t}`); return; }
    case "deployed": {
      const t = ticketArg();
      const org = a.str("org");
      if (!org) fail("--org preprod|production");
      const role = /prod(uction)?$/i.test(org) && !/pre/i.test(org) ? "production" : "preprod";
      await markDeployed(t, role, { deployId: a.str("id"), p });
      say(`${t}: ${role} deploy recorded. Next (conductor session): sfsmiths agent handoff ${t}`);
      return;
    }
    case "verify": { const t = ticketArg(); const r = await prodVerify(t, { remediation: a.bool("remediation"), p }); say(`${t}: ${r.results.filter((x) => x.pass).length}/${r.results.length} checks passed`); for (const x of r.results) say(`  ${x.pass ? "✅" : "❌"} ${x.description}: expected ${x.expected}, actual ${x.actual ?? x.note ?? "—"}`); return; }
    case "baseline": {
      if (a.positional[1] !== "decide") fail("baseline decide <KEY> --keep-dev Type:Name --take-uat Type:Name --exclude Type:Name [--all-take-uat]");
      const t = ticketArg(2);
      const d = loadDecisions(p, t);
      for (const k of a.list("keep-dev")) d[k] = "keep-dev" as Decision;
      for (const k of a.list("take-uat")) d[k] = "take-uat" as Decision;
      for (const k of a.list("exclude")) d[k] = "exclude" as Decision;
      if (a.bool("all-take-uat")) d["*"] = "take-uat";
      saveDecisions(p, t, d);
      const m = loadManifest(t, p);
      stageRecord(m, "baseline").status = "pending";
      if (m.waiting?.kind === "baseline") { m.waiting = null; m.status = "running"; }
      saveManifest(m, p);
      emitEvent({ ticket: t, type: "baseline.decision", stage: "baseline", data: { decisions: d, origin: "cli" } }, p);
      say(`decisions saved for ${t}: ${Object.entries(d).map(([k, v]) => `${v}:${k}`).join(", ")}\nnext (conductor session): sfsmiths agent handoff ${t}`);
      return;
    }
    case "sync": { const r = syncAll(p, { keychainDenies: true }); say(`agents: ${r.agents_updated.join(", ") || "no model changes"}\n.mcp.json: ${r.mcp_written ? "written" : "-"} · policy: ${r.policy_written ? "compiled" : "-"}\nskills: ${r.skills.join(", ")}`); for (const w of r.warnings) say(`⚠ ${w}`); return; }
    case "org": {
      const sub = a.positional[1];
      const cfg = loadConfig(p);
      if (sub === "list" || !sub) {
        for (const kc of ["agent", "engine"] as const) { const r = await orgList(kc); say(`${kc.toUpperCase()} keychain${kc === "engine" ? ` (${homePaths().engineHome})` : ""}:`); for (const o of r.data ?? []) say(`  ${(o.alias ?? "-").padEnd(16)} ${o.username ?? ""}  ${o.instanceUrl ?? ""}  ${o.connectedStatus ?? ""}`); if (!r.ok) say(`  (${r.error})`); }
        say(`config: ${cfg.orgs.orgs.map((o) => `${o.alias}=${o.role}/${o.keychain}`).join(", ")}`);
        return;
      }
      if (sub === "login") {
        const alias = a.str("alias"); const kc = (a.str("keychain") ?? "agent") as "agent" | "engine";
        if (!alias) fail("org login --alias X --keychain agent|engine [--role development|preprod|evidence] [--instance-url https://test.salesforce.com]");
        const org = cfg.orgs.orgs.find((o) => o.alias.toLowerCase() === alias.toLowerCase());
        if (org && org.keychain !== kc) fail(`config says ${alias} lives in the ${org.keychain} keychain — use --keychain ${org.keychain}`);
        if (kc === "engine") fs.mkdirSync(homePaths().engineHome, { recursive: true });
        const args = ["org", "login", "web", "--alias", alias];
        const url = a.str("instance-url") ?? (org?.role !== "evidence" ? "https://test.salesforce.com" : undefined);
        if (url) args.push("--instance-url", url);
        say(`sf ${args.join(" ")}   (${kc} keychain${kc === "engine" ? `, HOME=${homePaths().engineHome}` : ""})`);
        const child = spawn("sf", args, { stdio: "inherit", env: { ...process.env, ...keychainEnv(kc) } });
        child.on("exit", (code) => { if (code === 0) say(`logged in. Run: sfsmiths-human doctor`); process.exit(code ?? 0); });
        return;
      }
      if (sub === "add") {
        const alias = a.str("alias"); const role = a.str("role") as "development" | "preprod" | "evidence" | undefined; const kc = (a.str("keychain") ?? (role === "preprod" ? "engine" : "agent")) as "agent" | "engine";
        if (!alias || !role) fail("org add --alias X --role development|preprod|evidence [--keychain agent|engine] [--readonly-user u]");
        const orgs = loadConfigFile("orgs", p) as OrgsConfig;
        if (orgs.orgs.some((o) => o.alias.toLowerCase() === alias.toLowerCase())) fail(`${alias} already configured`);
        orgs.orgs.push({ alias, role, keychain: kc, write: role === "development", readonly_user: a.str("readonly-user") ?? (role === "evidence" ? "" : undefined), email_deliverability: "unknown" });
        writeConfigFile("orgs", orgs, p);
        const r = syncAll(p, { keychainDenies: true });
        say(`added ${alias} (${role}, ${kc}). Regenerated .mcp.json + policy${r.warnings.length ? `; warnings: ${r.warnings.join("; ")}` : ""}.\nNow: sfsmiths-human org login --alias ${alias} --keychain ${kc}  → sfsmiths-human doctor`);
        return;
      }
      if (sub === "remove") {
        const alias = a.str("alias"); if (!alias) fail("org remove --alias X");
        const orgs = loadConfigFile("orgs", p) as OrgsConfig;
        orgs.orgs = orgs.orgs.filter((o) => o.alias.toLowerCase() !== alias.toLowerCase());
        writeConfigFile("orgs", orgs, p); syncAll(p, { keychainDenies: true }); say(`removed ${alias} from config (sf keychain login untouched: sf org logout -o ${alias})`); return;
      }
      fail("org list|login|add|remove");
    }
    // eslint-disable-next-line no-fallthrough
    case "lessons": {
      const sub = a.positional[1] ?? "review";
      if (sub === "review" || sub === "list") {
        const ls = allLessons(p).filter((l) => (a.str("status") ? l.status === a.str("status") : l.status === "pending"));
        if (!ls.length) say("no pending lessons");
        for (const l of ls) say(`${l.id}  [${l.type}] ${l.status}  hits=${l.hits}  → ${l.agents.join(",")}\n    ${l.title}\n    ${l.body.split("\n")[0].slice(0, 140)}`);
        say(`\napprove: sfsmiths-human lessons approve <id> [--agents a4-developer,a5-qa] [--type process|org-fact|convention|reuse-hint|safety]\nreject:  sfsmiths-human lessons reject <id> --reason "..."`);
        return;
      }
      const id = a.positional[2]; if (!id) fail(`lessons ${sub} <id>`);
      const l = decideLesson(p, id, sub as "approve" | "reject" | "promote" | "retire", { reason: a.str("reason"), agents: a.list("agents").flatMap((x) => x.split(",")).filter(Boolean), type: a.str("type") as LessonType | undefined });
      const synced = learnSync(p);
      say(`${l.id} → ${l.status}. skills regenerated: ${synced.join(", ")}`);
      return;
    }
    case "feedback": { const text = a.positional.slice(1).join(" "); if (!text) fail('feedback "lesson text" [--ticket KEY] [--agents a3-architect] [--type process]'); const l = lessonFromHumanFeedback(p, text, { ticket: a.str("ticket") ? sanitizeTicket(a.str("ticket")!) : undefined, agents: a.list("agents").flatMap((x) => x.split(",")).filter(Boolean), type: a.str("type") as LessonType | undefined }); learnSync(p); say(`lesson ${l.id} approved (human feedback) and synced into skills`); return; }
    case "learn": {
      if (a.positional[1] === "sync") { say(`skills regenerated: ${learnSync(p).join(", ")}`); return; } // sync only — no digest side effects
      const r = await learnDaily(p, { sync: !a.bool("no-sync") });
      say(`learn: total ${r.rewards.total} pts · ${r.new_candidates} new candidate(s) · auto-promoted ${r.auto_promoted.length} · streaks ${r.negative_streaks.map((s) => s.agent).join(", ") || "none"}\ndigest: ${r.digest_file}\nskills: ${r.synced_skills.join(", ")}`);
      return;
    }
    case "memory": { if (a.positional[1] !== "audit") fail("memory audit"); const r = memoryAudit(p); say(`${r.findings.length} finding(s) → ${r.file}`); for (const f of r.findings.slice(0, 20)) say(`  · ${f}`); return; }
    case "rewards": {
      const cfg = loadConfig(p);
      const sum = computeRewards(readAllEvents(p), cfg);
      if (a.bool("json")) { json(sum); return; }
      say(`total ${sum.total} points`);
      say("by agent: " + Object.entries(sum.by_agent).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}`).join(" · "));
      say("by ticket: " + Object.entries(sum.by_ticket).map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}`).join(" · "));
      if (a.bool("tokens")) {
        const runs = readAgentRuns(p);
        const byAgent: Record<string, number> = {}; const byModel: Record<string, number> = {}; const byTicket: Record<string, number> = {};
        for (const r of runs) { byAgent[r.agent] = (byAgent[r.agent] ?? 0) + r.total_tokens; byModel[r.model ?? "?"] = (byModel[r.model ?? "?"] ?? 0) + r.total_tokens; if (r.ticket) byTicket[r.ticket] = (byTicket[r.ticket] ?? 0) + r.total_tokens; }
        say(`tokens by agent: ${Object.entries(byAgent).map(([k, v]) => `${k} ${v}`).join(" · ") || "none recorded"}`);
        say(`tokens by model: ${Object.entries(byModel).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
        say(`tokens by ticket: ${Object.entries(byTicket).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
      }
      return;
    }
    case "run": { const t = ticketArg(); const r = await runPipeline(t, { allowOauth: a.bool("allow-oauth"), maxLoops: a.num("max-loops"), p, log: (s) => say(`· ${s}`) }); say(`pipeline ${t}: ${r.final_status} after ${r.loops} loop(s), ${r.usd.toFixed(2)} USD — ${r.stopped_reason}`); return; }
    case "ui": { await startUi({ p, port: a.num("port"), open: !a.bool("no-open") }); return; }
    case "doctor": {
      const r = await doctor({ p1: a.bool("p1") || a.bool("all"), emailCanary: a.bool("email-canary") || a.bool("all"), hooksLatency: a.bool("hooks-latency") || a.bool("all"), fls: a.bool("fls") || a.bool("all"), p });
      if (a.bool("json")) json(r); else { say(formatChecks(r.checks)); say(r.ok ? "\n✅ no failing checks" : "\n❌ failing checks — the system will refuse to start (sfsmiths-human start)"); }
      process.exit(r.ok ? 0 : 1);
    }
    // eslint-disable-next-line no-fallthrough
    case "canary": { const alias = a.str("org") ?? loadConfig(p).orgs.orgs.find((o) => o.role === "development")!.alias; const st = await runCanary(alias, { p }); say(`canary ${st.org}: ${st.result.toUpperCase()} — ${st.detail}`); process.exit(st.result === "pass" ? 0 : 1); }
    // eslint-disable-next-line no-fallthrough
    case "init": { ensureRuntimeDirs(p); const { errors } = tryLoadConfig(p); say(`runtime dirs ready in ${p.root}. Config: ${Object.keys(errors).length ? `${Object.keys(errors).length} file(s) need attention — run sfsmiths-human setup` : "ok"}`); return; }
    case "setup": {
      const answers = await askAll({ dev: a.str("dev"), preprod: a.str("preprod"), evidence: a.str("evidence"), readonlyUser: a.str("readonly-user"), tracker: a.str("tracker") as "jira" | "file" | undefined, projectKey: a.str("project"), jiraUrl: a.str("jira-url"), emails: a.list("emails").flatMap((x) => x.split(",")).filter(Boolean), tagField: a.str("tag-field"), slack: a.bool("slack") || undefined }, a.bool("non-interactive"));
      const written = applyAnswers(answers, p);
      say(`written: ${written.join(", ")}\n\nnext:\n  1. sfsmiths-human org login --alias ${answers.dev} --keychain agent\n${answers.preprod ? `  2. sfsmiths-human org login --alias ${answers.preprod} --keychain engine\n` : ""}${answers.evidence ? `  3. sfsmiths-human org login --alias ${answers.evidence} --keychain agent   (READ-ONLY user)\n` : ""}  4. export ${loadConfig(p).safety.canary_recipient_env}=you@yourdomain  → sfsmiths-human doctor --p1 --email-canary --hooks-latency\n  5. sfsmiths-human orgmap build && sfsmiths-human mirror refresh\n  6. review docs/org-map/CONVENTIONS.md → sfsmiths-human conventions build --prefix <yourorg>\n  7. sfsmiths-human start`);
      return;
    }
    case "orgmap": { const r = await orgmapBuild({ objects: a.list("objects").flatMap((x) => x.split(",")).filter(Boolean), p, log: (s) => say(`· ${s}`) }); say(`org-map: ${r.objects.length} object page(s), ${r.dependencies} dependency edge(s), ${r.conventions_sampled} class(es) sampled → docs/org-map/`); for (const w of r.warnings) say(`⚠ ${w}`); return; }
    case "mirror": { const r = await mirrorRefresh({ p, log: (s) => say(`· ${s}`) }); say(`mirror: ${r.ok.join(", ") || "nothing fetched"}`); for (const f of r.failed) say(`❌ ${f.name}: ${f.reason}`); return; }
    case "conventions": { const r = conventionsBuild({ prefix: a.str("prefix"), p }); say(`written: ${r.written.join(", ") || "nothing"}`); for (const w of r.warnings) say(`⚠ ${w}`); if (r.written.length) say(`add the new skills to the agents' \`skills:\` lists (a2, a3, a4, a5, a6) — or run sync if already listed`); return; }
    case "golden": {
      const sub = a.positional[1];
      if (sub === "add") { const g = goldenAdd(ticketArg(2), p); say(`sealed ${g.key}: ${g.scope.length} component(s), ${g.failing_tests.length} failing test(s)`); return; }
      if (sub === "score") { const s = goldenScore(ticketArg(2), p); for (const c of s.checks) say(`${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`); process.exit(s.ok ? 0 : 1); }
      const list = goldenList(p); say(`${list.length} golden ticket(s): ${list.map((g) => g.key).join(", ") || "none — sfsmiths-human golden add <KEY> after a solved ticket"}`);
      say("replay automation (pipeline mode, API key) is Phase 3: sfsmiths-human run <KEY> --restart on a copy, then golden score <KEY>");
      return;
    }
    case "status": { const tickets = listTickets(p); if (!tickets.length) say("no tickets"); for (const t of tickets) say(ticketSummary(loadManifest(t, p))); return; }
    case "version": { say(readJsonOr<{ version?: string }>(path.join(packageRoot(), "package.json"), {}).version ?? "?"); return; }
    default:
      say(`sfsmiths-human <verb>  (human-only verbs)
  start [--permission-mode default]         launch the conductor session (boot checks first)
  approve <KEY> [--stage S] [--answer "..."] [--edited "what you changed"]
  reject <KEY> --reason "..."
  hold <KEY> --reason "..." | resume <KEY> [--restart-from stage] [--allow-budget]
  deployed <KEY> --org preprod|production [--id 0Af…]
  verify <KEY> [--remediation]
  baseline decide <KEY> --keep-dev T:N --take-uat T:N --exclude T:N [--all-take-uat]
  sync                                      config → agents/.mcp.json/policy/lessons skills
  org list | login --alias X --keychain agent|engine | add --alias X --role r | remove --alias X
  lessons review|approve|reject|promote|retire · feedback "text" · learn [--no-sync] · memory audit · rewards [--tokens]
  run <KEY> [--allow-oauth]                 pipeline mode (claude -p, API key)
  ui [--port N]                             local UI (127.0.0.1 + token)
  doctor [--p1] [--email-canary] [--hooks-latency] [--fls] [--all]
  canary [--org ALIAS] · init · setup [--non-interactive …] · orgmap [--objects Case,Account] · mirror · conventions --prefix org · golden list|add|score · status · version`);
  }
}

main().catch((e) => {
  const err = e as Error & { code?: string };
  process.stderr.write(`sfsmiths-human: ${err.message}${err.code ? ` [${err.code}]` : ""}\n`);
  process.exit(1);
});

export { exists, nowIso };
