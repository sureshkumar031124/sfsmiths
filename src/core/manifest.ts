/**
 * manifest.ts — the per-ticket state file (work/<TICKET>/manifest.yaml).
 *
 * The manifest is written ONLY by the toolkit (sfsmiths / sfsmiths-human / hooks).
 * Agents read it; the write-guard hook denies agent writes to it.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { projectPaths, vaultDir, sanitizeTicket, type ProjectPaths } from "./paths.js";
import { ensureDir, exists, nowIso, writeTextAtomic, SfsmithsError } from "./util.js";
import { validateNamed } from "./schema.js";

export type TicketStatus = "running" | "waiting_human" | "on_hold" | "escalated" | "parked" | "done" | "failed";
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type GateStatus = "passed" | "failed" | "unavailable";
export type Tier = "LOW" | "MEDIUM" | "HIGH";

export interface GateRecord {
  name: string;
  status: GateStatus;
  reason?: string;
  artifact_hash?: string;
  at: string;
  details_file?: string;
}

export interface StageRecord {
  status: StageStatus;
  agent?: string;
  attempts: number;
  started_at?: string;
  ended_at?: string;
  /**
   * D-093: stamped by the SubagentStop stage-gate when THIS attempt's subagent actually ended
   * (gates passed, or gates failed past the block cap). Cleared whenever a new attempt starts.
   * `status: running` WITHOUT this stamp means the agent is still alive — never a failure.
   */
  agent_ended_at?: string;
  agent_waits?: number;      // consecutive WAIT_AGENT decisions for this attempt (bounded, see AGENT_WAIT_CAP)
  blocks: number;            // consecutive SubagentStop blocks for this stage
  outputs?: string[];
  note?: string;
}

export interface Approval {
  stage: string;
  decision: "approved" | "approved_with_edits" | "rejected";
  by: string;
  at: string;
  origin: "user_prompt_submit" | "cli" | "ui";
  answer?: string;
  reason?: string;
  edits?: string;
}

export interface ResumeRecord {
  at: string;
  diff_class: string;
  action: string;
  note?: string;
}

export interface Manifest {
  version: 1;
  product: "sfsmiths";
  ticket: string;
  tracker: string;
  title?: string;
  status: TicketStatus;
  tier: Tier | "UNSET";
  tier_source?: "risk-floor" | "human" | "provisional";
  stage: string;                      // current stage id
  next_allowed_stages: string[];      // agents allowed to be spawned right now (checked by agent-gate hook)
  stages: Record<string, StageRecord>;
  gates: Record<string, GateRecord[]>;
  approvals: Approval[];
  waiting: { kind: "approval" | "question" | "deploy" | "remediation" | "budget" | "canary" | "baseline"; stage: string; prompt: string; since: string } | null;
  fingerprints: { dev?: string; uat?: string; scope?: string; taken_at?: string };
  baseline: { synced_at?: string; ancestor_source?: string; decisions: { component: string; classification: string; action: string; by?: string; at: string }[] } | null;
  /**
   * D-094: `tokens` stays the raw total (cache reads included) for reporting; `fresh_tokens`
   * (input + output + cache_creation) is what the per-ticket token budget is judged on, because
   * a cache read is ~10% of the price and inflates the total by an order of magnitude.
   */
  budget: { tokens: number; fresh_tokens?: number; usd: number; wall_ms: number; started_at: string };
  resumes: ResumeRecord[];
  bounces: { from: string; to: string; at: string; reason: string }[];
  locks: string[];
  history: string[];                  // history/<ts> dirs (restarts)
  created_at: string;
  updated_at: string;
  held?: { at: string; reason: string } | null;
  escalation?: { at: string; reason: string; stage: string } | null;
  session_ids: string[];
  flags: Record<string, boolean | string>;
}

export function manifestPath(p: ProjectPaths, ticket: string): string {
  return path.join(vaultDir(p, ticket), "manifest.yaml");
}

export function newManifest(ticket: string, tracker: string, title?: string): Manifest {
  const t = sanitizeTicket(ticket);
  const now = nowIso();
  return {
    version: 1,
    product: "sfsmiths",
    ticket: t,
    tracker,
    title,
    status: "running",
    tier: "UNSET",
    stage: "open",
    next_allowed_stages: [],
    stages: {},
    gates: {},
    approvals: [],
    waiting: null,
    fingerprints: {},
    baseline: null,
    budget: { tokens: 0, fresh_tokens: 0, usd: 0, wall_ms: 0, started_at: now },
    resumes: [],
    bounces: [],
    locks: [],
    history: [],
    created_at: now,
    updated_at: now,
    held: null,
    escalation: null,
    session_ids: [],
    flags: {},
  };
}

export function loadManifest(ticket: string, p: ProjectPaths = projectPaths()): Manifest {
  const file = manifestPath(p, ticket);
  if (!exists(file)) throw new SfsmithsError(`No vault for ${ticket} (expected ${file}). Run: /ticket ${ticket}`, "NO_VAULT");
  const m = YAML.parse(fs.readFileSync(file, "utf8")) as Manifest;
  const errors = validateNamed("manifest", m);
  if (errors.length) throw new SfsmithsError(`manifest.yaml for ${ticket} is invalid:\n  - ${errors.join("\n  - ")}`, "MANIFEST_INVALID");
  return m;
}

export function tryLoadManifest(ticket: string, p: ProjectPaths = projectPaths()): Manifest | undefined {
  try {
    return loadManifest(ticket, p);
  } catch {
    return undefined;
  }
}

export function saveManifest(m: Manifest, p: ProjectPaths = projectPaths()): void {
  m.updated_at = nowIso();
  const errors = validateNamed("manifest", m);
  if (errors.length) throw new SfsmithsError(`Refusing to save invalid manifest:\n  - ${errors.join("\n  - ")}`, "MANIFEST_INVALID");
  const file = manifestPath(p, m.ticket);
  ensureDir(path.dirname(file));
  const header = `# manifest.yaml — written by the sfsmiths toolkit only. Agents: read, never edit.\n`;
  writeTextAtomic(file, header + YAML.stringify(m));
  // compact JSON sidecar for the fast (zero-dependency) hooks
  writeTextAtomic(path.join(path.dirname(file), ".state.json"), JSON.stringify({
    ticket: m.ticket, status: m.status, stage: m.stage, tier: m.tier, next_allowed_stages: m.next_allowed_stages,
    waiting: m.waiting ? { kind: m.waiting.kind, stage: m.waiting.stage } : null, updated_at: m.updated_at,
    stage_status: m.stages[m.stage]?.status ?? "pending", blocks: m.stages[m.stage]?.blocks ?? 0,
    agent_ended_at: m.stages[m.stage]?.agent_ended_at ?? null,
  }) + "\n");
}

export interface StateSidecar {
  ticket: string; status: TicketStatus; stage: string; tier: string; next_allowed_stages: string[];
  waiting: { kind: string; stage: string } | null; updated_at: string; stage_status: StageStatus; blocks: number;
  agent_ended_at?: string | null;
}

export function listTickets(p: ProjectPaths = projectPaths()): string[] {
  if (!exists(p.work)) return [];
  return fs
    .readdirSync(p.work, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[A-Z][A-Z0-9_]*-\d+$/.test(d.name) && exists(path.join(p.work, d.name, "manifest.yaml")))
    .map((d) => d.name)
    .sort();
}

export function stageRecord(m: Manifest, stage: string): StageRecord {
  if (!m.stages[stage]) m.stages[stage] = { status: "pending", attempts: 0, blocks: 0 };
  return m.stages[stage];
}

export function recordGate(m: Manifest, stage: string, g: Omit<GateRecord, "at">): GateRecord {
  const rec: GateRecord = { ...g, at: nowIso() };
  if (!m.gates[stage]) m.gates[stage] = [];
  // keep latest result per gate name at the end, but retain history
  m.gates[stage].push(rec);
  return rec;
}

export function latestGates(m: Manifest, stage: string): Record<string, GateRecord> {
  const out: Record<string, GateRecord> = {};
  for (const g of m.gates[stage] ?? []) out[g.name] = g; // later entries overwrite earlier
  return out;
}

export function stageGatesAllPassed(m: Manifest, stage: string, required: string[]): { ok: boolean; failing: GateRecord[]; missing: string[] } {
  const latest = latestGates(m, stage);
  const failing: GateRecord[] = [];
  const missing: string[] = [];
  for (const name of required) {
    const g = latest[name];
    if (!g) missing.push(name);
    else if (g.status !== "passed") failing.push(g); // unavailable ≠ passed (P8)
  }
  return { ok: failing.length === 0 && missing.length === 0, failing, missing };
}
