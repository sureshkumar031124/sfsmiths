/**
 * fast.ts — the BLOCKING hooks. Zero dependencies (node:fs/path/os only) so they answer in tens of
 * milliseconds; a timed-out hook renders no decision (fail-open, per docs), so speed IS safety.
 *
 *   agent-gate  PreToolUse(Agent)              → deny spawning an agent the manifest does not allow
 *   policy      PreToolUse(Bash)               → deny non-development targets, raw prod SOQL, BC push, HOME/SF_* overrides, human verbs
 *   write-guard PreToolUse(Edit|Write|...)     → deny writes outside the agent write areas
 *
 * Output: exit 0 + {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}} (verified format).
 * Reads compiled policy from .sfsmiths/policy.compiled.json (written by `sfsmiths-human sync`), with conservative
 * built-in defaults when it is missing. Never imports the toolkit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  agent_id?: string;
  agent_type?: string;
  permission_mode?: string;
}

export interface CompiledPolicy {
  version: number;
  compiled_at: string;
  dev_aliases: string[];         // allowed deploy/write targets (lowercase)
  preprod_aliases: string[];
  evidence_aliases: string[];
  alias_map: Record<string, string>;
  bluecanvas_patterns: string[];
  protected_paths: string[];     // repo-relative prefixes agents may never write via Bash
  agent_write_areas: string[];   // repo-relative prefixes agents may write via Edit/Write
  engine_home: string;
  canary_max_age_minutes: number;
  require_canary: boolean;
}

export const DEFAULT_POLICY: CompiledPolicy = {
  version: 1,
  compiled_at: "builtin",
  dev_aliases: ["devsandbox"],
  preprod_aliases: ["partialuat", "uat", "preprod"],
  evidence_aliases: ["production", "prod"],
  alias_map: {},
  bluecanvas_patterns: ["bluecanvas", "blue-canvas"],
  protected_paths: ["src/", "bin/", "dist/", ".claude/settings.json", ".claude/agents/", ".claude/skills/", ".claude/rules/", ".claude/commands/", ".claude-plugin/", ".mcp.json", "CLAUDE.md", "config/", "knowledge/", "templates/", "schemas/", "docs/", ".sfsmiths/", "scripts/", "package.json", ".github/"],
  agent_write_areas: ["org/force-app/", "tests-ui/", "work/", "inbox/", "spikes/", ".claude/agent-memory/"],
  engine_home: path.join(os.homedir(), ".sfsmiths", "engine"),
  canary_max_age_minutes: 30,
  require_canary: true,
};

export function readStdinJson(): HookInput {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    return {};
  }
}

export function projectRoot(input: HookInput): string {
  const env = process.env.SFSMITHS_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR;
  if (env) return env;
  let dir = input.cwd || process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "config", "orgs.yaml")) && fs.existsSync(path.join(dir, ".claude"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return input.cwd || process.cwd();
}

export function loadPolicy(root: string): CompiledPolicy {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(root, ".sfsmiths", "policy.compiled.json"), "utf8")) as Partial<CompiledPolicy>;
    return { ...DEFAULT_POLICY, ...p, engine_home: p.engine_home || (process.env.SFSMITHS_ENGINE_HOME ?? DEFAULT_POLICY.engine_home) };
  } catch {
    return { ...DEFAULT_POLICY, engine_home: process.env.SFSMITHS_ENGINE_HOME ?? DEFAULT_POLICY.engine_home };
  }
}

export interface StateSidecar {
  ticket: string; status: string; stage: string; next_allowed_stages: string[]; waiting: { kind: string; stage: string } | null; stage_status?: string;
}

export function ticketForSession(root: string, sessionId?: string): string | undefined {
  if (sessionId) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(root, ".sfsmiths", "sessions", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), "utf8")) as { ticket?: string };
      if (s.ticket) return s.ticket;
    } catch { /* fall through */ }
  }
  try {
    const t = fs.readFileSync(path.join(root, "work", ".active-ticket"), "utf8").trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export function readState(root: string, ticket: string): StateSidecar | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "work", ticket, ".state.json"), "utf8")) as StateSidecar;
  } catch {
    return undefined;
  }
}

export function appendEvent(root: string, ticket: string | undefined, type: string, data: Record<string, unknown>, agent?: string): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ticket: ticket ?? "-", type, agent, data }) + "\n";
  try {
    fs.mkdirSync(path.join(root, ".sfsmiths"), { recursive: true });
    fs.appendFileSync(path.join(root, ".sfsmiths", "events.jsonl"), line);
    if (ticket && fs.existsSync(path.join(root, "work", ticket))) fs.appendFileSync(path.join(root, "work", ticket, "events.jsonl"), line);
  } catch { /* never fail a hook on logging */ }
}

export type Decision = { deny: string } | { allow: true; context?: string };

export function emit(decision: Decision): never {
  if ("deny" in decision) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `SFsmiths: ${decision.deny}` } }) + "\n");
  } else if (decision.context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: decision.context } }) + "\n");
  }
  process.exit(0);
}

/* ============================ agent-gate ============================ */

export const ALWAYS_DENIED_AGENTS = ["salesforce-dev", "salesforce-development:salesforce-dev"];

export function decideAgentGate(input: HookInput, root: string): Decision {
  const ti = input.tool_input ?? {};
  const requested = String(ti.subagent_type ?? ti.agent ?? ti.name ?? "").trim();
  if (!requested) return { allow: true };
  if (ALWAYS_DENIED_AGENTS.some((d) => requested === d || requested.endsWith(`:${d}`))) return { deny: `agent "${requested}" is not part of this system (only sfsmiths agents may be spawned)` };
  const ticket = ticketForSession(root, input.session_id);
  if (!ticket) {
    // no ticket in flight: only maintenance agents allowed
    if (["a0-cartographer", "a7-coach"].includes(requested)) return { allow: true };
    return { deny: `no active ticket for this session — start with /ticket <KEY> before spawning ${requested}` };
  }
  const st = readState(root, ticket);
  if (!st) return { deny: `ticket ${ticket} has no state file — run \`sfsmiths agent handoff ${ticket}\`` };
  if (["done", "failed"].includes(st.status) && ["a0-cartographer", "a7-coach"].includes(requested)) return { allow: true }; // maintenance after a finished ticket
  if (["waiting_human", "on_hold", "parked", "escalated", "done", "failed"].includes(st.status)) {
    appendEvent(root, ticket, "agent.spawn_denied", { requested, status: st.status, stage: st.stage }, input.agent_type);
    return { deny: `ticket ${ticket} is ${st.status} at stage ${st.stage} — ${st.waiting ? `waiting for human (${st.waiting.kind})` : "no agent may run now"}` };
  }
  if (!st.next_allowed_stages.includes(requested)) {
    appendEvent(root, ticket, "agent.spawn_denied", { requested, allowed: st.next_allowed_stages, stage: st.stage }, input.agent_type);
    return { deny: `stage "${st.stage}" allows only [${st.next_allowed_stages.join(", ")}]; "${requested}" is out of order. Run \`sfsmiths agent handoff ${ticket}\` and follow it.` };
  }
  return { allow: true };
}

/* ============================ policy ============================ */

export function normalizeCommand(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/\bsfdx\b/g, "sf").replace(/\bforce:/g, "").replace(/\bsf ([a-z]+):([a-z]+)(?::([a-z]+))?/g, (_m, a, b, c) => `sf ${a} ${b}${c ? " " + c : ""}`);
  s = s.replace(/\bsf data soql query\b/g, "sf data query").replace(/\bsf apex test run\b/g, "sf apex run test");
  return s;
}

export function splitCompound(cmd: string): string[] {
  // split on && || ; | and newlines — each piece is judged on its own (a deny anywhere denies all)
  return cmd.split(/\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

export function targetOrg(cmd: string): string | undefined {
  const m = cmd.match(/(?:^|\s)(?:-o|-u|--target-org|--targetusername|--target-dev-hub|-v)(?:=|\s+)("[^"]+"|'[^']+'|\S+)/);
  return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
}

const WRITE_VERBS = /^sf (project deploy|project delete|project retrieve|project generate|data (create|update|delete|upsert|import|bulk|tree import)|apex run(?! test)|apex run test|org (create|delete|login|logout|open)|package|flow run|sobject|schema|community|analytics|lightning|force|api request|data query)/;
const READONLY_CMDS = /^(cat|less|more|head|tail|grep|rg|ls|find|wc|diff|stat|file|tree|echo|printf|pwd|which|type|jq|yq|sort|uniq|cut|awk '[^']*'\s*$|git (status|log|diff|show|blame|ls-files|rev-parse)|npm (test|run test|run build|run verify|ls)|node --test|sf (org display|org list|apex get|data query|project retrieve preview|--version|version|plugins))/;

export function decidePolicy(input: HookInput, root: string, policy: CompiledPolicy): Decision {
  const raw = String(input.tool_input?.command ?? "");
  if (!raw.trim()) return { allow: true };
  const ticket = ticketForSession(root, input.session_id);
  const deny = (why: string, rule: string): Decision => {
    appendEvent(root, ticket, "policy.denied", { rule, command: raw.slice(0, 300) }, input.agent_type);
    return { deny: `${why} [rule ${rule}]` };
  };
  const full = normalizeCommand(raw);
  const lower = full.toLowerCase();

  // R1 — human-only verbs
  if (/\bsfsmiths-human\b/.test(lower) || /\bsfsmiths(?:\.js)?\s+human\b/.test(lower)) return deny("sfsmiths-human is for the human operator only; agents use `sfsmiths agent …`", "R1-human-verbs");
  // R2 — keychain / env redirection
  if (/(?:^|[\s;&|])HOME=|\bUSERPROFILE=|\bexport HOME\b|\bunset HOME\b/.test(full)) return deny("changing HOME would switch sf keychains", "R2-home-override");
  if (/(?:^|[\s;&|])(SF_[A-Z_]+|SFDX_[A-Z_]+)=|\bexport (SF_|SFDX_)/.test(full)) return deny("SF_*/SFDX_* env overrides are not allowed for agents", "R2-sf-env");
  if (lower.includes(".sfsmiths/engine") || lower.includes(policy.engine_home.toLowerCase())) return deny("the engine keychain (preprod auth) is not accessible to agents", "R2-engine-home");
  // R3 — Blue Canvas / any git push
  if (/\bgit\s+push\b/.test(lower) || /\bgit\s+remote\s+(add|set-url)\b/.test(lower)) {
    if (policy.bluecanvas_patterns.some((p) => lower.includes(p))) return deny("git push to a Blue Canvas remote — the human deploys", "R3-bluecanvas");
    if (/\bgit\s+push\b/.test(lower)) return deny("agents never push; commits stay local for the human to review", "R3-git-push");
  }
  // R4 — nested claude / hooks off
  if (/(?:^|[\s;&|])claude(?:\s|$)/.test(lower) && !/\bclaude\s+(--version|-v)\b/.test(lower)) return deny("agents do not launch claude sessions or change settings", "R4-nested-claude");
  // R5 — direct Salesforce HTTP (bypasses masking/keychains)
  if (/\b(curl|wget|http|httpie|xh)\b/.test(lower) && /(salesforce\.com|force\.com|cloudforce\.com|visualforce\.com|lightning\.force)/.test(lower)) return deny("direct HTTP to Salesforce bypasses masking and keychains — use MCP tools or sfsmiths agent evidence", "R5-direct-http");

  for (const part of splitCompound(full)) {
    const p = part.toLowerCase();
    // R6 — protected paths via shell writes
    // a "read-only" command with a redirection (echo x > file, cat a >> b) or tee is a write
    const isReadOnly = READONLY_CMDS.test(p) && !/(^|[^>])>{1,2}(?!&)\s*\S|\btee\b/.test(p);
    if (!isReadOnly) {
      const targets = writeTargets(p);
      if (targets) for (const prot of policy.protected_paths) {
        if (mentionsProtectedPath(targets, prot)) {
          return deny(`write to protected path ${prot} — agents may only write org/force-app, tests-ui, their vault and their own agent memory`, "R6-protected-path");
        }
      }
      if (/\bmanifest\.yaml\b|\.state\.json\b|\/validations\/|\/approvals\/|events\.jsonl|rewards\.jsonl/.test(p) && /(>|>>|\btee\b|\bsed -i|\brm\b|\bmv\b|\bcp\b|\bnode -e|\bpython3? -c)/.test(p)) return deny("ticket state files are written by the toolkit only", "R6-vault-state");
    }
    // R7 — sf CLI targets
    if (/^sf\b/.test(p)) {
      const tRaw = targetOrg(part);
      const t = tRaw ? (policy.alias_map[tRaw] ?? policy.alias_map[tRaw.toLowerCase()] ?? tRaw).toLowerCase() : undefined;
      const isDev = t ? policy.dev_aliases.includes(t) : false;
      const isPreprod = t ? policy.preprod_aliases.includes(t) : false;
      const isEvidence = t ? policy.evidence_aliases.includes(t) : false;
      const looksProd = t ? /prod/.test(t) && !isDev : false;
      if (isPreprod) return deny(`raw sf commands against preprod "${tRaw}" are engine-only — use \`sfsmiths agent privileged …\``, "R7-preprod");
      if (/^sf data query\b/.test(p) && (isEvidence || looksProd)) return deny("raw SOQL against production bypasses masking — use `sfsmiths agent evidence soql …`", "R7-prod-soql");
      if (WRITE_VERBS.test(p) && !/^sf data query\b/.test(p) && (isEvidence || looksProd)) return deny(`"${part.slice(0, 60)}" targets production — production is read-only`, "R7-prod-write");
      // Any explicit target that is not a configured development alias is denied — reads included. The human's own keychain may
      // hold other sandboxes or an admin production login under an arbitrary alias or a bare username; agents never touch those.
      if (t && !isDev) return deny(`target "${tRaw}" is not a configured development org (${policy.dev_aliases.join(", ")}) — agents run sf only against the development org by its alias; preprod goes through \`sfsmiths agent privileged …\`, production through \`sfsmiths agent evidence …\``, "R7-non-dev-target");
      if (/^sf (data query|data export|apex run|project deploy|project retrieve)\b/.test(p) && !t) return deny("name the development org explicitly (-o <dev alias>) — the default target-org is not trusted", "R7-no-target");
      if (WRITE_VERBS.test(p) && !/^sf data query\b/.test(p)) {
        if (/^sf (project deploy|project delete|data (create|update|delete|upsert|import|bulk|tree import)|apex run(?! test)|org (create|delete))/.test(p) && !t) return deny("write-type sf command without an explicit --target-org — always name the development org", "R7-no-target");
      }
      if (/^sf org (login|logout)\b/.test(p)) return deny("org logins are done by the human (sfsmiths-human org login)", "R7-org-login");
    }
    if (/^sfsmiths\s+agent\s+(approve|reject|deployed|verify|sync|learn|run|ui|doctor|org|lessons|setup|init|start|hold|resume)(\s|$)/.test(p)) return deny("that verb does not exist on `sfsmiths agent` — it is human-only", "R1-human-verbs");
  }
  return { allow: true };
}

/** protected prefix must sit at a path start: "config/x", ./config/x, "$ROOT/config/x", quoted, or after = .
 *  Generic short names (bin/, dist/, docs/, scripts/) only count at repo-root-relative starts, to avoid
 *  false positives inside deep source paths. */
const GENERIC_PROTECTED = new Set(["src/", "bin/", "dist/", "docs/", "scripts/", "package.json"]);
export function mentionsProtectedPath(cmdLower: string, prot: string): boolean {
  const bare = prot.toLowerCase().replace(/\/$/, "");
  const needle = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = GENERIC_PROTECTED.has(prot)
    ? `(^|[\\s"'=(:]|\\$\\{?[A-Za-z_]*\\}?/|\\.\\./|\\./)`
    : `(^|[\\s"'=(:/]|\\$\\{?[A-Za-z_]*\\}?/|\\.\\./|\\./)`;
  const after = prot.endsWith("/") ? `(/|$|["'\\s;&|)])` : `($|["'\\s;&|)])`;
  return new RegExp(`${boundary}${needle}${after}`).test(cmdLower);
}

/** The part of a shell command that names what gets WRITTEN (so `cp templates/x work/T/` is judged on `work/T/`, not on templates/).
 *  Returns undefined when the command cannot write anything we care about. */
export function writeTargets(p: string): string | undefined {
  const redirect = p.match(/(?:^|[^>])(>{1,2})(?!&)\s*(\S+)/);
  const tee = p.match(/\btee\b(?:\s+-[a-z]+)*\s+(.+)$/);
  const pieces: string[] = [];
  if (redirect) pieces.push(redirect[2]);
  if (tee) pieces.push(tee[1]);
  const copyLike = p.match(/(?:^|[\s;&|])(cp|mv|ln|rsync|git mv|git rm)\s+(.+)$/);
  if (copyLike) {
    const args = copyLike[2].split(/\s+/).filter((a) => !a.startsWith("-"));
    if (args.length >= 2) pieces.push(args[args.length - 1]);           // destination
    if (/^(mv|git mv|git rm)$/.test(copyLike[1])) pieces.push(...args.slice(0, -1)); // moving/removing a protected file is a write to it
    if (copyLike[1] === "git rm") pieces.push(...args);
  }
  if (/(^|[\s;&|])(rm|sed -i|sed --in-place|chmod|chown|truncate|shred|unlink|mkdir|touch|git checkout|git restore|node -e|python3? -c|perl -)(\s|$)/.test(p)) pieces.push(p); // whole command: any mentioned path may be written
  if (!pieces.length) return undefined;
  return pieces.join(" ");
}

/* ============================ write-guard ============================ */

export function decideWriteGuard(input: HookInput, root: string, policy: CompiledPolicy): Decision {
  const ti = input.tool_input ?? {};
  const fp = String(ti.file_path ?? ti.notebook_path ?? ti.path ?? "");
  if (!fp) return { allow: true };
  const abs = path.isAbsolute(fp) ? fp : path.resolve(input.cwd || root, fp);
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  const ticket = ticketForSession(root, input.session_id);
  const deny = (why: string): Decision => {
    appendEvent(root, ticket, "write.denied", { path: rel }, input.agent_type);
    return { deny: `${why} (path: ${rel})` };
  };
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // outside the project: allow only /tmp-style scratch; deny home dotfiles and the engine home
    if (abs.startsWith(policy.engine_home) || /[/\\]\.sf(dx)?[/\\]|[/\\]\.claude[/\\]/.test(abs) || /[/\\]\.sfsmiths[/\\]/.test(abs)) return deny("outside-project write to a keychain/settings location");
    return { allow: true };
  }
  // role-scoped exceptions (the only agents allowed under docs/ or knowledge/):
  //   a0-cartographer maintains the org map (docs/org-map/**)
  //   a7-coach files lesson CANDIDATES (knowledge/lessons/PENDING/**) and memory audits — never approved lessons (L-*.md), never INDEX
  if (rel.startsWith("docs/org-map/") && input.agent_type === "a0-cartographer") return { allow: true };
  if (input.agent_type === "a7-coach" && (rel.startsWith("knowledge/lessons/PENDING/") || /^knowledge\/lessons\/MEMORY-AUDIT-[\w.-]+\.md$/.test(rel))) return { allow: true };
  // protected first
  for (const prot of policy.protected_paths) if (rel === prot.replace(/\/$/, "") || rel.startsWith(prot)) return deny(`agents may not edit ${prot}`);
  if (/^work\/[^/]+\/(manifest\.yaml|\.state\.json|events\.jsonl|rewards\.jsonl|validations\/|approvals\/)/.test(rel)) return deny("ticket state is written by the toolkit only");
  if (rel.startsWith("work/") && ticket) {
    const m = rel.match(/^work\/([^/]+)\//);
    if (m && m[1] !== ticket && m[1] !== ".sessions") return deny(`this session works on ${ticket}; writing another ticket's vault is not allowed`);
  }
  if (rel.startsWith(".claude/agent-memory/")) {
    const m = rel.match(/^\.claude\/agent-memory\/([^/]+)\//);
    if (input.agent_type && m && m[1] !== input.agent_type) return deny(`agent ${input.agent_type} may only write its own memory (.claude/agent-memory/${input.agent_type}/)`);
    return { allow: true };
  }
  if (policy.agent_write_areas.some((a) => rel.startsWith(a))) return { allow: true };
  return deny("outside the agent write areas (org/force-app, tests-ui, work/<ticket>, inbox, spikes, own agent-memory)");
}

/* ============================ data-guard (P9 layer 2 for MCP tools) ============================ */

// @salesforce/mcp 0.30.x tool names: deploy_metadata (write), run_soql_query (read), run_apex_test (tests never deliver mail → exempt),
// plus anything a future toolset adds that smells like a write. Unknown = require canary (fail-closed on side effects).
const DATA_TOOL_RE = /^mcp__sf-dev__(?!run_apex_test$)(?!run_soql_query$)(?!retrieve_metadata$)(?!deploy_metadata$)(?!get_username$)(?!list_all_orgs$)(?!resume_tool_operation$)(?!query_code_analyzer_results$)(?!list_code_analyzer_rules$)(?!describe_code_analyzer_rule$)(?!run_code_analyzer$).*(create|update|delete|upsert|insert|run_apex|execute|anonymous|dml|import|bulk|assign)/i;

export function decideDataGuard(input: HookInput, root: string, policy: CompiledPolicy): Decision {
  const tool = String(input.tool_name ?? "");
  if (!DATA_TOOL_RE.test(tool) || !policy.require_canary) return { allow: true };
  const ticket = ticketForSession(root, input.session_id);
  const dir = path.join(root, ".sfsmiths", "canary");
  let best: { at: string; result: string; detail: string; org: string } | undefined;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const alias = f.replace(/\.json$/, "").toLowerCase();
      if (!policy.dev_aliases.includes(alias)) continue;
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { at: string; result: string; detail: string; org: string };
      if (!best || new Date(c.at).getTime() > new Date(best.at).getTime()) best = c; // freshest wins
    }
  } catch { /* no canary dir */ }
  const deny = (why: string): Decision => {
    appendEvent(root, ticket, "email_guard.blocked", { tool, why }, input.agent_type);
    return { deny: `${why} — run \`sfsmiths agent canary --org <dev alias>\` first (P9: prove deliverability is off before creating data)` };
  };
  if (!best) return deny("no email canary result for the development org");
  if (best.result !== "pass") return deny(`last canary on ${best.org} was ${best.result.toUpperCase()}: ${best.detail}`);
  const ageMin = (Date.now() - new Date(best.at).getTime()) / 60_000;
  if (ageMin > policy.canary_max_age_minutes) return deny(`canary on ${best.org} is ${Math.round(ageMin)} min old (max ${policy.canary_max_age_minutes})`);
  return { allow: true };
}
