/**
 * file.ts — tracker adapter for people without Jira (or for the first DEMO ticket).
 *
 * Reads `inbox/<KEY>.md` (markdown with a small front section) or `inbox/<KEY>.json`
 * (a TicketSnapshot). Search scans the inbox + completed vaults.
 */
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";
import { projectPaths } from "../../core/paths.js";
import { exists, listFiles, nowIso, readJson, SfsmithsError } from "../../core/util.js";
import { extractAcceptanceCriteria, snapshotHash } from "./jira.js";
import type { SearchHit, TicketSnapshot, TrackerAdapter } from "./types.js";

export class FileAdapter implements TrackerAdapter {
  readonly name = "file" as const;
  constructor(private inboxDir: string = path.join(projectPaths().root, "inbox")) {}

  async fetch(key: string): Promise<TicketSnapshot> {
    const json = path.join(this.inboxDir, `${key}.json`);
    const md = path.join(this.inboxDir, `${key}.md`);
    if (exists(json)) {
      const s = readJson<TicketSnapshot>(json);
      s.tracker = "file";
      s.fetched_at = nowIso();
      s.raw_hash = snapshotHash(s);
      return s;
    }
    if (exists(md)) return parseMarkdownTicket(key, fs.readFileSync(md, "utf8"));
    throw new SfsmithsError(`No ticket file: ${md} (or .json). Create inbox/${key}.md — see templates/inbox-ticket.md`, "TRACKER_NOT_FOUND");
  }

  async probe(key: string): Promise<{ raw_hash: string; updated?: string }> {
    const s = await this.fetch(key);
    return { raw_hash: s.raw_hash, updated: s.updated };
  }

  async search(jql: string, max = 25): Promise<SearchHit[]> {
    // "jql" is treated as space-separated keywords for the file adapter
    const words = jql.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
    const hits: SearchHit[] = [];
    for (const f of listFiles(this.inboxDir, (n) => n.endsWith(".md") || n.endsWith(".json"))) {
      const key = path.basename(f).replace(/\.(md|json)$/, "");
      const text = fs.readFileSync(f, "utf8").toLowerCase();
      const score = words.filter((w) => text.includes(w)).length;
      if (score > 0) hits.push({ key, title: firstTitle(text), components: [], labels: [], score });
    }
    return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, max);
  }
}

function firstTitle(text: string): string {
  const m = text.match(/^#\s*(.+)$/m) || text.match(/"title"\s*:\s*"([^"]+)"/);
  return m ? m[1].trim() : "";
}

/**
 * Markdown ticket format (templates/inbox-ticket.md):
 *   # <title>
 *   status: Open        (optional key: value lines directly under the title)
 *   priority: High
 *   labels: a, b
 *   components: Case, Flow
 *
 *   <description ...>
 *   ## Acceptance criteria
 *   ...
 *   ## Comments   (optional; "- author (date): text" lines)
 */
export function parseMarkdownTicket(key: string, md: string): TicketSnapshot {
  let text = md.replace(/\r\n/g, "\n");
  let title = key;
  const meta: Record<string, string> = {};
  // Format A (templates/inbox-ticket.md): YAML frontmatter between --- lines, optionally preceded by prose/comments
  const fmStart = text.search(/^---\s*$/m);
  const fm = fmStart >= 0 ? /^---\s*\n([\s\S]*?)\n---\s*\n?/m.exec(text.slice(fmStart)) : null;
  if (fm) {
    try {
      const y = (YAML.parse(fm[1]) ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(y)) meta[k.toLowerCase()] = Array.isArray(v) ? v.map(String).join(", ") : v == null ? "" : String(v);
    } catch { /* fall through to line parsing */ }
    text = text.slice(fmStart + fm[0].length);
  }
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  // Format B: "# <title>" then key: value lines directly under it
  if (lines[i]?.startsWith("# ")) { title = lines[i].slice(2).trim(); i++; }
  while (i < lines.length && /^[a-z_]+:\s*/i.test(lines[i])) {
    const [k, ...rest] = lines[i].split(":");
    meta[k.trim().toLowerCase()] = rest.join(":").trim();
    i++;
  }
  if (title === key && meta.title) title = meta.title;
  const body = lines.slice(i).join("\n").trim();
  const commentsIdx = body.search(/^##\s*comments\s*$/im);
  const description = commentsIdx >= 0 ? body.slice(0, commentsIdx).trim() : body;
  const comments = commentsIdx >= 0
    ? body.slice(commentsIdx).split("\n").slice(1).filter((l) => l.startsWith("- ")).map((l, idx) => {
        const m = l.match(/^-\s*([^(:]+?)(?:\s*\(([^)]+)\))?\s*:\s*(.*)$/);
        return { id: String(idx + 1), author: m?.[1]?.trim(), created: m?.[2]?.trim() ?? "", body: (m?.[3] ?? l.slice(2)).trim() };
      })
    : [];
  const split = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
  const snap: TicketSnapshot = {
    key,
    tracker: "file",
    fetched_at: nowIso(),
    title,
    description,
    status: meta.status,
    priority: meta.priority,
    issue_type: meta.type ?? meta.issue_type,
    labels: split(meta.labels),
    components: split(meta.components),
    reporter: meta.reporter,
    assignee: meta.assignee,
    created: meta.created,
    updated: meta.updated,
    acceptance_criteria: extractAcceptanceCriteria(description),
    comments,
    attachments: [],
    links: split(meta.links).map((k) => ({ type: "relates to", key: k })),
    raw_hash: "",
  };
  snap.raw_hash = snapshotHash(snap);
  return snap;
}
