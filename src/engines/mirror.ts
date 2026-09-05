/**
 * mirror.ts — local mirror of OFFICIAL docs (grounding L2). Sources listed in knowledge/mirror/sources.yaml
 * (editable). Every download is verified (size > 1000 bytes, looks like text/markdown) — a 200 with an empty body
 * is a known trap. knowledge/mirror is never published (.gitignore in export).
 */
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

export function sourcesFile(p: ProjectPaths): string {
  return path.join(p.knowledge, "mirror", "sources.yaml");
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
  if (!exists(sourcesFile(p))) writeTextAtomic(sourcesFile(p), `# knowledge/mirror/sources.yaml — official documentation mirrors (grounding layer L2). Edit to add/remove.\nsources:\n${DEFAULT_SOURCES.map((s) => `  - { name: ${s.name}, url: ${s.url}, kind: ${s.kind}, min_bytes: ${s.min_bytes ?? 1000} }`).join("\n")}\n`);
  const ok: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  const manifest: Record<string, { url: string; bytes: number; fetched_at: string; sha256?: string }> = {};
  for (const s of loadSources(p)) {
    try {
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

/** grep the product-docs mirror for a term (used by agents through the plan-grounding skill's instructions). */
export function mirrorGrep(p: ProjectPaths, term: string, max = 20): string[] {
  const f = path.join(p.knowledge, "mirror", "llms-product-docs.txt");
  if (!exists(f)) return [];
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const out: string[] = [];
  for (const line of readText(f).split("\n")) { if (re.test(line)) { out.push(line.slice(0, 300)); if (out.length >= max) break; } }
  return out;
}
