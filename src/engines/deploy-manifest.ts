/**
 * deploy-manifest.ts — D-100: the exact set of components a ticket changed, as the human's deploy tool wants it.
 *
 * Built from git, never from an agent's memory: `git diff --name-status <baseline_commit>` over org/force-app + tests-ui,
 * plus untracked files. Grouped into Salesforce component keys (Type:ApiName), hashed (normalised content), and written as
 *   work/<KEY>/06c-deploy-manifest.md    — the table the human ticks off in Blue Canvas (or any deploy tool)
 *   work/<KEY>/06c-deploy-manifest.json  — the same, machine-readable (the UAT parity check reads it)
 *   work/<KEY>/artifacts/package.xml      — Metadata API manifest for the added/modified components
 *   work/<KEY>/artifacts/destructiveChanges.xml — only when something was deleted
 * No LLM is involved; the reviewer (a6) triggers it and quotes it in the deploy brief.
 */
import fs from "node:fs";
import path from "node:path";
import { componentContentFingerprint, componentKeyFromPath } from "../core/fingerprint.js";
import { git } from "../core/git.js";
import { loadManifest } from "../core/manifest.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { exists, nowIso, readJsonOr, sha256, writeJsonAtomic, writeTextAtomic } from "../core/util.js";

export type ManifestAction = "added" | "modified" | "deleted";

export interface DeployManifestRow {
  key: string;            // "ApexClass:CaseEscalationOwnerService"
  type: string;           // "ApexClass"
  api_name: string;       // "CaseEscalationOwnerService"
  action: ManifestAction; // deleted → destructiveChanges.xml
  files: string[];        // repo-relative
  sha: string;            // normalised content fingerprint (path-independent) — "" for deleted
}

export interface DeployManifest {
  ticket: string;
  generated_at: string;
  baseline_commit?: string;
  api_version: string;
  components: DeployManifestRow[];
  files_hash: string;     // hash over the current content of every listed (non-deleted) file — parity/gates compare against it
  package_xml: string;    // repo-relative path
  destructive_xml?: string;
}

/** name-status of every changed source file relative to the ticket's baseline commit (or HEAD), plus untracked files. */
export async function changedFilesWithStatus(p: ProjectPaths, ticket?: string): Promise<{ file: string; action: ManifestAction }[]> {
  const roots = [path.relative(p.root, p.forceApp), "tests-ui"].filter((r) => exists(path.join(p.root, r)));
  const base = ticket ? (loadManifest(ticket, p).flags.baseline_commit as string | undefined) : undefined;
  const out = new Map<string, ManifestAction>();
  const mark = (status: string, file: string) => {
    if (!file) return;
    const a: ManifestAction = status.startsWith("D") ? "deleted" : status.startsWith("A") || status.startsWith("?") ? "added" : "modified";
    // a file both deleted and re-added in the range is "modified"
    if (out.has(file) && out.get(file) !== a) out.set(file, "modified"); else out.set(file, a);
  };
  for (const rel of roots) {
    const d = await git(["diff", "--name-status", base ?? "HEAD", "--", rel], p.root);
    if (d.ok) for (const line of d.out.split(/\r?\n/).filter(Boolean)) { const [st, ...rest] = line.split(/\t/); mark(st, rest[rest.length - 1]); }
    const s = await git(["diff", "--name-status", "--cached", "--", rel], p.root);
    if (s.ok) for (const line of s.out.split(/\r?\n/).filter(Boolean)) { const [st, ...rest] = line.split(/\t/); mark(st, rest[rest.length - 1]); }
    const u = await git(["ls-files", "--others", "--exclude-standard", "--", rel], p.root);
    if (u.ok) for (const f of u.out.split(/\r?\n/).filter(Boolean)) mark("?", f);
  }
  return [...out.entries()]
    .filter(([f, a]) => a === "deleted" ? !exists(path.join(p.root, f)) : exists(path.join(p.root, f)))
    .map(([file, action]) => ({ file, action }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function apiVersion(p: ProjectPaths): string {
  const proj = readJsonOr<{ sourceApiVersion?: string }>(path.join(p.org, "sfdx-project.json"), {});
  if (proj.sourceApiVersion) return proj.sourceApiVersion;
  const org = readJsonOr<{ apiVersion?: string }>(path.join(p.state, "cache", "org.json"), {});
  return org.apiVersion ?? "64.0";
}

/** Metadata API member name for a component key: "CustomField:Case.Foo__c" → { type: "CustomField", member: "Case.Foo__c" }. */
export function packageMember(key: string): { type: string; member: string } {
  const i = key.indexOf(":");
  return { type: key.slice(0, i), member: key.slice(i + 1) };
}

export function renderPackageXml(keys: string[], version: string): string {
  const byType = new Map<string, Set<string>>();
  for (const k of keys) { const { type, member } = packageMember(k); if (!byType.has(type)) byType.set(type, new Set()); byType.get(type)!.add(member); }
  const types = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, members]) =>
    `    <types>\n${[...members].sort().map((m) => `        <members>${escapeXml(m)}</members>`).join("\n")}\n        <name>${escapeXml(type)}</name>\n    </types>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types.join("\n")}${types.length ? "\n" : ""}    <version>${escapeXml(version)}</version>\n</Package>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The manifest's files_hash without writing anything — gates use it to tell whether a verdict is still current. */
export async function computeDeployFilesHash(p: ProjectPaths, ticket: string): Promise<string> {
  const changed = await changedFilesWithStatus(p, ticket);
  const live = changed.filter(({ file, action }) => action !== "deleted" && componentKeyFromPath(file) && exists(path.join(p.root, file))).map(({ file }) => file).sort();
  return sha256(live.map((f) => `${f}:${sha256(fs.readFileSync(path.join(p.root, f)))}`).join("\n"));
}

export async function buildDeployManifest(ticket: string, p: ProjectPaths = projectPaths()): Promise<DeployManifest> {
  const m = loadManifest(ticket, p);
  const vault = vaultDir(p, ticket);
  const changed = await changedFilesWithStatus(p, ticket);
  const groups = new Map<string, { files: string[]; actions: Set<ManifestAction> }>();
  for (const { file, action } of changed) {
    const key = componentKeyFromPath(file);
    if (!key) continue; // tests-ui specs and non-metadata files are listed in the md but are not deployable components
    if (!groups.has(key)) groups.set(key, { files: [], actions: new Set() });
    groups.get(key)!.files.push(file);
    groups.get(key)!.actions.add(action);
  }
  const rows: DeployManifestRow[] = [];
  for (const [key, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { type, member } = packageMember(key);
    const live = g.files.filter((f) => exists(path.join(p.root, f)));
    const action: ManifestAction = live.length === 0 ? "deleted" : g.actions.has("added") && !g.actions.has("modified") && g.actions.size === 1 ? "added" : "modified";
    rows.push({ key, type, api_name: member, action, files: g.files.sort(), sha: live.length ? componentContentFingerprint(p.root, live) : "" });
  }
  const files_hash = await computeDeployFilesHash(p, ticket);
  const version = apiVersion(p);
  const deployKeys = rows.filter((r) => r.action !== "deleted").map((r) => r.key);
  const deletedKeys = rows.filter((r) => r.action === "deleted").map((r) => r.key);
  const pkg = path.join(vault, "artifacts", "package.xml");
  writeTextAtomic(pkg, renderPackageXml(deployKeys, version));
  let destructive: string | undefined;
  if (deletedKeys.length) { destructive = path.join(vault, "artifacts", "destructiveChanges.xml"); writeTextAtomic(destructive, renderPackageXml(deletedKeys, version)); }
  const nonComponent = changed.filter(({ file }) => !componentKeyFromPath(file)).map(({ file, action }) => ({ file, action }));
  const out: DeployManifest = {
    ticket, generated_at: nowIso(), baseline_commit: m.flags.baseline_commit as string | undefined, api_version: version,
    components: rows, files_hash, package_xml: path.relative(p.root, pkg), destructive_xml: destructive ? path.relative(p.root, destructive) : undefined,
  };
  writeJsonAtomic(path.join(vault, "06c-deploy-manifest.json"), out);
  writeTextAtomic(path.join(vault, "06c-deploy-manifest.md"), renderManifestMd(out, nonComponent));
  return out;
}

function renderManifestMd(mf: DeployManifest, other: { file: string; action: ManifestAction }[]): string {
  const lines = [
    `# Deploy manifest — ${mf.ticket}`,
    ``,
    `_Generated ${mf.generated_at} by the toolkit from \`git diff${mf.baseline_commit ? ` ${mf.baseline_commit.slice(0, 7)}..` : ""}\` — no agent wrote this. Tick each row off in your deploy tool (Blue Canvas); the same list is checked against preprod after you deploy (uat_verify stage)._`,
    ``,
    `**${mf.components.length} component(s)** · API version ${mf.api_version} · \`${mf.package_xml}\`${mf.destructive_xml ? ` · destructive: \`${mf.destructive_xml}\`` : ""}`,
    ``,
    `| # | Type | API name | Action | Files | Fingerprint |`,
    `|---|---|---|---|---|---|`,
    ...mf.components.map((r, i) => `| ${i + 1} | ${r.type} | \`${r.api_name}\` | ${r.action} | ${r.files.map((f) => `\`${f}\``).join("<br>")} | \`${r.sha ? r.sha.slice(0, 12) : "—"}\` |`),
  ];
  if (other.length) {
    lines.push(``, `## Changed files that are not Salesforce components (not in package.xml)`, ``, ...other.map((o) => `- \`${o.file}\` (${o.action})`));
  }
  lines.push(``, `## How to use`, ``,
    `1. Open your deploy tool and select exactly these ${mf.components.length} component(s) — nothing more (the reviewer already confirmed nothing unplanned changed).`,
    `2. Deploy to preprod, then run \`sfsmiths-human deployed ${mf.ticket} --org preprod\`.`,
    `3. The toolkit retrieves the same components from preprod and compares fingerprints (\`07a-uat-parity.md\`). Anything MISSING or DIFFERENT comes back to you before QA runs.`,
    ``, `_Files hash: \`${mf.files_hash.slice(0, 16)}\` — if a source file changes after this manifest was generated, the parity check and the deploy-report gate notice._`, ``);
  return lines.join("\n");
}
