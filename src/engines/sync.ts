/**
 * sync.ts — config → generated files. Run after any config change (UI does it automatically).
 *   config/models.yaml   → .claude/agents/*.md  (model: line)
 *   config/orgs.yaml     → .mcp.json (sf-dev bound to the development alias only), .sfsmiths/policy.compiled.json, .claude/settings.local.json (alias + keychain denies)
 *   config/policy.yaml   → .sfsmiths/policy.compiled.json (fast hooks read this)
 *   knowledge/lessons    → .claude/skills/lessons-<agent>/SKILL.md (via learnSync)
 * Changes take effect in the NEXT Claude Code session (agents/MCP servers load at start).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, devOrg, preprodOrg, evidenceOrg, type AllConfig } from "../core/config.js";
import { homePaths, projectPaths, type ProjectPaths } from "../core/paths.js";
import { AGENT_NAMES } from "../core/state-machine.js";
import { exists, nowIso, readText, writeJsonAtomic, writeTextAtomic } from "../core/util.js";
import { DEFAULT_POLICY } from "../hooks/fast.js";
import { learnSync } from "./learn.js";

export const SF_MCP_VERSION = "0.30.15"; // verified on npm 2026-09-05; bump deliberately, never `latest`
export const SF_MCP_TOOLSETS = "orgs,data,metadata,testing,code-analysis";

export interface SyncResult { agents_updated: string[]; mcp_written: boolean; policy_written: boolean; skills: string[]; warnings: string[] }

export function syncAll(p: ProjectPaths = projectPaths(), opts: { skipSkills?: boolean; keychainDenies?: boolean } = {}): SyncResult {
  const cfg = loadConfig(p, { fresh: true });
  const warnings: string[] = [];
  const agents_updated = syncAgentModels(p, cfg, warnings);
  const mcp_written = writeMcpJson(p, cfg, warnings);
  const policy_written = writeCompiledPolicy(p, cfg);
  syncSettingsDenies(p, cfg, warnings);
  if (opts.keychainDenies) syncKeychainDenies(p, cfg, warnings);
  const skills = opts.skipSkills ? [] : learnSync(p);
  if (!exists(path.join(p.claude, "settings.json"))) warnings.push(".claude/settings.json missing — hooks are not wired");
  else {
    // parse, don't grep: the command strings carry escaped quotes in the file
    let commands = "";
    try {
      const settings = JSON.parse(readText(path.join(p.claude, "settings.json"))) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
      commands = Object.values(settings.hooks ?? {}).flat().flatMap((h) => h.hooks ?? []).map((h) => h.command ?? "").join("\n");
    } catch { warnings.push(".claude/settings.json is not valid JSON"); }
    for (const h of ["agent-gate", "policy", "write-guard", "data-guard", "prompt-router", "stage-gate", "stop-guard", "tokens"]) if (!new RegExp(`sfsmiths-hook"? ${h}(\\s|$)`).test(commands)) warnings.push(`.claude/settings.json does not wire hook "${h}"`);
  }
  return { agents_updated, mcp_written, policy_written, skills, warnings };
}

export function syncAgentModels(p: ProjectPaths, cfg: AllConfig, warnings: string[]): string[] {
  const updated: string[] = [];
  for (const agent of AGENT_NAMES) {
    const f = path.join(p.agents, `${agent}.md`);
    if (!exists(f)) { warnings.push(`agent file missing: .claude/agents/${agent}.md`); continue; }
    const model = cfg.models.agents[agent] ?? cfg.models.fallback ?? "sonnet";
    const txt = readText(f);
    const m = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!m) { warnings.push(`${agent}.md has no frontmatter`); continue; }
    let fm = m[1];
    if (/^model:\s*.*$/m.test(fm)) fm = fm.replace(/^model:\s*.*$/m, `model: ${model}`);
    else fm += `\nmodel: ${model}`;
    const next = txt.replace(m[0], `---\n${fm}\n---`);
    if (next !== txt) { writeTextAtomic(f, next); updated.push(`${agent} → ${model}`); }
  }
  return updated;
}

export function writeMcpJson(p: ProjectPaths, cfg: AllConfig, warnings: string[]): boolean {
  const dev = devOrg(cfg);
  const hp = homePaths();
  // installed copy first (the launcher IS the command: a sh/.cmd script that execs node on the installed JS);
  // fallback to the repo's bin/*.js run with node (fresh clone before install:toolkit)
  const server = (name: string): { command: string; args: string[] } => {
    const installedJs = path.join(hp.toolkit, "node_modules", "sfsmiths", "bin", `${name}.js`);
    if (exists(installedJs)) return { command: "node", args: [installedJs] };
    warnings.push(`installed toolkit not found (${installedJs}) — using repo bin/ for ${name}; run \`npm run install:toolkit\``);
    return { command: "node", args: [path.join(p.root, "bin", `${name}.js`)] };
  };
  const mcp = {
    mcpServers: {
      "sf-dev": {
        type: "stdio",
        command: "npx",
        args: ["-y", `@salesforce/mcp@${SF_MCP_VERSION}`, "--orgs", dev.alias, "--toolsets", SF_MCP_TOOLSETS, "--no-telemetry"],
      },
      "sfsmiths-evidence": { type: "stdio", ...server("sfsmiths-mcp-evidence"), env: { SFSMITHS_PROJECT_DIR: "${CLAUDE_PROJECT_DIR:-.}" } },
      "sfsmiths-ui": { type: "stdio", ...server("sfsmiths-mcp-ui"), env: { SFSMITHS_PROJECT_DIR: "${CLAUDE_PROJECT_DIR:-.}" } },
    },
    _sfsmiths: { generated_at: nowIso(), note: "generated by sfsmiths-human sync from config/orgs.yaml — preprod has NO MCP server (engine-only); production only via sfsmiths-evidence (masked)" },
  };
  writeJsonAtomic(path.join(p.root, ".mcp.json"), mcp);
  return true;
}

export function writeCompiledPolicy(p: ProjectPaths, cfg: AllConfig): boolean {
  const lower = (s: string) => s.toLowerCase();
  const dev = [...new Set([...cfg.orgs.orgs.filter((o) => o.role === "development").map((o) => lower(o.alias)), ...(cfg.policy.allowed_deploy_targets ?? []).map(lower)])]
    .filter((a) => !cfg.orgs.orgs.some((o) => o.role !== "development" && lower(o.alias) === a)); // a non-dev alias can never be a deploy target
  const pre = cfg.orgs.orgs.filter((o) => o.role === "preprod").map((o) => lower(o.alias));
  const ev = cfg.orgs.orgs.filter((o) => o.role === "evidence").map((o) => lower(o.alias));
  const aliasMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.policy.alias_map)) aliasMap[k] = v;
  for (const o of cfg.orgs.orgs) { if (o.readonly_user) aliasMap[o.readonly_user] = o.alias; if (o.instance_url) aliasMap[o.instance_url] = o.alias; }
  const compiled = {
    ...DEFAULT_POLICY,
    compiled_at: nowIso(),
    dev_aliases: dev.length ? dev : DEFAULT_POLICY.dev_aliases,
    preprod_aliases: [...new Set([...pre, ...DEFAULT_POLICY.preprod_aliases])],
    evidence_aliases: [...new Set([...ev, ...DEFAULT_POLICY.evidence_aliases])],
    alias_map: aliasMap,
    bluecanvas_patterns: cfg.policy.bluecanvas_remote_patterns.length ? cfg.policy.bluecanvas_remote_patterns.map(lower) : DEFAULT_POLICY.bluecanvas_patterns,
    engine_home: homePaths().engineHome,
    canary_max_age_minutes: cfg.safety.canary_max_age_minutes,
    require_canary: cfg.safety.require_canary_before_data_stages,
  };
  writeJsonAtomic(path.join(p.state, "policy.compiled.json"), compiled);
  return true;
}

/**
 * Static permission denies for every configured NON-development alias (preprod + evidence) — belt to the policy hook's
 * braces: static rules apply even if a hook times out. They live in the gitignored .claude/settings.local.json (managed
 * block = entries matching SF_ALIAS_DENY_RE), so a user's aliases never reach git; .claude/settings.json ships static
 * `Production*` / `PartialUAT*` rules and is never rewritten by the toolkit.
 */
export const SF_ALIAS_DENY_RE = /^Bash\(sf (project deploy|project delete|data (query|create|update|delete|upsert|import|bulk|tree import)|apex run|org (open|delete)) \* (-o|--target-org) .+\)$/;
export function aliasDenyRules(cfg: AllConfig): string[] {
  const devNames = new Set(cfg.orgs.orgs.filter((o) => o.role === "development").map((o) => o.alias.toLowerCase()));
  const rules: string[] = [];
  for (const o of cfg.orgs.orgs) {
    if (o.role === "development" || devNames.has(o.alias.toLowerCase())) continue;
    for (const flag of ["-o", "--target-org"]) {
      for (const verb of ["project deploy", "data query", "apex run", "data create", "data update", "data delete", "data upsert", "data import"]) rules.push(`Bash(sf ${verb} * ${flag} ${o.alias}*)`);
    }
  }
  return rules;
}
export function syncSettingsDenies(p: ProjectPaths, cfg: AllConfig, warnings: string[]): boolean {
  return writeLocalDenyBlock(p, warnings, SF_ALIAS_DENY_RE, aliasDenyRules(cfg), "alias denies");
}

/** Replace one managed block (entries matching `re`) inside .claude/settings.local.json, keeping everything else. */
function writeLocalDenyBlock(p: ProjectPaths, warnings: string[], re: RegExp, rules: string[], what: string): boolean {
  const file = path.join(p.claude, "settings.local.json");
  let local: { permissions?: { deny?: string[]; allow?: string[] } } & Record<string, unknown> = {};
  if (exists(file)) { try { local = JSON.parse(readText(file)); } catch { warnings.push(`.claude/settings.local.json is not valid JSON — ${what} not written`); return false; } }
  const kept = (local.permissions?.deny ?? []).filter((r) => !re.test(r));
  local._sfsmiths = LOCAL_SETTINGS_NOTE;
  local.permissions = { ...(local.permissions ?? {}), deny: [...new Set([...kept, ...rules])] };
  const next = JSON.stringify(local, null, 2) + "\n";
  if (!exists(file) || next !== readText(file)) { fs.mkdirSync(p.claude, { recursive: true }); writeTextAtomic(file, next); return true; }
  return false;
}
export const LOCAL_SETTINGS_NOTE = "machine-specific, gitignored — managed blocks are rewritten by `sfsmiths-human sync`: deny rules for the configured preprod/evidence aliases and for every org in this machine's agent keychain that is not a configured development org (alias + username). Re-run sync after `sf org login/logout` or config changes.";

/**
 * Machine-specific static denies in .claude/settings.local.json (gitignored): every org the AGENT keychain knows that is
 * not a configured development org — by alias AND by username — is denied for any `sf` command. The policy hook (R7)
 * already refuses non-development targets; this is the static copy of the same rule for the case a hook times out.
 * Best effort: needs the sf CLI; skipped silently when it is missing (tests, fresh machines).
 */
export const KEYCHAIN_DENY_RE = /^Bash\(sf \* (-o|--target-org)[ =]\S+\)$/;

export function keychainDenyRules(entries: { alias?: string; aliases?: string[]; username?: string }[], devAliases: string[]): { rules: string[]; targets: string[] } {
  const dev = new Set(devAliases.map((a) => a.toLowerCase()));
  const targets = new Set<string>();
  for (const e of entries) {
    const names = [e.alias, ...(e.aliases ?? []), e.username].filter((n): n is string => !!n && !/\s/.test(n));
    if (names.some((n) => dev.has(n.toLowerCase()))) continue; // a development org — the only org agents may target
    for (const n of names) targets.add(n);
  }
  const rules: string[] = [];
  for (const t of [...targets].sort()) for (const flag of ["-o", "--target-org"]) { rules.push(`Bash(sf * ${flag} ${t})`); rules.push(`Bash(sf * ${flag}=${t})`); }
  return { rules, targets: [...targets].sort() };
}

export function readAgentKeychainSync(): { alias?: string; aliases?: string[]; username?: string }[] | undefined {
  try {
    const out = execFileSync("sf", ["org", "list", "--all", "--json"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, SF_DISABLE_TELEMETRY: "true", SF_AUTOUPDATE_DISABLE: "true" } });
    const j = JSON.parse(out) as { result?: Record<string, { alias?: string; aliases?: string[]; username?: string }[] | undefined> };
    return Object.values(j.result ?? {}).flatMap((v) => (Array.isArray(v) ? v : []));
  } catch {
    return undefined;
  }
}

export function syncKeychainDenies(p: ProjectPaths, cfg: AllConfig, warnings: string[], entries?: { alias?: string; aliases?: string[]; username?: string }[]): { written: boolean; targets: string[] } {
  const list = entries ?? readAgentKeychainSync();
  if (!list) { warnings.push("sf org list unavailable — machine-specific keychain denies (.claude/settings.local.json) not refreshed"); return { written: false, targets: [] }; }
  const devAliases = cfg.orgs.orgs.filter((o) => o.role === "development").map((o) => o.alias);
  const { rules, targets } = keychainDenyRules(list, devAliases);
  const written = writeLocalDenyBlock(p, warnings, KEYCHAIN_DENY_RE, rules, "keychain denies");
  return { written, targets };
}

export function describeOrgs(cfg: AllConfig): string {
  return cfg.orgs.orgs.map((o) => `${o.alias} (${o.role}, ${o.keychain} keychain${o.write ? ", RW" : ", RO"})`).join(" · ");
}

export function orgRoles(cfg: AllConfig) {
  return { dev: devOrg(cfg), preprod: preprodOrg(cfg), evidence: evidenceOrg(cfg) };
}

export function ensureRuntimeDirs(p: ProjectPaths): void {
  for (const d of [p.work, p.state, p.metrics, path.join(p.state, "sessions"), path.join(p.state, "cache"), path.join(p.state, "canary"), p.baseline, path.join(p.knowledge, "lessons", "PENDING"), path.join(p.knowledge, "lessons", "RETIRED"), path.join(p.agentMemory)]) fs.mkdirSync(d, { recursive: true });
  for (const agent of AGENT_NAMES) {
    const f = path.join(p.agentMemory, agent, "MEMORY.md");
    if (!exists(f)) writeTextAtomic(f, `# ${agent} — notes (UNVERIFIED)\n\nThese are the agent's own notes. They are evidence for the coach, never rules. Approved lessons live in .claude/skills/lessons-${agent}/SKILL.md.\n`);
  }
}
