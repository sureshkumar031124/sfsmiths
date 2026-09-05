/**
 * helpers.ts — shared gate utilities: changed files, artifact reading, oracle caches, token extraction.
 */
import fs from "node:fs";
import path from "node:path";
import { git } from "../core/git.js";
import { exists, readJsonOr, readText, sha256, uniq, walkFiles } from "../core/util.js";
import { componentKeyFromPath } from "../core/fingerprint.js";
import type { GateContext } from "./types.js";

export function vaultFile(ctx: GateContext, rel: string): string {
  return path.join(ctx.vault, rel);
}

export function readVaultJson<T>(ctx: GateContext, rel: string): T | undefined {
  const f = vaultFile(ctx, rel);
  return exists(f) ? readJsonOr<T | undefined>(f, undefined) : undefined;
}

export function hashFiles(files: string[]): string {
  const parts = files.filter(exists).sort().map((f) => `${f}:${sha256(fs.readFileSync(f))}`);
  return sha256(parts.join("\n"));
}

/**
 * Files in org/force-app changed by this ticket:
 *  - vs the baseline commit recorded after baseline sync (manifest.flags.baseline_commit), if any
 *  - plus untracked files
 *  - fallback: files modified after the current stage started
 */
export async function changedSourceFiles(ctx: GateContext): Promise<string[]> {
  const root = ctx.p.root;
  const rel = path.relative(root, ctx.p.forceApp);
  const out = new Set<string>();
  const base = typeof ctx.manifest.flags.baseline_commit === "string" ? ctx.manifest.flags.baseline_commit : undefined;
  const isRepo = (await git(["rev-parse", "--is-inside-work-tree"], root)).ok;
  if (isRepo) {
    const diff = await git(["diff", "--name-only", base ?? "HEAD", "--", rel], root);
    if (diff.ok) diff.out.split(/\r?\n/).filter(Boolean).forEach((f) => out.add(f));
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "--", rel], root);
    if (untracked.ok) untracked.out.split(/\r?\n/).filter(Boolean).forEach((f) => out.add(f));
    const staged = await git(["diff", "--name-only", "--cached", "--", rel], root);
    if (staged.ok) staged.out.split(/\r?\n/).filter(Boolean).forEach((f) => out.add(f));
  }
  if (out.size === 0) {
    // fallback: mtime after stage start
    const started = ctx.manifest.stages[ctx.stage]?.started_at;
    const since = started ? new Date(started).getTime() : 0;
    for (const f of walkFiles(ctx.p.forceApp)) {
      const full = path.join(ctx.p.forceApp, f);
      if (fs.statSync(full).mtimeMs >= since) out.add(path.join(rel, f));
    }
  }
  return [...out].filter((f) => exists(path.join(root, f))).sort();
}

export function componentKeys(files: string[]): string[] {
  return uniq(files.map((f) => componentKeyFromPath(f)).filter((k): k is string => !!k));
}

/* ---------- oracle caches (gate 0 builds them: sfsmiths agent cache freshen) ---------- */

export interface DescribeCache {
  name: string;
  fetched_at: string;
  fields: Record<string, { type: string; createable?: boolean; updateable?: boolean; calculated?: boolean; custom?: boolean; picklist?: string[] }>;
  recordTypes?: string[];
}

export function describeCachePath(ctx: GateContext, sobject: string): string {
  return path.join(ctx.p.state, "cache", "describe", `${sobject}.json`);
}

export function loadDescribeCache(ctx: GateContext, sobject: string): DescribeCache | undefined {
  return readJsonOr<DescribeCache | undefined>(describeCachePath(ctx, sobject), undefined);
}

export interface MetadataCache {
  type: string;
  fetched_at: string;
  names: string[];
  namespaced?: string[]; // managed (namespace prefix) members
}

export function loadMetadataCache(ctx: GateContext, type: string): MetadataCache | undefined {
  return readJsonOr<MetadataCache | undefined>(path.join(ctx.p.state, "cache", "metadata", `${type}.json`), undefined);
}

export function cacheExists(ctx: GateContext): boolean {
  return exists(path.join(ctx.p.state, "cache", "describe")) || exists(path.join(ctx.p.state, "cache", "metadata"));
}

/** Local repo component index: Type → Set(names) from org/force-app. */
export function localComponentIndex(ctx: GateContext): Record<string, Set<string>> {
  const idx: Record<string, Set<string>> = {};
  for (const f of walkFiles(ctx.p.forceApp)) {
    const key = componentKeyFromPath(f);
    if (!key) continue;
    const [type, name] = key.split(":");
    (idx[type] ??= new Set()).add(name);
  }
  return idx;
}

/* ---------- API-name token extraction ---------- */

export interface ApiRef {
  kind: "field" | "object" | "class" | "flow" | "unknown";
  object?: string;
  name: string;
  source: string; // where it came from (json path or "prose")
}

const STANDARD_OBJECTS = new Set(["Account", "Contact", "Case", "Opportunity", "Lead", "User", "Task", "Event", "Campaign", "Product2", "Pricebook2", "PricebookEntry", "OpportunityLineItem", "Order", "Contract", "Asset", "CaseComment", "EmailMessage", "FeedItem", "Group", "Profile", "PermissionSet", "RecordType", "Attachment", "ContentDocument", "ContentVersion", "ContentDocumentLink", "Note", "Quote", "Solution", "Idea", "Entitlement", "ServiceContract", "WorkOrder", "Knowledge__kav", "Individual"]);

export function isStandardObject(name: string): boolean {
  return STANDARD_OBJECTS.has(name);
}

/** Pull Object.Field__c / Field__c / Object__c style tokens from free text. */
export function extractApiTokensFromText(text: string, source = "prose"): ApiRef[] {
  const refs: ApiRef[] = [];
  const seen = new Set<string>();
  const push = (r: ApiRef) => {
    const k = `${r.kind}:${r.object ?? ""}.${r.name}`;
    if (!seen.has(k)) {
      seen.add(k);
      refs.push(r);
    }
  };
  // Object.Field__c or Object.StandardField (only when object looks like an sObject)
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:__c|__r)?)\.([A-Z][A-Za-z0-9_]*(?:__c|__r)?)\b/g)) {
    const obj = m[1];
    if (obj.endsWith("__r")) continue;
    if (obj.endsWith("__c") || isStandardObject(obj)) push({ kind: "field", object: obj, name: m[2], source });
  }
  // bare custom fields/objects (__c)
  for (const m of text.matchAll(/(?<![\w.])([A-Z][A-Za-z0-9_]*__c)\b/g)) {
    push({ kind: "unknown", name: m[1], source });
  }
  return refs;
}
