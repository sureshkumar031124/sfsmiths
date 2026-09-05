/**
 * plan-lint · semantic-check — the zero-hallucination gates (Part 11 §8).
 *
 * Oracle sets (L0/L1/L2), built by `sfsmiths agent cache freshen`:
 *   .sfsmiths/cache/describe/<Object>.json   (fields + properties)
 *   .sfsmiths/cache/metadata/<Type>.json     (component names per metadata type)
 *   org/force-app                            (local components)
 * No cache → `unavailable` (never pass on a guess).
 */
import { readVaultJson, loadDescribeCache, loadMetadataCache, cacheExists, localComponentIndex, extractApiTokensFromText, isStandardObject, type ApiRef } from "./helpers.js";
import { failed, passed, unavailable, type Gate, type GateContext } from "./types.js";
import { exists, readText } from "../core/util.js";
import path from "node:path";
import fs from "node:fs";

interface PlanLike {
  components?: { type: string; api_name: string; action?: "create" | "modify" | "delete" | "reference"; object?: string; evidence?: unknown }[];
  fields?: { object: string; api_name: string; action?: "create" | "modify" | "read" | "write"; evidence?: unknown }[];
  soql?: string[];
  flows?: { api_name: string; type?: string; trigger?: string; actions?: string[]; dml?: boolean; action?: string }[];
  api_version?: string;
  objects?: string[];
}

function planFile(ctx: GateContext): { rel: string; kind: "plan" | "repro" | "implementation" } {
  if (ctx.stage === "repro") return { rel: "02-repro.json", kind: "repro" };
  if (ctx.stage === "develop") return { rel: "04-implementation.json", kind: "implementation" };
  return { rel: "03-plan.json", kind: "plan" };
}

const METADATA_TYPE_MAP: Record<string, string> = {
  apexclass: "ApexClass", apextrigger: "ApexTrigger", flow: "Flow", customobject: "CustomObject", customfield: "CustomField",
  validationrule: "ValidationRule", permissionset: "PermissionSet", layout: "Layout", lightningcomponentbundle: "LightningComponentBundle",
  auradefinitionbundle: "AuraDefinitionBundle", flexipage: "FlexiPage", quickaction: "QuickAction", customlabel: "CustomLabel",
  recordtype: "RecordType", emailtemplate: "EmailTemplate", workflow: "Workflow", approvalprocess: "ApprovalProcess", customtab: "CustomTab",
  staticresource: "StaticResource", customapplication: "CustomApplication", custommetadata: "CustomMetadata", globalvalueset: "GlobalValueSet",
};

export function resolveComponent(ctx: GateContext, type: string, name: string, local: Record<string, Set<string>>): { ok: boolean; via?: string } {
  const t = METADATA_TYPE_MAP[type.toLowerCase().replace(/\s+/g, "")] ?? type;
  if (t === "CustomField") {
    const [obj, fld] = name.includes(".") ? name.split(".") : [undefined, name];
    if (obj) {
      const d = loadDescribeCache(ctx, obj);
      if (d && d.fields[fld]) return { ok: true, via: "L0 describe" };
    }
    if (local["CustomField"]?.has(name)) return { ok: true, via: "local source" };
    return { ok: false };
  }
  if (t === "CustomObject") {
    if (loadDescribeCache(ctx, name)) return { ok: true, via: "L0 describe" };
    if (isStandardObject(name)) return { ok: true, via: "standard object" };
    if (local["CustomObject"]?.has(name)) return { ok: true, via: "local source" };
    const mc = loadMetadataCache(ctx, "CustomObject");
    if (mc?.names.includes(name)) return { ok: true, via: "L0 metadata list" };
    return { ok: false };
  }
  const mc = loadMetadataCache(ctx, t);
  if (mc?.names.includes(name)) return { ok: true, via: "L0 metadata list" };
  if (local[t]?.has(name)) return { ok: true, via: "local source" };
  return { ok: false };
}

export const planLint: Gate = {
  name: "plan-lint",
  description: "Every API name (components, fields, SOQL tokens, prose tokens) resolves against L0/L1/L2 oracles; new components are explicitly marked action=create.",
  async run(ctx) {
    const { rel, kind } = planFile(ctx);
    const plan = readVaultJson<PlanLike>(ctx, rel);
    if (!plan) return unavailable("plan-lint", `${rel} missing`);
    if (!cacheExists(ctx)) return unavailable("plan-lint", "oracle cache missing — run `sfsmiths agent cache freshen` (gate 0)");
    const local = localComponentIndex(ctx);
    const unresolved: string[] = [];
    const resolved: string[] = [];
    const creates = new Set<string>();
    for (const c of plan.components ?? []) {
      const key = `${c.type}:${c.api_name}`;
      if (c.action === "create") { creates.add(key); creates.add(c.api_name); continue; }
      const r = resolveComponent(ctx, c.type, c.api_name, local);
      (r.ok ? resolved : unresolved).push(key + (r.via ? ` (${r.via})` : ""));
    }
    for (const f of plan.fields ?? []) {
      const key = `${f.object}.${f.api_name}`;
      if (f.action === "create") { creates.add(key); creates.add(f.api_name); continue; }
      const d = loadDescribeCache(ctx, f.object);
      if (!d) { unresolved.push(`${key} (no describe cache for ${f.object})`); continue; }
      if (d.fields[f.api_name]) resolved.push(`${key} (L0 describe)`);
      else if (local["CustomField"]?.has(key)) resolved.push(`${key} (local source)`);
      else unresolved.push(key);
    }
    // tokens in SOQL strings and prose (markdown)
    const mdRel = rel.replace(/\.json$/, ".md");
    const prose = exists(path.join(ctx.vault, mdRel)) ? readText(path.join(ctx.vault, mdRel)) : "";
    const tokens: ApiRef[] = [...(plan.soql ?? []).flatMap((q) => extractApiTokensFromText(q, "soql")), ...extractApiTokensFromText(prose, "prose")];
    for (const tkn of tokens) {
      if (tkn.kind === "field" && tkn.object) {
        const key = `${tkn.object}.${tkn.name}`;
        if (creates.has(key) || creates.has(tkn.name)) continue;
        const d = loadDescribeCache(ctx, tkn.object);
        if (!d) continue; // object not in scope cache — cannot judge; plan components cover the important ones
        if (!d.fields[tkn.name] && !d.fields[tkn.name.replace(/__r$/, "__c")] && !local["CustomField"]?.has(key)) unresolved.push(`${key} (${tkn.source})`);
      } else if (tkn.kind === "unknown") {
        if (creates.has(tkn.name)) continue;
        // bare __c: must be a known object or a field on some cached object or local component
        const known = loadDescribeCache(ctx, tkn.name) || local["CustomObject"]?.has(tkn.name) ||
          [...Object.values(local)].some((s) => [...s].some((n) => n.endsWith(`.${tkn.name}`) || n === tkn.name)) ||
          (loadMetadataCache(ctx, "CustomObject")?.names.includes(tkn.name) ?? false) ||
          describeCachesHaveField(ctx, tkn.name);
        if (!known) unresolved.push(`${tkn.name} (${tkn.source})`);
      }
    }
    const uniqUnresolved = [...new Set(unresolved)];
    if (uniqUnresolved.length) return failed("plan-lint", `${uniqUnresolved.length} unresolved API name(s): ${uniqUnresolved.slice(0, 10).join(", ")}`, { details: { unresolved: uniqUnresolved, resolved, kind } });
    return passed("plan-lint", `${resolved.length} names resolved, ${creates.size ? `${creates.size / 2} marked create` : "none new"}`, { details: { resolved, kind } });
  },
};

function describeCachesHaveField(ctx: GateContext, field: string): boolean {
  const dir = path.join(ctx.p.state, "cache", "describe");
  if (!exists(dir)) return false;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const d = JSON.parse(readText(path.join(dir, f))) as { fields?: Record<string, unknown> };
      if (d.fields && d.fields[field]) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export const semanticCheck: Gate = {
  name: "semantic-check",
  description: "Names are real AND usable: writable fields, no formula/rollup writes, no managed-package edits, flow-type rules, API version skew.",
  async run(ctx) {
    const { rel } = planFile(ctx);
    const plan = readVaultJson<PlanLike>(ctx, rel);
    if (!plan) return unavailable("semantic-check", `${rel} missing`);
    if (!cacheExists(ctx)) return unavailable("semantic-check", "oracle cache missing — run `sfsmiths agent cache freshen`");
    const problems: string[] = [];
    for (const f of plan.fields ?? []) {
      if (f.action !== "write" && f.action !== "modify") continue;
      const d = loadDescribeCache(ctx, f.object);
      const fd = d?.fields[f.api_name];
      if (!fd) continue; // plan-lint reports missing
      if (fd.calculated) problems.push(`${f.object}.${f.api_name} is a formula/rollup — cannot be written`);
      else if (fd.updateable === false && fd.createable !== true) problems.push(`${f.object}.${f.api_name} is read-only (not updateable) — it cannot be written by the change`);
    }
    for (const c of plan.components ?? []) {
      if (c.action !== "modify" && c.action !== "delete") continue;
      const t = METADATA_TYPE_MAP[c.type.toLowerCase().replace(/\s+/g, "")] ?? c.type;
      const mc = loadMetadataCache(ctx, t);
      const name = c.api_name;
      const nsMatch = name.match(/^([A-Za-z][A-Za-z0-9]*)__(?!c$|r$)[A-Za-z]/);
      if (mc?.namespaced?.includes(name) || (nsMatch && !name.endsWith("__c"))) problems.push(`${t}:${name} looks managed (namespace ${nsMatch?.[1] ?? "?"}) — managed components cannot be modified; plan an extension instead`);
    }
    for (const fl of plan.flows ?? []) {
      const type = (fl.type ?? "").toLowerCase();
      const trigger = (fl.trigger ?? "").toLowerCase();
      if ((type.includes("before") || trigger.includes("before")) && (fl.dml || (fl.actions ?? []).some((a) => /create|update|delete|email|action|subflow|apex/i.test(a)))) {
        problems.push(`Flow ${fl.api_name}: before-save flows cannot do DML/actions/emails — use after-save or field assignment`);
      }
    }
    if (plan.api_version) {
      const orgApi = orgApiVersion(ctx);
      if (orgApi && Number(plan.api_version) > Number(orgApi)) problems.push(`api_version ${plan.api_version} > org ${orgApi}`);
      const projApi = projectApiVersion(ctx);
      if (projApi && plan.api_version !== projApi) problems.push(`api_version ${plan.api_version} differs from org/sfdx-project.json sourceApiVersion ${projApi} — keep them consistent`);
    }
    if (problems.length) return failed("semantic-check", problems.slice(0, 8).join("; "), { details: { problems } });
    return passed("semantic-check", "writable/managed/flow-type/api-version checks ok");
  },
};

function projectApiVersion(ctx: GateContext): string | undefined {
  const f = path.join(ctx.p.org, "sfdx-project.json");
  if (!exists(f)) return undefined;
  try { return (JSON.parse(readText(f)) as { sourceApiVersion?: string }).sourceApiVersion; } catch { return undefined; }
}

function orgApiVersion(ctx: GateContext): string | undefined {
  const f = path.join(ctx.p.state, "cache", "org.json");
  if (!exists(f)) return undefined;
  try { return (JSON.parse(readText(f)) as { apiVersion?: string }).apiVersion; } catch { return undefined; }
}
