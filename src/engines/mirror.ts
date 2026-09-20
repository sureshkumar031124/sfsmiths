/**
 * mirror.ts — local mirror of OFFICIAL docs (grounding L2). Sources listed in knowledge/mirror/sources.yaml
 * (editable). Every download is verified (size > 1000 bytes, looks like text/markdown) — a 200 with an empty body
 * is a known trap. knowledge/mirror is never published (.gitignore in export).
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { projectPaths, type ProjectPaths } from "../core/paths.js";
import { ensureDir, exists, nowIso, readText, writeJsonAtomic, writeTextAtomic } from "../core/util.js";

export interface MirrorSource { name: string; url: string; kind: "llms-index" | "product-docs" | "lwc" | "other"; min_bytes?: number }

export const DEFAULT_SOURCES: MirrorSource[] = [
  { name: "llms.txt", url: "https://developer.salesforce.com/docs/llms.txt", kind: "llms-index", min_bytes: 1000 },
  { name: "llms-product-docs.txt", url: "https://developer.salesforce.com/docs/llms-product-docs.txt", kind: "product-docs", min_bytes: 100_000 },
  { name: "llms-lwc.txt", url: "https://developer.salesforce.com/docs/llms-lwc.txt", kind: "lwc", min_bytes: 1000 },
];

/**
 * P12 (D-103): the ONLY hosts the docs mirror may fetch from — Salesforce's own documentation properties. Anything an
 * agent later cites as `L2` came from here or from knowledge/curated/ (human-added, with provenance). Extend the list in
 * knowledge/mirror/sources.yaml → trusted_domains only for another Salesforce-owned host; expert (MVP / veteran) writing
 * is never mirrored automatically — a human reads it and files it under knowledge/curated/ with author and URL.
 */
export const DEFAULT_TRUSTED_DOMAINS = [
  "developer.salesforce.com", "help.salesforce.com", "architect.salesforce.com", "trailhead.salesforce.com",
  "admin.salesforce.com", "engineering.salesforce.com", "release.salesforce.com", "www.salesforce.com", "salesforce.com",
  "github.com/forcedotcom", "github.com/salesforcecli", "github.com/salesforce",
];

export function sourcesFile(p: ProjectPaths): string {
  return path.join(p.knowledge, "mirror", "sources.yaml");
}

export function loadTrustedDomains(p: ProjectPaths): string[] {
  const f = sourcesFile(p);
  if (!exists(f)) return DEFAULT_TRUSTED_DOMAINS;
  try { const d = (YAML.parse(readText(f)) as { trusted_domains?: string[] }).trusted_domains; return d?.length ? d : DEFAULT_TRUSTED_DOMAINS; } catch { return DEFAULT_TRUSTED_DOMAINS; }
}

/** A source is trusted when its https host equals a trusted domain (or is a subdomain of one) and, for github.com entries, its path starts with the listed org. */
export function sourceTrusted(url: string, trusted: string[] = DEFAULT_TRUSTED_DOMAINS): { ok: boolean; reason: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: `not a URL: ${url}` }; }
  if (u.protocol !== "https:") return { ok: false, reason: `only https sources are mirrored: ${url}` };
  const host = u.hostname.toLowerCase();
  for (const t of trusted) {
    const [tHost, ...tPath] = t.toLowerCase().split("/");
    const hostOk = host === tHost || host.endsWith(`.${tHost}`);
    if (!hostOk) continue;
    if (tPath.length && !u.pathname.toLowerCase().startsWith(`/${tPath.join("/")}/`) && u.pathname.toLowerCase() !== `/${tPath.join("/")}`) continue;
    return { ok: true, reason: `trusted: ${t}` };
  }
  return { ok: false, reason: `host ${host} is not a Salesforce documentation domain (P12) — expert articles go to knowledge/curated/ with author + URL, never into the mirror` };
}

export function loadSources(p: ProjectPaths): MirrorSource[] {
  const f = sourcesFile(p);
  if (!exists(f)) return DEFAULT_SOURCES;
  try { return (YAML.parse(readText(f)) as { sources?: MirrorSource[] }).sources ?? DEFAULT_SOURCES; } catch { return DEFAULT_SOURCES; }
}

export async function mirrorRefresh(opts: { p?: ProjectPaths; log?: (s: string) => void } = {}): Promise<{ ok: string[]; failed: { name: string; reason: string }[] }> {
  const p = opts.p ?? projectPaths();
  const log = opts.log ?? (() => {});
  const dir = path.join(p.knowledge, "mirror");
  ensureDir(dir);
  if (!exists(sourcesFile(p))) writeTextAtomic(sourcesFile(p), `# knowledge/mirror/sources.yaml — official documentation mirrors (grounding layer L2). Edit to add/remove.\n# P12: only hosts in trusted_domains are fetched (Salesforce-owned documentation). Expert articles → knowledge/curated/ with provenance.\ntrusted_domains:\n${DEFAULT_TRUSTED_DOMAINS.map((d) => `  - ${d}`).join("\n")}\nsources:\n${DEFAULT_SOURCES.map((s) => `  - { name: ${s.name}, url: ${s.url}, kind: ${s.kind}, min_bytes: ${s.min_bytes ?? 1000} }`).join("\n")}\n`);
  const ok: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  const manifest: Record<string, { url: string; bytes: number; fetched_at: string; sha256?: string }> = {};
  const trusted = loadTrustedDomains(p);
  for (const s of loadSources(p)) {
    try {
      const t = sourceTrusted(s.url, trusted);
      if (!t.ok) throw new Error(`REFUSED (P12): ${t.reason}`);
      log(`fetching ${s.name}…`);
      const res = await fetch(s.url, { headers: { "User-Agent": "sfsmiths-mirror/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length < (s.min_bytes ?? 1000)) throw new Error(`body too small (${text.length} bytes) — 200-but-empty trap`);
      if (/<html[\s>]/i.test(text.slice(0, 500))) throw new Error("got HTML, expected text/markdown");
      writeTextAtomic(path.join(dir, s.name), text);
      manifest[s.name] = { url: s.url, bytes: text.length, fetched_at: nowIso() };
      ok.push(`${s.name} (${text.length} bytes)`);
    } catch (e) {
      failed.push({ name: s.name, reason: (e as Error).message });
    }
  }
  writeJsonAtomic(path.join(dir, "MANIFEST.json"), { refreshed_at: nowIso(), files: manifest, failed });
  return { ok, failed };
}

/**
 * P12 (D-103): knowledge/curated/*.md is the only place non-official knowledge enters the system, and every file must say
 * where it came from. Required frontmatter: source_url (https), author, trust (official | mvp | veteran | internal),
 * retrieved (YYYY-MM-DD), added_by. Files without it are listed so a human fixes them; agents are told (skill) to cite only
 * curated notes that carry provenance.
 */
export const CURATED_TRUST_LEVELS = ["official", "mvp", "veteran", "internal"] as const;

export function curatedLint(p: ProjectPaths): { ok: boolean; files: number; problems: string[] } {
  const dir = path.join(p.knowledge, "curated");
  const problems: string[] = [];
  if (!exists(dir)) return { ok: true, files: 0, problems };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
  for (const f of files) {
    const text = readText(path.join(dir, f));
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    if (!fm) { problems.push(`${f}: no frontmatter (source_url, author, trust, retrieved, added_by required)`); continue; }
    let meta: Record<string, unknown> = {};
    try { meta = (YAML.parse(fm) as Record<string, unknown>) ?? {}; } catch (e) { problems.push(`${f}: frontmatter is not valid YAML — ${(e as Error).message}`); continue; }
    for (const k of ["source_url", "author", "trust", "retrieved", "added_by"]) if (!meta[k]) problems.push(`${f}: missing ${k}`);
    if (meta.source_url && !/^https:\/\//.test(String(meta.source_url))) problems.push(`${f}: source_url must be https`);
    if (meta.trust && !CURATED_TRUST_LEVELS.includes(String(meta.trust) as never)) problems.push(`${f}: trust must be one of ${CURATED_TRUST_LEVELS.join("|")}`);
    if (meta.retrieved && !/^\d{4}-\d{2}-\d{2}$/.test(String(meta.retrieved))) problems.push(`${f}: retrieved must be YYYY-MM-DD`);
    if (meta.trust === "official" && meta.source_url && !sourceTrusted(String(meta.source_url)).ok) problems.push(`${f}: trust "official" but source_url is not a Salesforce documentation domain — use mvp/veteran/internal`);
  }
  return { ok: problems.length === 0, files: files.length, problems };
}

/** grep the product-docs mirror for a term (used by agents through the plan-grounding skill's instructions). */
export function mirrorGrep(p: ProjectPaths, term: string, max = 20): string[] {
  const f = path.join(p.knowledge, "mirror", "llms-product-docs.txt");
  if (!exists(f)) return [];
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const out: string[] = [];
  for (const line of readText(f).split("\n")) { if (re.test(line)) { out.push(line.slice(0, 300)); if (out.length >= max) break; } }
  return out;
}
