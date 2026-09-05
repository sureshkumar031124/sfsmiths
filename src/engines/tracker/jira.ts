/**
 * jira.ts — Jira Cloud REST v3, READ-ONLY (GET only; no method here can write).
 *
 * Auth: HTTP Basic with email + API token from env vars named in config/tracker.yaml
 * (defaults SFSMITHS_JIRA_EMAIL / SFSMITHS_JIRA_TOKEN). Tokens never touch config files.
 *
 * Endpoints used:
 *   GET /rest/api/3/issue/{key}?fields=...&expand=renderedFields   (issue)
 *   GET /rest/api/3/search/jql?jql=...&fields=...&maxResults=...     (search — the current Cloud endpoint)
 */
import { adfToText } from "./adf.js";
import type { SearchHit, TicketSnapshot, TrackerAdapter } from "./types.js";
import type { TrackerConfig } from "../../core/config.js";
import { nowIso, sha256, SfsmithsError } from "../../core/util.js";

const FIELDS = [
  "summary", "description", "status", "priority", "issuetype", "labels", "components", "reporter", "assignee",
  "created", "updated", "comment", "attachment", "issuelinks", "parent", "resolution",
].join(",");

export class JiraAdapter implements TrackerAdapter {
  readonly name = "jira" as const;
  private base: string;
  private auth: string;

  constructor(private cfg: TrackerConfig["jira"], env: NodeJS.ProcessEnv = process.env) {
    const email = env[cfg.email_env];
    const token = env[cfg.token_env];
    if (!cfg.base_url) throw new SfsmithsError("tracker.jira.base_url not configured", "TRACKER_CONFIG");
    if (!email || !token) {
      throw new SfsmithsError(`Jira credentials missing: set ${cfg.email_env} and ${cfg.token_env} (read-only API token) in your environment`, "TRACKER_AUTH");
    }
    this.base = cfg.base_url.replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const res = await fetch(`${this.base}${pathAndQuery}`, {
      method: "GET",
      headers: { Authorization: this.auth, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SfsmithsError(`Jira GET ${pathAndQuery} → HTTP ${res.status}: ${body.slice(0, 300)}`, "TRACKER_HTTP", { status: res.status });
    }
    return (await res.json()) as T;
  }

  async fetch(key: string): Promise<TicketSnapshot> {
    const issue = await this.get<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(FIELDS)}`);
    return normalizeIssue(issue, this.base);
  }

  async probe(key: string): Promise<{ raw_hash: string; updated?: string }> {
    const snap = await this.fetch(key);
    return { raw_hash: snap.raw_hash, updated: snap.updated };
  }

  async search(jql: string, max = 25): Promise<SearchHit[]> {
    const fields = "summary,status,updated,resolution,components,labels";
    const q = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}&maxResults=${Math.min(max, this.cfg.max_results || 50)}`;
    const data = await this.get<{ issues?: JiraIssue[] }>(q);
    return (data.issues ?? []).map((i) => ({
      key: i.key,
      title: i.fields?.summary ?? "",
      status: i.fields?.status?.name,
      updated: i.fields?.updated,
      resolution: i.fields?.resolution?.name,
      components: (i.fields?.components ?? []).map((c) => c.name ?? "").filter(Boolean),
      labels: i.fields?.labels ?? [],
    }));
  }
}

/* ---------- Jira wire types (subset) ---------- */
interface JiraNamed { name?: string; displayName?: string; emailAddress?: string; key?: string }
interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: JiraNamed;
    priority?: JiraNamed;
    issuetype?: JiraNamed;
    labels?: string[];
    components?: JiraNamed[];
    reporter?: JiraNamed;
    assignee?: JiraNamed | null;
    created?: string;
    updated?: string;
    resolution?: JiraNamed | null;
    parent?: { key?: string; fields?: { summary?: string; issuetype?: JiraNamed } };
    comment?: { comments?: { id: string; author?: JiraNamed; created?: string; body?: unknown }[] };
    attachment?: { id: string; filename: string; mimeType?: string; size?: number; created?: string; content?: string }[];
    issuelinks?: { type?: { name?: string; inward?: string; outward?: string }; inwardIssue?: { key: string; fields?: { summary?: string } }; outwardIssue?: { key: string; fields?: { summary?: string } } }[];
  };
}

export function normalizeIssue(issue: JiraIssue, base: string): TicketSnapshot {
  const f = issue.fields ?? {};
  const description = adfToText(f.description as never);
  const comments = (f.comment?.comments ?? []).map((c) => ({
    id: String(c.id),
    author: c.author?.displayName ?? c.author?.name,
    created: c.created ?? "",
    body: adfToText(c.body as never),
  }));
  const attachments = (f.attachment ?? []).map((a) => ({
    id: String(a.id), filename: a.filename, mimeType: a.mimeType, size: a.size, created: a.created, url: a.content,
  }));
  const links = (f.issuelinks ?? []).map((l) => {
    if (l.outwardIssue) return { type: l.type?.outward ?? l.type?.name ?? "relates to", key: l.outwardIssue.key, title: l.outwardIssue.fields?.summary };
    if (l.inwardIssue) return { type: l.type?.inward ?? l.type?.name ?? "relates to", key: l.inwardIssue.key, title: l.inwardIssue.fields?.summary };
    return { type: l.type?.name ?? "link", key: "" };
  }).filter((l) => l.key);
  const acceptance = extractAcceptanceCriteria(description);
  const parentKey = f.parent?.key;
  const isEpic = (f.parent?.fields?.issuetype?.name ?? "").toLowerCase() === "epic";
  const snap: TicketSnapshot = {
    key: issue.key,
    tracker: "jira",
    fetched_at: nowIso(),
    title: f.summary ?? "",
    description,
    status: f.status?.name,
    priority: f.priority?.name,
    issue_type: f.issuetype?.name,
    labels: f.labels ?? [],
    components: (f.components ?? []).map((c) => c.name ?? "").filter(Boolean),
    reporter: f.reporter?.displayName,
    assignee: f.assignee?.displayName,
    created: f.created,
    updated: f.updated,
    acceptance_criteria: acceptance,
    comments,
    attachments,
    links,
    parent: parentKey,
    epic: isEpic ? parentKey : undefined,
    raw_hash: "",
    source_url: `${base}/browse/${issue.key}`,
  };
  snap.raw_hash = snapshotHash(snap);
  return snap;
}

/** Hash of the fields that matter for "did the ticket change?" (hold/resume diff). */
export function snapshotHash(s: TicketSnapshot): string {
  return sha256(JSON.stringify({
    title: s.title, description: s.description, status: s.status, priority: s.priority,
    ac: s.acceptance_criteria, comments: s.comments.map((c) => [c.id, c.body]), attachments: s.attachments.map((a) => a.id),
    links: s.links,
  }));
}

/** Pull an "Acceptance criteria" section out of a description when present. */
export function extractAcceptanceCriteria(description: string): string | undefined {
  const m = description.match(/(?:^|\n)#*\s*(?:acceptance criteria|ac|definition of done|expected behaviou?r)\s*:?\s*\n([\s\S]*?)(?=\n#+\s|\n[A-Z][^\n]{0,40}:\s*\n|$)/i);
  return m ? m[1].trim() : undefined;
}
