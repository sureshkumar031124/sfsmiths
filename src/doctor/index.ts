/**
 * doctor — boot conditions (Part 11 §10.1 L-E). FAIL = the system refuses to start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryLoadConfig, type AllConfig, type OrgConfig } from "../core/config.js";
import { homePaths, projectPaths, packageRoot, type ProjectPaths } from "../core/paths.js";
import { orgList, orgDisplay, soql, sfVersion, type OrgListEntry } from "../core/sf.js";
import { remotes } from "../core/git.js";
import { run, which } from "../core/shell.js";
import { exists, readJsonOr, readText } from "../core/util.js";
import { runCanary } from "../privileged/index.js";
import { evidenceDescribe } from "../engines/evidence/query.js";
import { SF_MCP_VERSION, keychainDenyRules, KEYCHAIN_DENY_RE } from "../engines/sync.js";

export type Level = "ok" | "warn" | "fail" | "skip";
export interface Check { id: string; title: string; level: Level; detail: string }

export interface DoctorOptions { p1?: boolean; emailCanary?: boolean; hooksLatency?: boolean; fls?: boolean; quick?: boolean; p?: ProjectPaths }

export async function doctor(opts: DoctorOptions = {}): Promise<{ checks: Check[]; ok: boolean }> {
  const p = opts.p ?? projectPaths();
  const checks: Check[] = [];
  const add = (id: string, title: string, level: Level, detail: string) => checks.push({ id, title, level, detail });

  // 1 config
  const { cfg: partial, errors } = tryLoadConfig(p);
  const cfgErrors = Object.entries(errors);
  add("1", "config/*.yaml load + validate", cfgErrors.length ? "fail" : "ok", cfgErrors.length ? cfgErrors.map(([k, v]) => `${k}: ${v.split("\n")[0]}`).join(" | ") : "14 files valid");
  const cfg = partial as AllConfig;
  const dev = cfg.orgs?.orgs.find((o) => o.role === "development");
  const pre = cfg.orgs?.orgs.find((o) => o.role === "preprod");
  const ev = cfg.orgs?.orgs.find((o) => o.role === "evidence");

  // 2 tools
  const sfv = await sfVersion();
  add("2a", "Salesforce CLI (sf)", sfv ? "ok" : "fail", sfv ?? "not found — npm i -g @salesforce/cli");
  add("2b", "Node.js", Number(process.versions.node.split(".")[0]) >= 20 ? "ok" : "fail", `node ${process.versions.node} (need ≥ 20.10)`);
  add("2c", "git", (await which("git")) ? "ok" : "fail", (await which("git")) ?? "not found");
  for (const tool of ["python3", "jq"]) add(`2d-${tool}`, `${tool} (needed by the sf-skills plugin scripts)`, (await which(tool)) ? "ok" : "warn", (await which(tool)) ?? "not found — plugin hooks/skills will degrade");
  const ca = await run("sf", ["plugins"], { timeoutMs: 60_000 });
  const plugins = parseSfPlugins(ca.stdout);
  add("2e", "sf plugins: code-analyzer + plugin-flow", plugins.codeAnalyzer && plugins.flow ? "ok" : "warn", ca.code === 0 ? [plugins.codeAnalyzer ? `code-analyzer ${plugins.codeAnalyzer}` : "code-analyzer missing (sf plugins install code-analyzer)", plugins.flow ? `flow ${plugins.flow}` : "plugin-flow missing (sf plugins install @salesforce/plugin-flow)"].join("; ") : "could not list plugins");
  if (process.env.SFDX_AUTO_DEPLOY === "1") add("2f", "SFDX_AUTO_DEPLOY", "fail", "SFDX_AUTO_DEPLOY=1 makes the sf-skills plugin auto-deploy on every edit — unset it (deploys must be explicit sfsmiths steps)");

  // 2g default target-org: agents' bare `sf` commands would hit it — it must be unset or the development org
  if (sfv && cfg.orgs) {
    const r = await run("sf", ["config", "get", "target-org", "--json"], { timeoutMs: 20_000 });
    const val = (() => { try { const j = JSON.parse(r.stdout) as { result?: { value?: string }[] }; return j.result?.[0]?.value; } catch { return undefined; } })();
    const devAliases = cfg.orgs.orgs.filter((o) => o.role === "development").map((o) => o.alias.toLowerCase());
    add("2g", "default sf target-org is unset or the development org", !val || devAliases.includes(String(val).toLowerCase()) ? "ok" : "fail", val ? `target-org = ${val}${devAliases.includes(String(val).toLowerCase()) ? "" : " — run: sf config unset target-org (agents must always name the org explicitly)"}` : "unset");
  }

  // 3/4 keychains
  let agentOrgs: OrgListEntry[] = [];
  let engineOrgs: OrgListEntry[] = [];
  if (sfv && cfg.orgs) {
    const a = await orgList("agent");
    agentOrgs = a.data ?? [];
    add("3a", "AGENT keychain lists the development org", dev && agentOrgs.some((o) => matchAlias(o, dev)) ? "ok" : "fail", dev ? (agentOrgs.some((o) => matchAlias(o, dev)) ? `${dev.alias} present` : `${dev.alias} missing — sfsmiths-human org login --keychain agent --alias ${dev.alias} --role development`) : "no development org in config");
    if (ev) add("3b", "AGENT keychain lists the evidence (production) org", agentOrgs.some((o) => matchAlias(o, ev)) ? "ok" : "fail", agentOrgs.some((o) => matchAlias(o, ev)) ? `${ev.alias} present` : `${ev.alias} missing — log in with the READ-ONLY user`);
    if (pre) {
      const leak = agentOrgs.find((o) => matchAlias(o, pre));
      add("3c", "P1c: preprod is NOT in the AGENT keychain", leak ? "fail" : "ok", leak ? `${pre.alias} (${leak.username}) is in the agent keychain — remove it: sf org logout -o ${pre.alias}` : "preprod auth is engine-only");
      const e = await orgList("engine");
      engineOrgs = e.data ?? [];
      add("4a", "ENGINE keychain lists preprod", engineOrgs.some((o) => matchAlias(o, pre)) ? "ok" : "fail", engineOrgs.some((o) => matchAlias(o, pre)) ? `${pre.alias} present in ${homePaths().engineHome}` : `${pre.alias} missing — sfsmiths-human org login --keychain engine --alias ${pre.alias} --role preprod`);
      const extra = engineOrgs.filter((o) => !matchAlias(o, pre));
      if (extra.length) add("4b", "ENGINE keychain holds only preprod", "warn", `also has: ${extra.map((o) => o.alias ?? o.username).join(", ")} — keep the engine keychain minimal`);
    } else add("3c", "preprod org", "warn", "no preprod org configured — baseline sync and preprod QA are skipped (flag no_preprod)");
    // 6 admin prod login leak (live: sf org display may refresh a token → skipped in quick mode)
    if (ev && opts.quick) add("6", "No second (admin) production login in the AGENT keychain", "skip", "quick mode — run `sfsmiths-human doctor` (without --quick) for live org checks");
    if (ev && !opts.quick) {
      const evDisp = await orgDisplay(ev.alias, ev.keychain);
      const evHost = evDisp.data?.instanceUrl ? new URL(evDisp.data.instanceUrl).host : undefined;
      const others = agentOrgs.filter((o) => o.instanceUrl && evHost && new URL(o.instanceUrl).host === evHost && !matchAlias(o, ev));
      add("6", "No second (admin) production login in the AGENT keychain", others.length ? "fail" : "ok", others.length ? `${others.map((o) => o.username).join(", ")} also point at ${evHost} — log them out of this machine's default keychain (use another OS user/machine for admin work)` : evHost ? `only ${ev.alias} points at ${evHost}` : "evidence org not reachable — cannot verify");
      if (ev.readonly_user && evDisp.data?.username && evDisp.data.username.toLowerCase() !== ev.readonly_user.toLowerCase()) add("6b", "Evidence alias uses the configured read-only user", "fail", `${ev.alias} is ${evDisp.data.username}, config says ${ev.readonly_user}`);
      // 5 P1 identity
      if (opts.p1 && evDisp.ok && evDisp.data?.username) {
        const u = await soql(`SELECT Id FROM User WHERE Username = '${evDisp.data.username.replace(/'/g, "")}'`, ev.alias, { keychain: ev.keychain });
        const uid = u.data?.records?.[0]?.Id as string | undefined;
        if (!uid) add("5", "P1 identity: read-only permissions", "fail", `could not resolve user id for ${evDisp.data.username}: ${u.error ?? "no rows"}`);
        else {
          const q = `SELECT Name, PermissionsModifyAllData, PermissionsModifyMetadata, PermissionsAuthorApex, PermissionsCustomizeApplication, PermissionsViewSetup FROM PermissionSet WHERE Id IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${uid}')`;
          const r = await soql(q, ev.alias, { keychain: ev.keychain });
          if (!r.ok || !r.data) add("5", "P1 identity: read-only permissions", "fail", `permission query failed: ${r.error}`);
          else {
            const bad = r.data.records.filter((x) => x.PermissionsModifyAllData || x.PermissionsModifyMetadata || x.PermissionsAuthorApex || x.PermissionsCustomizeApplication);
            const viewSetup = r.data.records.some((x) => x.PermissionsViewSetup);
            add("5", "P1 identity: production user cannot Modify All Data / Modify Metadata / Author Apex / Customize Application", bad.length ? "fail" : "ok", bad.length ? `granted via: ${bad.map((x) => x.Name).join(", ")} — production is NOT read-only for this user` : `${r.data.records.length} permission set(s) checked, none grant write`);
            add("5b", "P1 identity: View Setup and Configuration (needed for Tooling/SetupAuditTrail facts)", viewSetup ? "ok" : "warn", viewSetup ? "granted" : "missing — prod metadata facts via Tooling will be limited");
          }
        }
      } else if (opts.p1) add("5", "P1 identity", "fail", `evidence org not reachable: ${evDisp.error ?? "unknown"}`);
    }
  }

  // 7 Blue Canvas remotes
  const rem = await remotes(p.root);
  const bc = rem.filter((r) => (cfg.policy?.bluecanvas_remote_patterns ?? ["bluecanvas"]).some((pat) => r.url.toLowerCase().includes(pat.toLowerCase())));
  add("7", "P1b: no Blue Canvas git remote in this repo", bc.length ? "fail" : "ok", bc.length ? `remove: ${bc.map((r) => `${r.name} → ${r.url}`).join(", ")}` : rem.length ? `${rem.length} remote(s), none Blue Canvas` : "no remotes");

  // 8 .mcp.json
  const mcp = readJsonOr<{ mcpServers?: Record<string, { args?: string[] }> }>(path.join(p.root, ".mcp.json"), {});
  const sfdev = mcp.mcpServers?.["sf-dev"];
  const orgsArg = sfdev?.args?.[sfdev.args.indexOf("--orgs") + 1];
  const badServers = Object.keys(mcp.mcpServers ?? {}).filter((k) => /uat|preprod|prod/i.test(k) && k !== "sfsmiths-evidence");
  add("8", ".mcp.json: sf-dev bound to the development org only, no preprod/prod servers", !sfdev ? "fail" : orgsArg !== dev?.alias || badServers.length ? "fail" : "ok", !sfdev ? "sf-dev server missing — run sfsmiths-human sync" : orgsArg !== dev?.alias ? `sf-dev --orgs is "${orgsArg}", expected "${dev?.alias}" — run sfsmiths-human sync` : badServers.length ? `remove servers: ${badServers.join(", ")}` : `sf-dev → ${orgsArg} (@salesforce/mcp ${sfdev.args?.find((a) => a.startsWith("@salesforce/mcp"))?.split("@").pop() ?? "?"}; pinned ${SF_MCP_VERSION})`);

  // 9 hooks + plugin + settings
  const settings = readJsonOr<{ hooks?: Record<string, unknown>; permissions?: { deny?: string[] } }>(path.join(p.claude, "settings.json"), {});
  const hooksOk = !!settings.hooks && ["PreToolUse", "SubagentStop", "Stop", "UserPromptSubmit", "PostToolUse", "SessionStart"].every((k) => k in (settings.hooks ?? {}));
  add("9a", ".claude/settings.json wires the SFsmiths hooks", hooksOk ? "ok" : "fail", hooksOk ? `${Object.keys(settings.hooks ?? {}).length} hook events` : "missing hook events — restore .claude/settings.json from the repo");
  add("9b", "static deny rules present", settings.permissions?.deny?.some((d) => d.includes("sfsmiths-human")) ? "ok" : "fail", settings.permissions?.deny?.length ? `${settings.permissions.deny.length} deny rules` : "no deny rules");
  const pluginDir = path.join(os.homedir(), ".claude", "plugins");
  const pluginFound = exists(pluginDir) && findDir(pluginDir, "salesforce-development", 4);
  add("9c", "sf-skills plugin (salesforce-development) installed", pluginFound ? "ok" : "warn", pluginFound ? pluginFound : "not found under ~/.claude/plugins — in Claude Code: /plugin marketplace add ./.claude-plugin  →  /plugin install salesforce-development@sfsmiths-pinned");
  const userSettings = readJsonOr<{ autoMemoryEnabled?: boolean }>(path.join(os.homedir(), ".claude", "settings.json"), {});
  add("9d", "autoMemoryEnabled (agent notes channel)", userSettings.autoMemoryEnabled === false ? "warn" : "ok", userSettings.autoMemoryEnabled === false ? "off — agent MEMORY.md notes will not load; approved lessons still inject via skills" : "on/default");
  const hp = homePaths();
  const installedPkg = readJsonOr<{ version?: string }>(path.join(hp.toolkit, "node_modules", "sfsmiths", "package.json"), {});
  const repoPkg = readJsonOr<{ version?: string }>(path.join(p.root, "package.json"), {});
  add("9e", "installed toolkit copy (~/.sfsmiths/bin) matches repo version", !installedPkg.version ? "fail" : installedPkg.version === repoPkg.version ? "ok" : "warn", !installedPkg.version ? `not installed — npm run install:toolkit (hooks call ${hp.bin})` : `installed ${installedPkg.version} · repo ${repoPkg.version}`);
  if (!exists(path.join(p.state, "policy.compiled.json"))) add("9f", "compiled policy for fast hooks", "warn", "missing — run sfsmiths-human sync (hooks fall back to built-in defaults)");
  // 9g machine-specific static denies: every non-development org in the agent keychain must be denied in settings.local.json
  if (sfv && cfg.orgs && agentOrgs.length) {
    const devAliases = cfg.orgs.orgs.filter((o) => o.role === "development").map((o) => o.alias);
    const want = keychainDenyRules(agentOrgs, devAliases);
    const local = readJsonOr<{ permissions?: { deny?: string[] } }>(path.join(p.claude, "settings.local.json"), {});
    const have = new Set((local.permissions?.deny ?? []).filter((r) => KEYCHAIN_DENY_RE.test(r)));
    const missing = want.rules.filter((r) => !have.has(r));
    add("9g", "static denies cover every non-development org in the AGENT keychain (.claude/settings.local.json)", want.targets.length === 0 ? "ok" : missing.length ? "warn" : "ok", want.targets.length === 0 ? "keychain holds only the development org" : missing.length ? `${missing.length} rule(s) missing for ${want.targets.join(", ")} — run sfsmiths-human sync` : `${want.targets.length} target(s) denied: ${want.targets.join(", ")}`);
  }

  // 10 canary
  if (opts.emailCanary && dev) {
    for (const o of [dev, pre].filter((x): x is OrgConfig => !!x)) {
      try { const st = await runCanary(o.alias, { p, cfg }); add(`10-${o.alias}`, `email canary on ${o.alias}`, st.result === "pass" ? "ok" : "fail", st.detail); }
      catch (e) { add(`10-${o.alias}`, `email canary on ${o.alias}`, "fail", (e as Error).message); }
    }
  } else if (dev) {
    const st = readJsonOr<{ at: string; result: string } | undefined>(path.join(p.state, "canary", `${dev.alias}.json`), undefined);
    add("10", "email canary (last result)", st?.result === "pass" ? "ok" : "warn", st ? `${st.result} at ${st.at}` : "never run — sfsmiths-human doctor --email-canary");
  }

  // 11 hooks latency
  if (opts.hooksLatency) {
    const hookBin = exists(path.join(hp.bin, "sfsmiths-hook")) ? path.join(hp.bin, "sfsmiths-hook") : path.join(p.root, "bin", "sfsmiths-hook.js");
    for (const h of ["agent-gate", "policy", "write-guard", "data-guard"]) {
      const input = JSON.stringify({ session_id: "doctor", cwd: p.root, hook_event_name: "PreToolUse", tool_name: h === "policy" ? "Bash" : h === "agent-gate" ? "Agent" : h === "data-guard" ? "mcp__sf-dev__run_soql_query" : "Edit", tool_input: h === "policy" ? { command: "ls" } : h === "agent-gate" ? { subagent_type: "a0-cartographer" } : { file_path: path.join(p.root, "org", "force-app", "x.cls") } });
      const r = await run(hookBin.endsWith(".js") ? "node" : hookBin, hookBin.endsWith(".js") ? [hookBin, h] : [h], { input, timeoutMs: 10_000, env: { CLAUDE_PROJECT_DIR: p.root } });
      add(`11-${h}`, `hook latency: ${h}`, r.durationMs < 300 ? "ok" : r.durationMs < 2000 ? "warn" : "fail", `${r.durationMs} ms (deny hooks must answer fast — a timed-out hook does not block)`);
    }
  }

  // 12 FLS / masking vs evidence describe
  if (opts.fls && ev && cfg.masking) {
    for (const [obj, m] of Object.entries(cfg.masking.objects)) {
      try {
        const d = await evidenceDescribe(obj, { cfg, p });
        const types = new Map(d.fields.map((f) => [f.name.toLowerCase(), f.type.toLowerCase()]));
        const missing = m.allow.filter((f) => !f.includes(".") && !types.has(f.toLowerCase()));
        const badType = m.allow.filter((f) => ["email", "phone"].includes(types.get(f.toLowerCase()) ?? ""));
        add(`12-${obj}`, `masking allowlist for ${obj} vs production describe`, badType.length ? "fail" : missing.length ? "warn" : "ok", badType.length ? `Email/Phone typed fields in allowlist: ${badType.join(", ")}` : missing.length ? `not visible to the read-only user (FLS?) or misspelled: ${missing.join(", ")}` : `${m.allow.length} fields ok`);
      } catch (e) { add(`12-${obj}`, `masking allowlist for ${obj}`, "warn", (e as Error).message); }
    }
  }

  // 13 oracle cache
  const cacheDir = path.join(p.state, "cache", "describe");
  add("13", "oracle cache (plan-lint/semantic-check)", exists(cacheDir) && fs.readdirSync(cacheDir).length ? "ok" : "warn", exists(cacheDir) && fs.readdirSync(cacheDir).length ? `${fs.readdirSync(cacheDir).length} object describe(s) cached` : "empty — a3-architect runs `sfsmiths agent cache freshen <KEY>` at plan time (or run it now)");
  add("14", "package schemas/templates present", exists(path.join(packageRoot(), "schemas", "manifest.schema.json")) ? "ok" : "fail", packageRoot());

  const ok = !checks.some((c) => c.level === "fail");
  return { checks, ok };
}

function matchAlias(o: OrgListEntry, cfgOrg: OrgConfig): boolean {
  const a = cfgOrg.alias.toLowerCase();
  return (o.alias ?? "").toLowerCase() === a || (o.aliases ?? []).some((x) => x.toLowerCase() === a) || (!!cfgOrg.readonly_user && (o.username ?? "").toLowerCase() === cfgOrg.readonly_user.toLowerCase());
}

function findDir(root: string, name: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const full = path.join(root, ent.name);
      if (ent.name === name) return full;
      const r = findDir(full, name, depth - 1);
      if (r) return r;
    }
  } catch { /* ignore */ }
  return undefined;
}

export function formatChecks(checks: Check[]): string {
  const icon = (l: Level) => (l === "ok" ? "✅" : l === "warn" ? "⚠️ " : l === "fail" ? "❌" : "·");
  return checks.map((c) => `${icon(c.level)} [${c.id}] ${c.title}\n     ${c.detail}`).join("\n");
}

export function readSettingsJsonSafe(p: ProjectPaths): unknown {
  try { return JSON.parse(readText(path.join(p.claude, "settings.json"))); } catch { return undefined; }
}

/** `sf plugins` lists installed plugins by short name (`flow 2.0.1`), then an "Uninstalled JIT Plugins" section that must not count. */
export function parseSfPlugins(stdout: string): { codeAnalyzer?: string; flow?: string } {
  const installed = stdout.split(/uninstalled jit plugins/i)[0] ?? "";
  const pick = (re: RegExp) => installed.match(re)?.[1];
  return {
    codeAnalyzer: pick(/^(?:@salesforce\/(?:plugin-)?)?code-analyzer\s+(\S+)/m),
    flow: pick(/^(?:@salesforce\/plugin-)?flow\s+(\S+)/m),
  };
}
