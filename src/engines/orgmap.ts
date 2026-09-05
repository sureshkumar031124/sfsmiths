/**
 * orgmap.ts — docs/org-map/: facts about YOUR orgs, generated from the development org (agent keychain).
 *   INDEX.md · ORG-FACTS.md · <Object>.md (fields) · dependency-graph.json (MetadataComponentDependency, Beta) ·
 *   CONVENTIONS.md draft (sampled comment/naming patterns — you review it once)
 */
import path from "node:path";
import { loadConfig, devOrg } from "../core/config.js";
import { projectPaths, type ProjectPaths } from "../core/paths.js";
import { describe, sf, soql, orgDisplay } from "../core/sf.js";
import { ensureDir, nowIso, readJsonOr, writeJsonAtomic, writeTextAtomic } from "../core/util.js";
import { cacheFreshen } from "../privileged/index.js";

export interface OrgMapResult { objects: string[]; dependencies: number; conventions_sampled: number; warnings: string[] }

const DEP_TYPES = ["ApexClass", "ApexTrigger", "Flow", "CustomField", "CustomObject", "ValidationRule", "Layout", "FlexiPage"];

export async function orgmapBuild(opts: { objects?: string[]; p?: ProjectPaths; log?: (s: string) => void } = {}): Promise<OrgMapResult> {
  const p = opts.p ?? projectPaths();
  const log = opts.log ?? (() => {});
  const cfg = loadConfig(p);
  const dev = devOrg(cfg);
  const dir = path.join(p.docs, "org-map");
  ensureDir(dir);
  const warnings: string[] = [];
  const objects = opts.objects?.length ? opts.objects : Object.keys(cfg.masking.objects);
  log(`refreshing oracle caches for ${objects.length} object(s)…`);
  const cache = await cacheFreshen({ objects, p });
  warnings.push(...cache.errors);
  // ORG-FACTS
  const disp = await orgDisplay(dev.alias, dev.keychain);
  const counts: Record<string, number> = {};
  for (const t of ["ApexClass", "ApexTrigger", "Flow", "CustomObject", "ValidationRule", "PermissionSet"]) counts[t] = readJsonOr<{ names?: string[] }>(path.join(p.state, "cache", "metadata", `${t}.json`), {}).names?.length ?? 0;
  writeTextAtomic(path.join(dir, "ORG-FACTS.md"), [`# ORG-FACTS — ${dev.alias} (development)`, ``, `Generated ${nowIso()} from the development org. Facts only; production facts come from sfsmiths-evidence (masked) when a ticket needs them.`, ``, `- API version: ${disp.data?.apiVersion ?? "?"}`, `- Org id: ${disp.data?.id ?? "?"} · instance: ${disp.data?.instanceUrl ?? "?"}`, ...Object.entries(counts).map(([t, n]) => `- ${t}: ${n}`), ``].join("\n"));
  // per-object pages from describe cache
  for (const o of objects) {
    const d = readJsonOr<{ fields?: Record<string, { type: string; createable?: boolean; updateable?: boolean; calculated?: boolean; custom?: boolean; picklist?: string[] }>; recordTypes?: string[] }>(path.join(p.state, "cache", "describe", `${o}.json`), {});
    if (!d.fields) continue;
    const rows = Object.entries(d.fields).sort(([a], [b]) => a.localeCompare(b)).map(([n, f]) => `| ${n} | ${f.type} | ${f.calculated ? "formula/rollup" : f.updateable ? "writable" : f.createable ? "create-only" : "read-only"} | ${f.custom ? "custom" : "std"} | ${f.picklist?.length ? f.picklist.slice(0, 12).join(", ") + (f.picklist.length > 12 ? " …" : "") : ""} |`);
    writeTextAtomic(path.join(dir, `${o}.md`), [`# ${o}`, ``, `Fields (${rows.length}) from describe on ${dev.alias}, ${nowIso()}. Record types: ${d.recordTypes?.join(", ") || "—"}`, ``, `| API name | Type | Writable | Custom | Picklist values |`, `|---|---|---|---|---|`, ...rows, ``].join("\n"));
  }
  // dependency graph (Tooling MetadataComponentDependency — Beta, 2000 rows/query)
  const graph = readJsonOr<Record<string, string[]>>(path.join(dir, "dependency-graph.json"), {});
  let deps = 0;
  for (const refType of DEP_TYPES) {
    const q = `SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentType = '${refType}'`;
    const r = await soql(q, dev.alias, { keychain: dev.keychain, tooling: true });
    if (!r.ok || !r.data) { warnings.push(`MetadataComponentDependency for ${refType}: ${r.error ?? "unavailable"} (Beta API — may be unavailable in this org)`); continue; }
    for (const rec of r.data.records) {
      const ref = `${rec.RefMetadataComponentType}:${rec.RefMetadataComponentName}`;
      const dep = `${rec.MetadataComponentType}:${rec.MetadataComponentName}`;
      (graph[ref] ??= []).includes(dep) || graph[ref].push(dep);
      deps++;
    }
    if (r.data.records.length >= 2000) warnings.push(`MetadataComponentDependency for ${refType} hit the 2000-row cap — graph may be partial`);
  }
  writeJsonAtomic(path.join(dir, "dependency-graph.json"), graph);
  // conventions sampling
  const sampled = await sampleConventions(p, dev.alias, dev.keychain, dir, warnings);
  writeTextAtomic(path.join(dir, "INDEX.md"), [`# org-map — index`, ``, `Generated ${nowIso()}. Files: ORG-FACTS.md · CONVENTIONS.md · dependency-graph.json · ${objects.map((o) => `${o}.md`).join(" · ")}`, ``, `Refresh: \`sfsmiths-human orgmap build\` (nightly recommended). Dependency graph feeds Baseline Sync scope expansion.`, ``].join("\n"));
  return { objects, dependencies: deps, conventions_sampled: sampled, warnings };
}

async function sampleConventions(p: ProjectPaths, alias: string, keychain: "agent" | "engine", dir: string, warnings: string[]): Promise<number> {
  const classes = await soql("SELECT Name, Body, LastModifiedDate FROM ApexClass WHERE NamespacePrefix = null AND Status = 'Active' ORDER BY LastModifiedDate DESC LIMIT 12", alias, { keychain, tooling: true });
  let sampled = 0;
  const headers: string[] = [];
  const suffixes: Record<string, number> = {};
  let methodDocRate = 0, methods = 0, documented = 0, modLog = 0;
  if (classes.ok && classes.data) {
    for (const c of classes.data.records) {
      const body = String(c.Body ?? "");
      const name = String(c.Name ?? "");
      if (!body) continue;
      sampled++;
      const h = body.match(/^\s*(\/\*[\s\S]*?\*\/)/);
      if (h) headers.push(`// ${name}\n${h[1].split("\n").slice(0, 12).join("\n")}`);
      for (const m of body.matchAll(/(public|global)\s+[^;{]*?\(\s*[^)]*\)\s*\{/g)) { methods++; const before = body.slice(Math.max(0, (m.index ?? 0) - 400), m.index); if (/\*\/\s*$/.test(before.trimEnd()) || /\/\/[^\n]*\n\s*$/.test(before)) documented++; }
      if (/\b(Modified|Modification|Change|History)\b.*\n.*\d{4}/i.test(body.slice(0, 2000)) || /@(modified|changelog|history)/i.test(body.slice(0, 2000))) modLog++;
      const suf = name.match(/(Handler|Service|Selector|Controller|Batch|Schedulable|Queueable|Helper|Util|Utils|Test|Trigger|Wrapper|Domain|Factory)$/)?.[1];
      if (suf) suffixes[suf] = (suffixes[suf] ?? 0) + 1;
    }
    methodDocRate = methods ? Math.round((100 * documented) / methods) : 0;
  } else warnings.push(`conventions sampling: ApexClass Body not readable (${classes.error ?? "unavailable"})`);
  const fields = await soql("SELECT QualifiedApiName, Description, EntityDefinition.QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Case' AND QualifiedApiName LIKE '%__c'", alias, { keychain, tooling: true });
  const fieldDescRate = fields.ok && fields.data?.records.length ? Math.round((100 * fields.data.records.filter((r) => r.Description).length) / fields.data.records.length) : undefined;
  const flows = await soql("SELECT DeveloperName FROM FlowDefinition WHERE NamespacePrefix = null ORDER BY LastModifiedDate DESC LIMIT 8", alias, { keychain, tooling: true });
  const flowNames = flows.ok ? (flows.data?.records.map((r) => String(r.DeveloperName)) ?? []) : [];
  writeTextAtomic(path.join(dir, "CONVENTIONS.md"), [
    `# CONVENTIONS — sampled from ${alias} on ${nowIso()} (DRAFT — review once, then \`sfsmiths-human conventions build\`)`, ``,
    `## Apex header comment (observed in ${headers.length}/${sampled} recent classes)`, ``, "```apex", ...(headers.slice(0, 3).length ? headers.slice(0, 3) : ["// no header comments observed — decide a standard here (ApexDoc recommended: /** @description @author @date */)"]), "```", ``,
    `## Method documentation`, `- ${methodDocRate}% of public/global methods carry a doc comment (${documented}/${methods}). Standard: every public method gets one.`, ``,
    `## Modification log`, `- ${modLog}/${sampled} classes carry a modification/history log. Standard: one line per change with the ticket key, e.g. \`// 2026-09-05 SFS-1234 <what changed>\`.`, ``,
    `## Naming patterns (class suffixes observed)`, ...(Object.keys(suffixes).length ? Object.entries(suffixes).sort((a, b) => b[1] - a[1]).map(([s, n]) => `- *${s}: ${n}`) : ["- none observed"]), ``,
    `## Flow naming (recent)`, ...(flowNames.length ? flowNames.map((f) => `- ${f}`) : ["- none readable"]), ``,
    `## Field descriptions`, `- ${fieldDescRate === undefined ? "n/a" : `${fieldDescRate}% of custom Case fields have a description`}. Standard: every custom field/flow/VR gets a description (comment-lint checks it).`, ``,
    `## Your decisions (edit here)`, `- header format:`, `- modification log line format:`, `- class/flow/field naming:`, `- what must never appear in comments:`, ``,
  ].join("\n"));
  return sampled;
}

export async function sobjectList(alias: string, keychain: "agent" | "engine"): Promise<string[]> {
  const r = await sf<string[]>(["sobject", "list", "--sobject", "custom", "--target-org", alias], { keychain, timeoutMs: 120_000 });
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

export { describe as _describe };
