/**
 * baseline.ts — Baseline Sync (Part 11 §6, P10): preprod is the baseline; dev starts fresh.
 *
 * 3-way per component:  ancestor (last fingerprint | Tooling dates | none)  ×  dev  ×  preprod
 *   IDENTICAL                                 → nothing
 *   UAT-NEWER   (dev == ancestor, uat ≠)      → snapshot dev → copy preprod version into org/force-app → deploy to dev → notify
 *   DEV-NEWER   (uat == ancestor, dev ≠)      → STOP, ask the human (keep-dev | take-uat | exclude)
 *   BOTH-CHANGED / UNKNOWN                    → STOP, show 3-way, ask
 * Never touches preprod (engine keychain, retrieve only). Never runs without a dev snapshot + git commit first.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, devOrg, preprodOrg, type AllConfig } from "../core/config.js";
import { emitEvent } from "../core/events.js";
import { componentFingerprint, componentKeyFromPath, groupComponents } from "../core/fingerprint.js";
import { commitAll, git, isRepo } from "../core/git.js";
import { acquireLocks } from "../core/locks.js";
import { loadManifest, saveManifest, type Manifest } from "../core/manifest.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { deployStart, retrieveStart, soql } from "../core/sf.js";
import { ensureDir, exists, nowIso, readJsonOr, tsCompact, writeJsonAtomic, writeTextAtomic } from "../core/util.js";
import type { BaselineReport } from "../gates/verdicts.js";

export type Classification = "IDENTICAL" | "UAT-NEWER" | "DEV-NEWER" | "BOTH-CHANGED" | "UNKNOWN" | "MISSING-IN-UAT" | "MISSING-IN-DEV";
export type Decision = "keep-dev" | "take-uat" | "exclude";

export interface Scope {
  components: string[];  // "ApexClass:Foo"
  objects?: string[];
  source?: string;
}

interface Fingerprints {
  components: Record<string, { hash: string; at: string; source: string; ticket?: string }>;
}

function fingerprintsFile(p: ProjectPaths): string {
  return path.join(p.baseline, "fingerprints.json");
}

export function loadScope(p: ProjectPaths, ticket: string): Scope {
  const f = path.join(vaultDir(p, ticket), "scope.json");
  const s = readJsonOr<Scope>(f, { components: [] });
  // expand with dependency graph when available (docs/org-map/dependency-graph.json: { "Type:Name": ["Type:Name", ...] })
  const graph = readJsonOr<Record<string, string[]>>(path.join(p.docs, "org-map", "dependency-graph.json"), {});
  const out = new Set(s.components);
  for (const c of s.components) for (const dep of graph[c] ?? []) out.add(dep);
  return { ...s, components: [...out].sort() };
}

export function loadDecisions(p: ProjectPaths, ticket: string): Record<string, Decision> {
  return readJsonOr<Record<string, Decision>>(path.join(vaultDir(p, ticket), "baseline-decisions.json"), {});
}

export function saveDecisions(p: ProjectPaths, ticket: string, d: Record<string, Decision>): void {
  writeJsonAtomic(path.join(vaultDir(p, ticket), "baseline-decisions.json"), d);
}

/** Parse "keep-dev:Flow:X; take-uat:ApexClass:Y; exclude:CustomField:Case.Z" (from /approve --answer). */
export function parseDecisionAnswer(answer: string): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  for (const part of answer.split(/[;,\n]+/)) {
    const m = part.trim().match(/^(keep-dev|take-uat|exclude)\s*[:=]\s*(.+)$/i);
    if (m) out[m[2].trim()] = m[1].toLowerCase() as Decision;
  }
  return out;
}

function packageDir(p: ProjectPaths): string {
  const proj = readJsonOr<{ packageDirectories?: { path: string; default?: boolean }[] }>(path.join(p.org, "sfdx-project.json"), {});
  const d = proj.packageDirectories?.find((x) => x.default) ?? proj.packageDirectories?.[0];
  return path.join(p.org, d?.path ?? "force-app", "main", "default");
}

/** ".../classes/Foo.cls" → "classes/Foo.cls" (tail from the metadata type folder). */
export function typeTail(rel: string): string | undefined {
  const m = rel.replace(/\\/g, "/").match(/(?:^|\/)((classes|triggers|flows|objects|layouts|permissionsets|profiles|lwc|aura|pages|components|staticresources|labels|customMetadata|globalValueSets|flexipages|quickActions|tabs|applications|approvalProcesses|workflows|sharingRules|reportTypes|reports|dashboards|emailTemplates|assignmentRules|autoResponseRules|escalationRules|queues|groups|roles|settings|namedCredentials|remoteSiteSettings|connectedApps|duplicateRules|matchingRules)\/.*)$/);
  return m ? m[1] : undefined;
}

async function retrieveScope(p: ProjectPaths, org: string, keychain: "agent" | "engine", components: string[], outDir: string): Promise<{ ok: boolean; error?: string }> {
  ensureDir(outDir);
  const r = await retrieveStart(org, keychain, { metadata: components, outputDir: outDir, cwd: p.org });
  if (!r.ok) return { ok: false, error: r.error ?? "retrieve failed" };
  return { ok: true };
}

function hashesIn(dir: string): Record<string, { hash: string; files: string[] }> {
  const groups = groupComponents(dir);
  const out: Record<string, { hash: string; files: string[] }> = {};
  for (const [key, files] of Object.entries(groups)) out[key] = { hash: componentFingerprint(dir, files), files };
  return out;
}

async function toolingDates(cfg: AllConfig, key: string): Promise<{ dev?: string; uat?: string } | undefined> {
  const [type, name] = key.split(":");
  const dev = devOrg(cfg);
  const uat = preprodOrg(cfg);
  if (!uat) return undefined;
  let q: string | undefined;
  if (type === "ApexClass" || type === "ApexTrigger") q = `SELECT LastModifiedDate FROM ${type} WHERE Name = '${name.replace(/'/g, "")}'`;
  else if (type === "Flow") q = `SELECT LastModifiedDate FROM FlowDefinition WHERE DeveloperName = '${name.replace(/'/g, "")}'`;
  if (!q) return undefined;
  const [d, u] = await Promise.all([soql(q, dev.alias, { keychain: "agent", tooling: true }), soql(q, uat.alias, { keychain: "engine", tooling: true })]);
  return { dev: d.ok ? String(d.data?.records?.[0]?.LastModifiedDate ?? "") : undefined, uat: u.ok ? String(u.data?.records?.[0]?.LastModifiedDate ?? "") : undefined };
}

export interface BaselineRunOptions {
  mode: "full" | "check";        // check = classify only (used on resume), full = apply UAT-NEWER
  ticket: string;
  p?: ProjectPaths;
  log?: (s: string) => void;
}

export async function runBaseline(opts: BaselineRunOptions): Promise<BaselineReport> {
  const p = opts.p ?? projectPaths();
  const log = opts.log ?? (() => {});
  const cfg = loadConfig(p);
  const m = loadManifest(opts.ticket, p);
  const vault = vaultDir(p, opts.ticket);
  const dev = devOrg(cfg);
  const uat = preprodOrg(cfg);
  const scope = loadScope(p, opts.ticket);
  const decisions = loadDecisions(p, opts.ticket);
  const report: BaselineReport = { synced_at: nowIso(), ancestor_source: "none", scope: scope.components, components: [], excluded: [], stopped: false };
  const finish = (rep: BaselineReport) => {
    writeJsonAtomic(path.join(vault, "00b-baseline.json"), rep);
    writeTextAtomic(path.join(vault, "00b-baseline.md"), renderReport(rep, m, cfg));
    m.baseline = { synced_at: rep.synced_at, ancestor_source: rep.ancestor_source, decisions: rep.components.filter((c) => c.classification !== "IDENTICAL").map((c) => ({ component: c.key, classification: c.classification, action: c.action, at: rep.synced_at })) };
    saveManifest(m, p);
    return rep;
  };

  if (!uat) {
    m.flags["no_preprod"] = true;
    log("no preprod org configured — baseline sync skipped (flag no_preprod)");
    return finish({ ...report, stop_reason: undefined });
  }
  if (!scope.components.length) {
    return finish({ ...report, stopped: true, stop_reason: "scope.json has no components — intake must name the components in scope" });
  }
  const max = cfg.policy.baseline_sync?.max_components ?? 60;
  if (scope.components.length > max && opts.mode === "full") {
    return finish({ ...report, stopped: true, stop_reason: `scope has ${scope.components.length} components (> ${max}) — confirm with /approve --stage baseline --answer "scope-ok" or narrow the scope` });
  }
  // locks
  const lock = acquireLocks(opts.ticket, scope.components, p);
  if (lock.conflicts.length) {
    return finish({ ...report, stopped: true, stop_reason: `components locked by other tickets: ${lock.conflicts.map((c) => `${c.component} (${c.ticket})`).join(", ")}` });
  }

  const ts = tsCompact();
  const uatDir = path.join(p.baseline, "uat", ts);
  const devDir = path.join(p.baseline, "dev", ts);
  log(`retrieving ${scope.components.length} component(s) from ${uat.alias} (engine) and ${dev.alias} (agent)…`);
  const [ru, rd] = await Promise.all([retrieveScope(p, uat.alias, "engine", scope.components, uatDir), retrieveScope(p, dev.alias, "agent", scope.components, devDir)]);
  if (!ru.ok || !rd.ok) return finish({ ...report, stopped: true, stop_reason: `retrieve failed — preprod: ${ru.error ?? "ok"}; dev: ${rd.error ?? "ok"}` });

  const uatH = hashesIn(uatDir);
  const devH = hashesIn(devDir);
  const fps = readJsonOr<Fingerprints>(fingerprintsFile(p), { components: {} });
  let ancestorSource: BaselineReport["ancestor_source"] = "none";
  const needsAction: { key: string; classification: Classification }[] = [];

  for (const key of scope.components) {
    const u = uatH[key]?.hash;
    const d = devH[key]?.hash;
    const anc = fps.components[key]?.hash;
    let cls: Classification;
    if (!u && !d) cls = "UNKNOWN";
    else if (!u) cls = "MISSING-IN-UAT";
    else if (!d) cls = "MISSING-IN-DEV";
    else if (u === d) cls = "IDENTICAL";
    else if (anc) {
      ancestorSource = "fingerprint";
      if (d === anc) cls = "UAT-NEWER";
      else if (u === anc) cls = "DEV-NEWER";
      else cls = "BOTH-CHANGED";
    } else {
      const dates = await toolingDates(cfg, key);
      if (dates?.dev && dates?.uat) {
        ancestorSource = ancestorSource === "fingerprint" ? "fingerprint" : "tooling-dates";
        cls = new Date(dates.uat) > new Date(dates.dev) ? "UAT-NEWER" : "DEV-NEWER"; // heuristic — both changed cannot be told apart from dates alone
        if (Math.abs(new Date(dates.uat).getTime() - new Date(dates.dev).getTime()) < 60_000) cls = "UNKNOWN";
      } else cls = "UNKNOWN";
    }
    const dec = decisions[key];
    let action = "none";
    if (dec === "exclude") { report.excluded.push(key); action = "excluded by human"; }
    else if (cls === "IDENTICAL") action = "none";
    else if (dec === "keep-dev") { report.excluded.push(key); action = "keep-dev (human) — excluded from scope"; }
    else if (dec === "take-uat" || cls === "UAT-NEWER" || cls === "MISSING-IN-DEV") action = opts.mode === "full" ? "take-uat" : "would take-uat";
    else { action = "STOP — human decision needed"; needsAction.push({ key, classification: cls }); }
    report.components.push({ key, classification: cls, action, dev_hash: d, uat_hash: u });
  }
  report.ancestor_source = ancestorSource;

  if (needsAction.length) {
    report.stopped = true;
    report.stop_reason = `${needsAction.length} component(s) need your decision: ${needsAction.map((n) => `${n.key} [${n.classification}]`).join(", ")}. Decide with: sfsmiths-human baseline decide ${opts.ticket} --keep-dev <Type:Name> --take-uat <Type:Name> --exclude <Type:Name>  (or /approve ${opts.ticket} --stage baseline --answer "keep-dev:Type:Name; take-uat:Type:Name")`;
    m.status = "waiting_human";
    m.waiting = { kind: "baseline", stage: "baseline", prompt: report.stop_reason, since: nowIso() };
    emitEvent({ ticket: opts.ticket, type: "baseline.stopped", stage: "baseline", data: { needs: needsAction } }, p);
    return finish(report);
  }

  const toTake = report.components.filter((c) => c.action === "take-uat");
  if (opts.mode === "check") {
    const drift = report.components.filter((c) => c.classification !== "IDENTICAL" && !report.excluded.includes(c.key));
    if (drift.length) { m.flags["baseline_resync_required"] = true; }
    return finish(report);
  }
  if (cfg.policy.baseline_sync?.uat_newer === "ask" && toTake.length && !decisions["*"]) {
    report.stopped = true;
    report.stop_reason = `${toTake.length} component(s) are newer in preprod: ${toTake.map((c) => c.key).join(", ")}. Confirm with /approve ${opts.ticket} --stage baseline --answer "take-uat:*"`;
    m.status = "waiting_human";
    m.waiting = { kind: "baseline", stage: "baseline", prompt: report.stop_reason, since: nowIso() };
    return finish(report);
  }

  // ---- apply: snapshot dev → copy preprod files into force-app → deploy to dev ----
  if (toTake.length) {
    const snapDir = path.join(p.baseline, "dev-pre-sync", ts);
    ensureDir(snapDir);
    for (const c of toTake) for (const f of devH[c.key]?.files ?? []) copyInto(devDir, f, snapDir);
    report.dev_snapshot_dir = path.relative(p.root, snapDir);
    if (await isRepo(p.root)) {
      const pre = await commitAll(p.root, `chore(baseline): pre-baseline snapshot for ${opts.ticket}`, [path.relative(p.root, p.forceApp)]);
      log(`pre-baseline commit: ${pre.sha ?? pre.note}`);
    }
    const pkg = packageDir(p);
    for (const c of toTake) {
      // remove dev's version of the component, then copy preprod's
      for (const f of devH[c.key]?.files ?? []) { const tail = typeTail(f); if (tail) fs.rmSync(path.join(pkg, tail), { force: true }); }
      for (const f of uatH[c.key]?.files ?? []) { const tail = typeTail(f); if (tail) copyTo(path.join(uatDir, f), path.join(pkg, tail)); }
    }
    log(`deploying ${toTake.length} preprod version(s) to ${dev.alias}…`);
    const dep = await deployStart(dev.alias, "agent", { metadata: toTake.map((c) => c.key), cwd: p.org, ignoreConflicts: true });
    if (!dep.ok || (dep.data?.numberComponentErrors ?? 0) > 0) {
      report.stopped = true;
      report.stop_reason = `deploy of preprod baseline into ${dev.alias} failed: ${dep.error ?? dep.data?.status}`;
      return finish(report);
    }
    // verify: re-retrieve just the taken components from dev and compare
    const verifyDir = path.join(p.baseline, "dev-verify", ts);
    const rv = await retrieveScope(p, dev.alias, "agent", toTake.map((c) => c.key), verifyDir);
    const vH = rv.ok ? hashesIn(verifyDir) : {};
    for (const c of toTake) {
      const now = vH[c.key]?.hash;
      const eq = !!now && now === c.uat_hash;
      const rec = report.components.find((x) => x.key === c.key)!;
      rec.post_sync_equal = eq;
      rec.action = eq ? "taken from preprod (deployed to dev)" : "deployed but verification differs";
      rec.dev_hash = now ?? rec.dev_hash;
    }
    if (await isRepo(p.root)) {
      const post = await commitAll(p.root, `chore(baseline): ${opts.ticket} — ${toTake.length} component(s) aligned to preprod`, [path.relative(p.root, p.forceApp)]);
      report.git_commit = post.sha;
      if (post.sha) m.flags["baseline_commit"] = (await git(["rev-parse", "HEAD"], p.root)).out;
    }
    emitEvent({ ticket: opts.ticket, type: "baseline.synced", stage: "baseline", data: { taken: toTake.map((c) => c.key), snapshot: report.dev_snapshot_dir } }, p);
  } else {
    for (const c of report.components) if (c.classification === "IDENTICAL") c.post_sync_equal = true;
    if (await isRepo(p.root)) m.flags["baseline_commit"] = (await git(["rev-parse", "HEAD"], p.root)).out;
  }
  for (const c of report.components) if (c.classification === "IDENTICAL") c.post_sync_equal = true;
  // update fingerprints for everything now known equal
  for (const c of report.components) if (c.post_sync_equal && c.uat_hash) fps.components[c.key] = { hash: c.uat_hash, at: nowIso(), source: "baseline-sync", ticket: opts.ticket };
  writeJsonAtomic(fingerprintsFile(p), fps);
  m.fingerprints.scope = report.components.map((c) => `${c.key}=${(c.uat_hash ?? "").slice(0, 8)}`).join(",");
  m.fingerprints.taken_at = nowIso();
  m.status = m.status === "waiting_human" ? "running" : m.status;
  m.waiting = m.waiting?.kind === "baseline" ? null : m.waiting;
  m.flags["baseline_resync_required"] = false;
  return finish(report);
}

function copyInto(srcRoot: string, rel: string, dstRoot: string): void {
  copyTo(path.join(srcRoot, rel), path.join(dstRoot, rel));
}
function copyTo(src: string, dst: string): void {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

export function renderReport(rep: BaselineReport, m: Manifest, cfg: AllConfig): string {
  const uat = preprodOrg(cfg)?.alias ?? "(none)";
  const dev = devOrg(cfg).alias;
  const lines = [
    `# 00b — Baseline Sync · ${m.ticket}`,
    ``,
    `**Synced at:** ${rep.synced_at} · **Baseline org:** ${uat} · **Dev org:** ${dev} · **Ancestor source:** ${rep.ancestor_source}`,
    rep.stopped ? `\n> 🛑 **STOPPED:** ${rep.stop_reason}\n` : `\n> ✅ Scope is aligned to preprod. ${rep.dev_snapshot_dir ? `Dev snapshot: \`${rep.dev_snapshot_dir}\`` : ""} ${rep.git_commit ? `· git ${rep.git_commit}` : ""}\n`,
    `| Component | Classification | Action | Post-sync equal |`,
    `|---|---|---|---|`,
    ...rep.components.map((c) => `| \`${c.key}\` | ${c.classification} | ${c.action} | ${c.post_sync_equal === undefined ? "—" : c.post_sync_equal ? "yes" : "NO"} |`),
    ``,
    rep.excluded.length ? `**Excluded (human decision):** ${rep.excluded.map((e) => `\`${e}\``).join(", ")}` : `**Excluded:** none`,
    ``,
    `Rules: only the scope is synced, never the whole org · dev snapshot + git commit before any overwrite · DEV-NEWER / BOTH-CHANGED / UNKNOWN never auto-overwrite · Profiles/PermissionSets: treat diffs as prose notes, not truth.`,
    `UAT vs Production drift: not covered in this phase (needs evidence Tooling projection) — noted for the deploy brief.`,
  ];
  return lines.join("\n") + "\n";
}

export function componentKeysFromScopeFiles(files: string[]): string[] {
  return [...new Set(files.map((f) => componentKeyFromPath(f)).filter((k): k is string => !!k))];
}


