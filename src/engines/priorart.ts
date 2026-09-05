/**
 * priorart.ts — "have we worked on this before?" (Part 11 §7, G7).
 *
 * Sources: vault index (knowledge/ticket-index.json) · tracker search (read-only) · git history of scope files ·
 * matching lessons. Writes work/<T>/00c-prior-art.index.json for A1, who reads the related vaults and writes the digest.
 */
import fs from "node:fs";
import path from "node:path";
import { type AllConfig } from "../core/config.js";
import { logGrep, logPath } from "../core/git.js";
import { listTickets, tryLoadManifest } from "../core/manifest.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { exists, listFiles, readJsonOr, readText, walkFiles, writeJsonAtomic, nowIso } from "../core/util.js";
import { componentKeyFromPath } from "../core/fingerprint.js";
import { trackerFor, type SearchHit, type TicketSnapshot } from "./tracker/index.js";
import { emitEvent } from "../core/events.js";

export interface IndexEntry {
  key: string;
  title: string;
  status: string;
  components: string[];
  objects: string[];
  keywords: string[];
  root_cause?: string;
  outcome?: string;
  lessons: string[];
  escaped_defect: boolean;
  closed_at?: string;
  vault: string;
}

const STOP = new Set("the a an and or of to in on for with is are was were be been being this that these those it its as at by from into over under after before when while how what why which who whom not no yes do does did done doing have has had having will would should could can may might must shall about across against among around because but during except through until upon within without also just only very more most other some such than then there here their them they we you your our ours his her hers he she i me my mine".split(" "));

export function keywords(text: string, max = 25): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().replace(/<[^>]+>/g, " ").split(/[^a-z0-9_]+/)) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

export function rebuildTicketIndex(p: ProjectPaths = projectPaths()): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const key of listTickets(p)) {
    const m = tryLoadManifest(key, p);
    if (!m) continue;
    const vault = vaultDir(p, key);
    const scope = readJsonOr<{ components?: string[]; objects?: string[] }>(path.join(vault, "scope.json"), {});
    const intake = readJsonOr<{ summary?: string; keywords?: string[]; objects?: string[] }>(path.join(vault, "01-intake.json"), {});
    const plan = readJsonOr<{ root_cause?: string }>(path.join(vault, "03-plan.json"), {});
    const retro = readJsonOr<{ lessons?: string[] }>(path.join(vault, "09-retro.json"), {});
    const events = exists(path.join(vault, "events.jsonl")) ? readText(path.join(vault, "events.jsonl")) : "";
    const text = [m.title ?? "", intake.summary ?? "", ...(intake.keywords ?? [])].join(" ");
    entries.push({
      key,
      title: m.title ?? "",
      status: m.status,
      components: scope.components ?? [],
      objects: [...new Set([...(scope.objects ?? []), ...(intake.objects ?? [])])],
      keywords: keywords(text),
      root_cause: plan.root_cause,
      outcome: m.status,
      lessons: retro.lessons ?? [],
      escaped_defect: /"type":"escaped_defect"/.test(events),
      closed_at: m.status === "done" ? m.updated_at : undefined,
      vault: path.relative(p.root, vault),
    });
  }
  writeJsonAtomic(path.join(p.knowledge, "ticket-index.json"), { built_at: nowIso(), entries });
  return entries;
}

export function loadTicketIndex(p: ProjectPaths = projectPaths()): IndexEntry[] {
  return readJsonOr<{ entries?: IndexEntry[] }>(path.join(p.knowledge, "ticket-index.json"), {}).entries ?? [];
}

export interface PriorArtResult {
  ticket: string;
  built_at: string;
  keywords: string[];
  scope_guess: string[];
  related: (IndexEntry & { score: number; why: string[] })[];
  tracker_hits: SearchHit[];
  history: { sha: string; date: string; subject: string; source: string }[];
  lessons: { file: string; title: string; triggers: string[] }[];
  warnings: string[];
}

/** Guess components mentioned in the ticket text that exist in the local source tree. */
export function guessScope(p: ProjectPaths, text: string): string[] {
  const names = new Map<string, string>(); // lowercase name → key
  for (const f of walkFiles(p.forceApp)) {
    const k = componentKeyFromPath(f);
    if (!k) continue;
    const name = k.split(":")[1].split(".").pop() ?? "";
    if (name.length >= 5) names.set(name.toLowerCase(), k);
  }
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const [n, k] of names) if (lower.includes(n)) found.add(k);
  return [...found].sort();
}

export async function buildPriorArt(ticket: string, opts: { p?: ProjectPaths; cfg: AllConfig; snapshot: TicketSnapshot }): Promise<PriorArtResult> {
  const p = opts.p ?? projectPaths();
  const s = opts.snapshot;
  const text = `${s.title} ${s.description} ${s.acceptance_criteria ?? ""} ${s.comments.map((c) => c.body).join(" ")}`;
  const kws = keywords(text);
  const scopeGuess = guessScope(p, text);
  const objects = new Set<string>();
  for (const m of text.matchAll(/\b(Account|Contact|Case|Opportunity|Lead|User|Task|Event|Campaign|Order|Contract|Asset|[A-Z][A-Za-z0-9_]+__c)\b/g)) objects.add(m[1]);
  const index = loadTicketIndex(p).length ? loadTicketIndex(p) : rebuildTicketIndex(p);
  const related = index
    .filter((e) => e.key !== ticket)
    .map((e) => {
      const why: string[] = [];
      let score = 0;
      const compOverlap = e.components.filter((c) => scopeGuess.includes(c));
      if (compOverlap.length) { score += 3 * compOverlap.length; why.push(`components: ${compOverlap.join(", ")}`); }
      const objOverlap = e.objects.filter((o) => objects.has(o));
      if (objOverlap.length) { score += 2 * objOverlap.length; why.push(`objects: ${objOverlap.join(", ")}`); }
      const kwOverlap = e.keywords.filter((k) => kws.includes(k));
      if (kwOverlap.length) { score += kwOverlap.length; why.push(`keywords: ${kwOverlap.slice(0, 5).join(", ")}`); }
      if (e.closed_at && Date.now() - new Date(e.closed_at).getTime() < 90 * 86_400_000) { score += 1; why.push("recent"); }
      if (e.escaped_defect) why.push("⚠ had an escaped defect");
      return { ...e, score, why };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // tracker search
  let trackerHits: SearchHit[] = [];
  try {
    const jql = opts.cfg.tracker.jira.prior_art_jql.replace("{project}", opts.cfg.tracker.project_key).replace("{keywords}", kws.slice(0, 6).join(" "));
    trackerHits = (await trackerFor(opts.cfg).search(opts.cfg.tracker.adapter === "jira" ? jql : kws.slice(0, 8).join(" "), 15)).filter((h) => h.key !== ticket);
  } catch { /* tracker offline or not configured — recorded as none */ }

  // git history (pre-system tickets): commits touching guessed scope files + commits mentioning ticket-like keys with our keywords
  const history: PriorArtResult["history"] = [];
  const localFiles = walkFiles(p.forceApp);
  for (const key of scopeGuess.slice(0, 15)) {
    const name = key.split(":")[1].split(".").pop() ?? "";
    for (const f of localFiles.filter((x) => x.includes(`/${name}.`) || x.includes(`/${name}/`))) {
      for (const c of await logPath(p.root, path.join(path.relative(p.root, p.forceApp), f), 730, 10)) history.push({ ...c, source: `git log -- ${f}` });
    }
  }
  for (const kw of kws.slice(0, 4)) for (const c of await logGrep(p.root, kw, path.relative(p.root, p.forceApp), 10)) history.push({ ...c, source: `git log --grep ${kw}` });
  const seen = new Set<string>();
  const uniqHistory = history.filter((h) => (seen.has(h.sha) ? false : (seen.add(h.sha), true))).slice(0, 25);

  // lessons whose triggers match
  const lessons: PriorArtResult["lessons"] = [];
  for (const f of listFiles(path.join(p.knowledge, "lessons"), (n) => /^L-.*\.md$/.test(n))) {
    const txt = readText(f);
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    const triggers = (fm?.[1].match(/triggers:\s*\[([^\]]*)\]/)?.[1] ?? "").split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const title = fm?.[1].match(/title:\s*(.+)/)?.[1]?.trim() ?? path.basename(f);
    const hit = triggers.some((t) => scopeGuess.includes(t) || objects.has(t) || kws.includes(t.toLowerCase()));
    if (hit) lessons.push({ file: path.relative(p.root, f), title, triggers });
  }

  const warnings: string[] = [];
  for (const r of related) {
    const recentTouch = r.components.filter((c) => scopeGuess.includes(c));
    if (recentTouch.length && r.closed_at && Date.now() - new Date(r.closed_at).getTime() < 90 * 86_400_000) warnings.push(`${r.key} touched ${recentTouch.join(", ")} within 90 days — regression risk; reuse its inverse assertions (${r.vault}/artifacts)`);
    if (r.escaped_defect) warnings.push(`${r.key} had an escaped defect — read its 09-retro.md`);
  }

  const result: PriorArtResult = { ticket, built_at: nowIso(), keywords: kws, scope_guess: scopeGuess, related, tracker_hits: trackerHits, history: uniqHistory, lessons, warnings };
  writeJsonAtomic(path.join(vaultDir(p, ticket), "00c-prior-art.index.json"), result);
  emitEvent({ ticket, type: related.length || trackerHits.length ? "prior_art.found" : "prior_art.none", stage: "open", data: { related: related.map((r) => r.key), tracker_hits: trackerHits.map((h) => h.key), history: uniqHistory.length } }, p);
  return result;
}

export function priorArtIndexExists(p: ProjectPaths, ticket: string): boolean {
  return fs.existsSync(path.join(vaultDir(p, ticket), "00c-prior-art.index.json"));
}
