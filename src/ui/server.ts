/**
 * ui/server.ts — the local SFsmiths UI (human-only surface).
 *
 * Security model (Part 11 §16):
 *   - binds 127.0.0.1 only (never 0.0.0.0); port random unless --port
 *   - a random bearer token is minted per start and passed to the browser in the URL fragment;
 *     every /api call must carry it in `X-SFsmiths-Token` (fragments never leave the browser, never hit logs)
 *   - Host and Origin are checked on every request (DNS-rebinding / cross-site defence)
 *   - the UI is an EDITOR, not a source of truth: it only writes config/*.yaml (validated by schema),
 *     approvals, lesson decisions and hold. Everything else is read-only views over work/, metrics/, knowledge/.
 *   - org login spawns `sf org login web` with the right keychain HOME; the UI never sees a credential.
 *   - no framework, no CDN: one static HTML file (src/ui/static/index.html), node:http only.
 */
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { CONFIG_FILES, configFilePath, loadConfig, loadConfigFile, tryLoadConfig, writeConfigFile, EFFORT_LEVELS, EMAIL_DELIVERY_MODES, DEFAULT_EMAIL_CENSUS_FIELDS, emailDeliveryMode, emailCensusFields, type AllConfig, type OrgsConfig } from "../core/config.js";
import { readAllEvents, readEvents, emitEvent } from "../core/events.js";
import { listTickets, loadManifest, tryLoadManifest, type Manifest } from "../core/manifest.js";
import { homePaths, packageRoot, projectPaths, sanitizeTicket, vaultDir, type ProjectPaths } from "../core/paths.js";
import { keychainEnv, orgList, type OrgListEntry } from "../core/sf.js";
import { AGENT_NAMES, STAGES } from "../core/state-machine.js";
import { exists, listFiles, nowIso, randomToken, readJsonOr, readText, SfsmithsError } from "../core/util.js";
import { recordApproval } from "../engines/approvals.js";
import { doctor } from "../doctor/index.js";
import { allLessons, computeRewards, decideLesson, learnSync, type LessonType } from "../engines/learn.js";
import { holdTicket } from "../engines/lifecycle.js";
import { syncAll } from "../engines/sync.js";
import { readAgentRuns, freshTokens } from "../engines/tokens.js";

export interface UiOptions { p?: ProjectPaths; port?: number; open?: boolean; log?: (s: string) => void }

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const MAX_BODY = 512 * 1024;

export async function startUi(opts: UiOptions = {}): Promise<{ url: string; close: () => void }> {
  const p = opts.p ?? projectPaths();
  const log = opts.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const token = randomToken(24);
  const staticDir = findStaticDir(p);
  const orgCache: { at: number; data?: Record<string, OrgListEntry[] | { error: string }> } = { at: 0 };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      checkHostOrigin(req, server);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return sendFile(res, path.join(staticDir, "index.html"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#4f8cff"/><text x="16" y="21" font-family="monospace" font-size="14" font-weight="700" text-anchor="middle" fill="#fff">SF</text></svg>`);
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.headers["x-sfsmiths-token"] !== token) throw new HttpError(401, "missing or wrong token — reopen the URL printed by `sfsmiths-human ui`");
        const body = req.method === "GET" ? undefined : await readBody(req);
        const out = await route(req.method ?? "GET", url, body, { p, orgCache });
        return sendJson(res, 200, out);
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof SfsmithsError ? 400 : 500;
      sendJson(res, status, { error: (e as Error).message, code: (e as SfsmithsError).code });
    } finally {
      if (process.env.SFSMITHS_UI_DEBUG) log(`${req.method} ${req.url?.split("?")[0]} ${Date.now() - started}ms`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
  const url = `http://127.0.0.1:${port}/#t=${token}`;
  log(`SFsmiths UI → ${url}\n(127.0.0.1 only · token in the URL fragment · Ctrl+C to stop)`);
  if (opts.open !== false) openBrowser(url);
  return { url, close: () => server.close() };
}

/* ───────────────────────── routing ───────────────────────── */

interface Ctx { p: ProjectPaths; orgCache: { at: number; data?: Record<string, OrgListEntry[] | { error: string }> } }

async function route(method: string, url: URL, body: Record<string, unknown> | undefined, ctx: Ctx): Promise<Json> {
  const { p } = ctx;
  const seg = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const [root, id, action] = seg;
  const b = body ?? {};

  if (root === "dashboard" && method === "GET") return dashboard(p);
  if (root === "stages" && method === "GET") return STAGES.map((s) => ({ id: s.id, agent: s.agent, kind: s.kind, gates: s.gates, human_gate: s.human_gate, optional: s.optional }));

  if (root === "tickets") {
    if (!id && method === "GET") return listTickets(p).map((t) => ticketRow(p, t)).filter(Boolean);
    const key = sanitizeTicket(String(id));
    if (!action && method === "GET") return ticketDetail(p, key);
    if (action === "approve" && method === "POST") {
      const r = recordApproval({ ticket: key, stage: str(b.stage), decision: b.edits ? "approved_with_edits" : "approved", origin: "ui", answer: str(b.answer), edits: str(b.edits), by: str(b.by) }, p);
      return { ok: true, approval: r.approval, status: r.manifest.status, next: "In the Claude Code session run: sfsmiths agent handoff " + key };
    }
    if (action === "reject" && method === "POST") {
      const r = recordApproval({ ticket: key, stage: str(b.stage), decision: "rejected", origin: "ui", reason: str(b.reason), by: str(b.by) }, p);
      return { ok: true, approval: r.approval, status: r.manifest.status };
    }
    if (action === "hold" && method === "POST") { const m = holdTicket(key, str(b.reason) ?? "held from UI", p); return { ok: true, status: m.status }; }
    if (action === "events" && method === "GET") return readEvents(key, p).slice(-200);
    if (action === "file" && method === "GET") {
      // read-only view of ONE vault file (no traversal: basename only, allowlisted extensions)
      const rawName = String(url.searchParams.get("name") ?? "");
      const name = path.basename(rawName);
      if (name !== rawName || !/^[\w.-]+\.(md|json|yaml|jsonl|txt|apex|log)$/.test(name)) throw new HttpError(400, "bad file name");
      const f = path.join(vaultDir(p, key), name);
      if (!exists(f)) throw new HttpError(404, "no such file");
      return { name, content: readText(f).slice(0, 200_000) };
    }
    throw new HttpError(404, "unknown ticket action");
  }

  if (root === "agents" && method === "GET") return agentsView(p);
  if (root === "tokens" && method === "GET") return tokensView(p);

  if (root === "orgs") {
    if (!id && method === "GET") return orgsView(p, ctx, url.searchParams.get("fresh") === "1");
    if (!id && method === "POST") return orgAdd(p, b);
    if (id && action === "login" && method === "POST") return orgLogin(p, String(id), str(b.instance_url));
    if (id && !action && method === "DELETE") return orgRemove(p, String(id));
    throw new HttpError(404, "unknown org action");
  }

  if (root === "lessons") {
    if (!id && method === "GET") return { lessons: allLessons(p).sort((a, c) => (a.status === "pending" ? -1 : 1) - (c.status === "pending" ? -1 : 1) || c.hits - a.hits), rewards: rewardsSummary(p) };
    if (id && action === "decide" && method === "POST") {
      const decision = str(b.decision) as "approve" | "reject" | "promote" | "retire" | undefined;
      if (!decision || !["approve", "reject", "promote", "retire"].includes(decision)) throw new HttpError(400, "decision must be approve|reject|promote|retire");
      const l = decideLesson(p, String(id), decision, { reason: str(b.reason), agents: arr(b.agents), type: str(b.type) as LessonType | undefined });
      const synced = learnSync(p);
      return { ok: true, lesson: l, synced };
    }
    throw new HttpError(404, "unknown lesson action");
  }

  if (root === "config") {
    if (!id && method === "GET") return configView(p);
    const name = String(id) as keyof AllConfig;
    if (!CONFIG_FILES.includes(name)) throw new HttpError(404, `unknown config file ${name}`);
    if (method === "GET") { const { file: f, source } = configFilePath(name as keyof AllConfig, p); return { name, source, yaml: exists(f) ? readText(f) : "", schema: readSchema(p, name) }; }
    if (method === "PUT") {
      // two accepted shapes: {yaml: "..."} (Config screen) or {value: {...}} (Agents/Orgs screens)
      let value: unknown;
      if (typeof b.yaml === "string") { try { value = YAML.parse(b.yaml); } catch (e) { throw new HttpError(400, `YAML error: ${(e as Error).message}`); } }
      else if (b.value && typeof b.value === "object") value = b.value;
      else throw new HttpError(400, "body must be {yaml} or {value}");
      writeConfigFile(name, value as AllConfig[typeof name], p);     // schema-validated; throws → nothing written
      const sync = syncAll(p, { skipSkills: true });
      return { ok: true, name, sync, note: "Config saved + generated files refreshed. Takes effect in the NEXT Claude Code session." };
    }
    throw new HttpError(405, "method not allowed");
  }

  // D-102: the Safety screen — allowed test e-mails + delivery containment mode, edited as a form (not raw YAML)
  if (root === "safety") {
    if (method === "GET") return safetyView(p);
    if (method === "PUT") return safetySave(p, b);
    throw new HttpError(405, "method not allowed");
  }

  if (root === "doctor" && method === "POST") {
    const r = await doctor({ p, quick: b.quick !== false });
    return { at: nowIso(), ok: r.ok, checks: r.checks };
  }

  if (root === "sync" && method === "POST") return { ok: true, sync: syncAll(p) };

  throw new HttpError(404, `no route for ${method} ${url.pathname}`);
}

/* ───────────────────────── views ───────────────────────── */

function ticketRow(p: ProjectPaths, t: string) {
  const m = tryLoadManifest(t, p);
  if (!m) return undefined;
  return {
    ticket: m.ticket, title: m.title ?? "", status: m.status, tier: m.tier, stage: m.stage,
    waiting: m.waiting, updated_at: m.updated_at, created_at: m.created_at,
    tokens: m.budget.tokens, usd: m.budget.usd,
    stages_done: Object.values(m.stages).filter((s) => s.status === "done").length, stages_total: STAGES.length,
    bounces: m.bounces.length, resumes: m.resumes.length,
  };
}

function ticketDetail(p: ProjectPaths, key: string) {
  const m = loadManifest(key, p);
  const vault = vaultDir(p, key);
  const files = listFiles(vault).map((f) => path.basename(f)).filter((n) => !n.startsWith(".")).sort();
  const runs = readAgentRuns(p).filter((r) => r.ticket === key);
  // D-094: the budget is judged on FRESH tokens (input + output + cache writes); the total includes cache re-reads — show both
  const byAgent: Record<string, { tokens: number; fresh: number; runs: number; usd: number }> = {};
  for (const r of runs) { const a = (byAgent[r.agent] ??= { tokens: 0, fresh: 0, runs: 0, usd: 0 }); a.tokens += r.total_tokens; a.fresh += r.fresh_tokens ?? freshTokens(r.usage); a.runs++; a.usd += r.usd ?? 0; }
  return { manifest: m, files, stage_defs: STAGES.map((s) => ({ id: s.id, agent: s.agent, kind: s.kind, gates: s.gates, human_gate: s.human_gate, optional: s.optional })), tokens_by_agent: byAgent, events_tail: readEvents(key, p).slice(-40) };
}

function dashboard(p: ProjectPaths) {
  const rows = listTickets(p).map((t) => ticketRow(p, t)).filter(Boolean) as NonNullable<ReturnType<typeof ticketRow>>[];
  const { cfg, errors } = tryLoadConfig(p);
  const runs = readAgentRuns(p);
  const today = new Date().toISOString().slice(0, 10);
  const todayRuns = runs.filter((r) => r.ts.startsWith(today));
  const lessons = allLessons(p);
  const rewards = rewardsSummary(p);
  const events = readAllEvents(p);
  const denials = events.filter((e) => ["policy.denied", "write.denied", "agent.spawn_denied", "email_guard.blocked"].includes(e.type));
  const canary = readCanaryState(p, cfg.orgs, cfg.safety?.canary_max_age_minutes ?? 30);
  return {
    generated_at: nowIso(),
    config_errors: errors,
    counts: {
      tickets: rows.length,
      running: rows.filter((r) => r.status === "running").length,
      waiting_human: rows.filter((r) => r.status === "waiting_human").length,
      on_hold: rows.filter((r) => r.status === "on_hold").length,
      escalated: rows.filter((r) => r.status === "escalated").length,
      parked: rows.filter((r) => r.status === "parked").length,
      done: rows.filter((r) => r.status === "done").length,
      failed: rows.filter((r) => r.status === "failed").length,
    },
    needs_you: rows.filter((r) => r.status === "waiting_human" || r.status === "escalated" || r.status === "parked"),
    today: { tokens: todayRuns.reduce((s, r) => s + r.total_tokens, 0), usd: todayRuns.reduce((s, r) => s + (r.usd ?? 0), 0), runs: todayRuns.length, budget_usd: cfg.budgets?.daily_usd,
      // D-094 shipped prices in config/budgets.yaml; the card used to say "no prices.json" regardless (C8 housekeeping)
      prices_source: exists(path.join(p.metrics, "prices.json")) ? "metrics/prices.json" : Object.keys(cfg.budgets?.prices ?? {}).length ? "config/budgets.yaml" : "none" },
    rewards: { total: rewards?.total ?? 0, by_agent: rewards?.by_agent ?? {} },
    lessons: { pending: lessons.filter((l) => l.status === "pending").length, active: lessons.filter((l) => ["approved", "auto", "promoted"].includes(l.status)).length },
    denials_last_7d: denials.filter((e) => Date.now() - Date.parse(e.ts) < 7 * 86400_000).length,
    canary,
    recent: rows.sort((a, c) => c.updated_at.localeCompare(a.updated_at)).slice(0, 12),
  };
}

function agentsView(p: ProjectPaths) {
  const { cfg } = tryLoadConfig(p);
  const runs = readAgentRuns(p);
  const rewards = rewardsSummary(p);
  const agentFile = (a: string) => path.join(p.agents, `${a}.md`);
  const models = cfg.models?.agents ?? {};
  const efforts = cfg.models?.effort ?? {};
  const autonomy = cfg.autonomy?.agents ?? {};
  const agents = AGENT_NAMES.map((a) => {
    const rs = runs.filter((r) => r.agent === a);
    const byModel: Record<string, number> = {};
    for (const r of rs) byModel[r.model ?? "unknown"] = (byModel[r.model ?? "unknown"] ?? 0) + r.total_tokens;
    const fm = exists(agentFile(a)) ? readText(agentFile(a)).split("\n---")[0] : "";
    const declaredModel = /^model:\s*(\S+)/m.exec(fm)?.[1];
    const declaredEffort = /^effort:\s*(\S+)/m.exec(fm)?.[1];
    const wantModel = models[a] ?? cfg.models?.fallback;
    const wantEffort = efforts[a] ?? cfg.models?.fallback_effort ?? "inherit";
    return {
      name: a, model: models[a] ?? cfg.models?.fallback ?? "inherit", model_in_agent_file: declaredModel ?? null,
      // D-095: effort is only in the agent file when it is NOT `inherit` — no line means the session level applies
      effort: wantEffort, effort_in_agent_file: declaredEffort ?? null,
      in_sync: (!declaredModel || declaredModel === wantModel) && (wantEffort === "inherit" ? !declaredEffort : declaredEffort === wantEffort),
      gate_mode: autonomy[a] ?? "inherit", hard_floor: (cfg.autonomy?.hard_floor ?? []).includes(a),
      runs: rs.length, tokens: rs.reduce((s, r) => s + r.total_tokens, 0), fresh_tokens: rs.reduce((s, r) => s + (r.fresh_tokens ?? 0), 0),
      cache_read_tokens: rs.reduce((s, r) => s + (r.usage?.cache_read_input_tokens ?? 0), 0),
      usd: rs.reduce((s, r) => s + (r.usd ?? 0), 0), tokens_by_model: byModel,
      reward: rewards?.by_agent?.[a] ?? 0, agent_file_exists: exists(agentFile(a)),
      lessons_skill: exists(path.join(p.skills, `lessons-${a}`, "SKILL.md")),
    };
  });
  return {
    agents, models_config: cfg.models ?? null, autonomy_config: cfg.autonomy ?? null, budgets: cfg.budgets ?? null,
    model_choices: ["opus", "sonnet", "haiku", "fable", "inherit"],
    effort_choices: [...EFFORT_LEVELS, "inherit"],
    // D-095: this env var beats agent frontmatter — if it is set, every effort value on this screen is ignored
    effort_env_override: process.env.CLAUDE_CODE_EFFORT_LEVEL || null,
  };
}

function tokensView(p: ProjectPaths) {
  const runs = readAgentRuns(p);
  const agg = (key: (r: (typeof runs)[number]) => string) => {
    const out: Record<string, { tokens: number; fresh: number; usd: number; runs: number; input: number; output: number; cache_read: number; cache_write: number }> = {};
    for (const r of runs) {
      const k = key(r);
      const o = (out[k] ??= { tokens: 0, fresh: 0, usd: 0, runs: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 });
      o.tokens += r.total_tokens; o.usd += r.usd ?? 0; o.runs++;
      o.input += r.usage.input_tokens; o.output += r.usage.output_tokens;
      o.cache_read += r.usage.cache_read_input_tokens; o.cache_write += r.usage.cache_creation_input_tokens;
      o.fresh += r.fresh_tokens ?? (r.usage.input_tokens + r.usage.output_tokens + r.usage.cache_creation_input_tokens);
    }
    return out;
  };
  const days: Record<string, number> = {};
  for (const r of runs) days[r.ts.slice(0, 10)] = (days[r.ts.slice(0, 10)] ?? 0) + r.total_tokens;
  const { cfg } = tryLoadConfig(p);
  // D-094: which models we can actually price. A run whose model matches nothing here records no cost.
  const priceKeys = Object.keys(readJsonOr<Record<string, unknown>>(path.join(p.metrics, "prices.json"), {}) ?? {});
  const configPriceKeys = Object.keys(cfg.budgets?.prices ?? {});
  const known = priceKeys.length ? priceKeys : configPriceKeys;
  const unpriced = [...new Set(runs.map((r) => r.model).filter((m): m is string => !!m))]
    .filter((m) => !known.some((k) => m.toLowerCase().includes(k.toLowerCase())));
  return {
    by_model: agg((r) => r.model ?? "unknown"), by_ticket: agg((r) => r.ticket ?? "(none)"), by_agent: agg((r) => r.agent), by_day: days,
    prices_file: exists(path.join(p.metrics, "prices.json")), prices_source: priceKeys.length ? "metrics/prices.json" : configPriceKeys.length ? "config/budgets.yaml" : "none",
    priced_models: known, unpriced_models: unpriced, total_runs: runs.length,
  };
}

async function orgsView(p: ProjectPaths, ctx: Ctx, fresh: boolean) {
  const orgs = loadConfigFile("orgs", p);
  if (fresh || !ctx.orgCache.data || Date.now() - ctx.orgCache.at > 30_000) {
    const data: Record<string, OrgListEntry[] | { error: string }> = {};
    for (const kc of ["agent", "engine"] as const) { const r = await orgList(kc); data[kc] = r.ok ? r.data ?? [] : { error: r.error ?? "sf org list failed" }; }
    ctx.orgCache.data = data; ctx.orgCache.at = Date.now();
  }
  const kcData = ctx.orgCache.data!;
  const status = orgs.orgs.map((o) => {
    const list = kcData[o.keychain];
    const entry = Array.isArray(list) ? list.find((e) => (e.alias ?? "").toLowerCase() === o.alias.toLowerCase()) : undefined;
    const wrongKc = (["agent", "engine"] as const).filter((k) => k !== o.keychain).some((k) => Array.isArray(kcData[k]) && (kcData[k] as OrgListEntry[]).some((e) => (e.alias ?? "").toLowerCase() === o.alias.toLowerCase()));
    return { ...o, logged_in: !!entry, username: entry?.username ?? null, instance_url_live: entry?.instanceUrl ?? null, connected_status: entry?.connectedStatus ?? null, leaked_into_other_keychain: wrongKc };
  });
  return { config: orgs, status, keychains: { agent: Array.isArray(kcData.agent) ? (kcData.agent as OrgListEntry[]).map((e) => ({ alias: e.alias, username: e.username })) : kcData.agent, engine: Array.isArray(kcData.engine) ? (kcData.engine as OrgListEntry[]).map((e) => ({ alias: e.alias, username: e.username })) : kcData.engine }, engine_home: homePaths().engineHome, checked_at: new Date(ctx.orgCache.at).toISOString() };
}

function orgAdd(p: ProjectPaths, b: Record<string, unknown>) {
  const alias = str(b.alias); const role = str(b.role) as "development" | "preprod" | "evidence" | undefined;
  if (!alias || !/^[A-Za-z][\w-]{0,40}$/.test(alias)) throw new HttpError(400, "alias: letters/digits/_/- (start with a letter)");
  if (!role || !["development", "preprod", "evidence"].includes(role)) throw new HttpError(400, "role must be development|preprod|evidence");
  const kc = (str(b.keychain) ?? (role === "preprod" ? "engine" : "agent")) as "agent" | "engine";
  const orgs = loadConfigFile("orgs", p) as OrgsConfig;
  if (orgs.orgs.some((o) => o.alias.toLowerCase() === alias.toLowerCase())) throw new HttpError(409, `${alias} already configured`);
  orgs.orgs.push({ alias, role, keychain: kc, write: role === "development", readonly_user: str(b.readonly_user) ?? (role === "evidence" ? "" : undefined), email_deliverability: "unknown", instance_url: str(b.instance_url) ?? null, notes: str(b.notes) ?? null });
  writeConfigFile("orgs", orgs, p);
  const sync = syncAll(p, { skipSkills: true });
  return { ok: true, added: alias, sync, next: `Login: press "Login" on ${alias} (opens sf org login web in the ${kc} keychain), then run doctor.` };
}

function orgRemove(p: ProjectPaths, alias: string) {
  const orgs = loadConfigFile("orgs", p) as OrgsConfig;
  const before = orgs.orgs.length;
  orgs.orgs = orgs.orgs.filter((o) => o.alias.toLowerCase() !== alias.toLowerCase());
  if (orgs.orgs.length === before) throw new HttpError(404, `${alias} not in config`);
  writeConfigFile("orgs", orgs, p);
  return { ok: true, removed: alias, sync: syncAll(p, { skipSkills: true }), note: `sf keychain login untouched — run: sf org logout -o ${alias}` };
}

function orgLogin(p: ProjectPaths, alias: string, instanceUrl?: string) {
  const cfg = loadConfig(p, { fresh: true });
  const org = cfg.orgs.orgs.find((o) => o.alias.toLowerCase() === alias.toLowerCase());
  if (!org) throw new HttpError(404, `${alias} is not in config/orgs.yaml — add it first`);
  if (org.keychain === "engine") fs.mkdirSync(homePaths().engineHome, { recursive: true });
  const args = ["org", "login", "web", "--alias", org.alias];
  const url = instanceUrl ?? org.instance_url ?? (org.role !== "evidence" ? "https://test.salesforce.com" : undefined);
  if (url) { if (!/^https:\/\/[\w.-]+(\.salesforce\.com|\.force\.com|\.salesforce-setup\.com)\/?$/.test(url) && !/^https:\/\/(test|login)\.salesforce\.com\/?$/.test(url)) throw new HttpError(400, "instance_url must be an https://*.salesforce.com or *.force.com URL"); args.push("--instance-url", url); }
  const logFile = path.join(p.state, "ui-login.log");
  fs.mkdirSync(p.state, { recursive: true });
  const out = fs.openSync(logFile, "a");
  const child = spawn("sf", args, { detached: true, stdio: ["ignore", out, out], env: { ...process.env, ...keychainEnv(org.keychain) } });
  child.unref();
  emitEvent({ ticket: "-", type: "human.feedback", data: { ui: "org.login", alias: org.alias, keychain: org.keychain } }, p);
  return { ok: true, pid: child.pid, command: `sf ${args.join(" ")}`, keychain: org.keychain, home: org.keychain === "engine" ? homePaths().engineHome : "(default)", note: "A browser window opens for Salesforce login. When it finishes, press Refresh here and run Doctor." };
}

function configView(p: ProjectPaths) {
  const { errors } = tryLoadConfig(p);
  return {
    files: CONFIG_FILES.map((n) => { const { file: f, source } = configFilePath(n, p); return { name: n, exists: exists(f), source, bytes: exists(f) ? fs.statSync(f).size : 0, error: errors[n] ?? null }; }),
    generated: {
      mcp_json: exists(path.join(p.root, ".mcp.json")),
      compiled_policy: exists(path.join(p.state, "policy.compiled.json")),
      settings_json: exists(path.join(p.claude, "settings.json")),
      agents: AGENT_NAMES.filter((a) => exists(path.join(p.agents, `${a}.md`))).length,
    },
    env_names: ["SFSMITHS_JIRA_EMAIL", "SFSMITHS_JIRA_TOKEN", "SFSMITHS_SLACK_WEBHOOK", "SFSMITHS_CANARY_EMAIL", "ANTHROPIC_API_KEY (pipeline mode only)"],
  };
}

function readSchema(p: ProjectPaths, name: string): unknown {
  for (const c of [path.join(p.schemas, "config", `${name}.schema.json`), path.join(packageRoot(), "schemas", "config", `${name}.schema.json`)]) if (exists(c)) return readJsonOr(c, null);
  return null;
}

function rewardsSummary(p: ProjectPaths): { total: number; by_agent: Record<string, number>; by_ticket?: Record<string, number> } | undefined {
  const f = path.join(p.metrics, "rewards.json");
  const persisted = readJsonOr<{ total: number; by_agent: Record<string, number>; by_ticket?: Record<string, number> } | undefined>(f, undefined);
  if (persisted) return persisted;
  try { const cfg = loadConfig(p); const s = computeRewards(readAllEvents(p), cfg); return { total: s.total, by_agent: s.by_agent, by_ticket: s.by_ticket }; } catch { return undefined; }
}

/** Canary state per development org, in the shape `runCanary` writes (`result`, `at`, `detail`) plus freshness for the data-guard. */
function readCanaryState(p: ProjectPaths, orgs?: OrgsConfig, maxAgeMinutes = 30) {
  const out: Record<string, { result: string; at?: string; detail?: string; fresh: boolean; note?: string; mode?: string; census?: { field: string; non_allowlisted: number | null; note?: string }[] }> = {};
  for (const o of orgs?.orgs ?? []) {
    if (o.role !== "development") continue;
    const f = path.join(p.state, "canary", `${o.alias}.json`);
    const st = readJsonOr<{ result?: string; at?: string; detail?: string; mode?: string; census?: { field: string; non_allowlisted: number | null; note?: string }[] } | undefined>(f, undefined);
    if (!st) { out[o.alias] = { result: "never", fresh: false, note: "run: sfsmiths agent canary --org " + o.alias }; continue; }
    const ageMin = st.at ? (Date.now() - Date.parse(st.at)) / 60_000 : Infinity;
    out[o.alias] = { result: st.result ?? "unknown", at: st.at, detail: st.detail, fresh: st.result === "pass" && ageMin <= maxAgeMinutes, mode: st.mode ?? "blocked", census: st.census };
  }
  return out;
}

/* ───────────────────────── safety (D-102) ───────────────────────── */

function safetyView(p: ProjectPaths) {
  const { cfg, errors } = tryLoadConfig(p);
  const s = cfg.safety;
  const { source } = configFilePath("safety", p);
  return {
    source, error: errors.safety,
    allowed_test_emails: s?.allowed_test_emails ?? [],
    email_delivery: s ? emailDeliveryMode(s) : "blocked",
    email_census_fields: s ? emailCensusFields(s) : DEFAULT_EMAIL_CENSUS_FIELDS,
    canary_max_age_minutes: s?.canary_max_age_minutes ?? 30,
    canary_recipient_env: s?.canary_recipient_env,
    test_tag_field: s?.test_tag_field,
    modes: EMAIL_DELIVERY_MODES,
    canary: readCanaryState(p, cfg.orgs, s?.canary_max_age_minutes ?? 30),
    enforcement: [
      "email-guard gate: every file an agent touched (test data, scripts, tests, specs) is scanned — one address outside the list fails the stage",
      "apex-run: a repro-data script with a non-allowlisted address is refused before it runs",
      "comms-lint: client drafts may contain no address at all; internal drafts only allowlisted ones",
      "canary recipient: the probe goes only to your own address (SFSMITHS_CANARY_EMAIL), which must be in this list",
      "data-guard hook: no data-creating tool runs without a fresh canary PASS (max age below)",
    ],
  };
}

const EMAIL_OR_GLOB_RE = /^[A-Za-z0-9*._%+-]+@[A-Za-z0-9*.-]+\.[A-Za-z*]{2,}$|^\*\.[A-Za-z]{2,}$|^\*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function safetySave(p: ProjectPaths, b: Record<string, unknown>) {
  const current = loadConfigFile("safety", p);
  const next = { ...current };
  if (Array.isArray(b.allowed_test_emails)) {
    const list = (b.allowed_test_emails as unknown[]).map((x) => String(x).trim()).filter(Boolean);
    const bad = list.filter((x) => !EMAIL_OR_GLOB_RE.test(x));
    if (bad.length) throw new HttpError(400, `not an address or pattern: ${bad.join(", ")} (use name@example.com, *@example.com or *.invalid)`);
    if (!list.length) throw new HttpError(400, "the allowlist cannot be empty — every test address must match something");
    next.allowed_test_emails = [...new Set(list)];
  }
  if (typeof b.email_delivery === "string") {
    if (!EMAIL_DELIVERY_MODES.includes(b.email_delivery as never)) throw new HttpError(400, `email_delivery must be one of ${EMAIL_DELIVERY_MODES.join("|")}`);
    next.email_delivery = b.email_delivery as (typeof EMAIL_DELIVERY_MODES)[number];
  }
  if (Array.isArray(b.email_census_fields)) {
    const fields = (b.email_census_fields as unknown[]).map((x) => String(x).trim()).filter(Boolean);
    const bad = fields.filter((f) => !/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(f));
    if (bad.length) throw new HttpError(400, `census fields must be Object.Field: ${bad.join(", ")}`);
    next.email_census_fields = fields;
  }
  writeConfigFile("safety", next, p); // schema-validated; throws → nothing written
  return { ok: true, note: `Saved config/safety.yaml. Agents read the allowlist on their next data step; the canary applies the delivery mode on its next run (sfsmiths agent canary --org <dev>).${next.email_delivery === "allowlist_only" ? " allowlist_only: the next canary will run the e-mail census — it FAILS if any configured field holds an address outside the list." : ""}` };
}

/* ───────────────────────── plumbing ───────────────────────── */

function checkHostOrigin(req: http.IncomingMessage, server: http.Server): void {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const host = (req.headers.host ?? "").toLowerCase();
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!okHosts.has(host)) throw new HttpError(403, `bad Host header (${host})`);
  const origin = req.headers.origin;
  if (origin) {
    const okOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
    if (!okOrigins.has(origin.toLowerCase())) throw new HttpError(403, `bad Origin (${origin})`);
  }
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, `cross-site request refused (${site})`);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, "body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { const t = Buffer.concat(chunks).toString("utf8"); if (!t.trim()) return resolve({}); try { const j = JSON.parse(t); resolve(j && typeof j === "object" ? j : {}); } catch { reject(new HttpError(400, "body must be JSON")); } });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body ?? null);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" });
  res.end(s);
}

function sendFile(res: http.ServerResponse, file: string, type: string): void {
  if (!exists(file)) { sendJson(res, 500, { error: `UI file missing: ${file}` }); return; }
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  res.end(fs.readFileSync(file));
}

function findStaticDir(p: ProjectPaths): string {
  const candidates = [path.join(packageRoot(), "src", "ui", "static"), path.join(p.root, "src", "ui", "static"), path.join(homePaths().toolkit, "src", "ui", "static")];
  return candidates.find((c) => exists(path.join(c, "index.html"))) ?? candidates[0];
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { const c = spawn(cmd, args, { stdio: "ignore", detached: true }); c.on("error", () => {}); c.unref(); } catch { /* headless: URL is printed */ }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

export type { Manifest };
