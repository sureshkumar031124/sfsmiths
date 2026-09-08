/**
 * tokens.ts — token accounting per agent / ticket / model.
 *
 * Two sources (Part 11 §3.4, verified defensively — Spike B confirms the exact payload):
 *   1. PostToolUse(Agent) tool_response: totalTokens / usage / resolvedModel / agentId / totalDurationMs when present
 *   2. SubagentStop agent_transcript_path: sum of message.usage across assistant turns (fallback / cross-check)
 * Records → metrics/agent-runs.jsonl; manifest.budget.tokens updated; usd from metrics/prices.json when present.
 */
import path from "node:path";
import { projectPaths, type ProjectPaths } from "../core/paths.js";
import { tryLoadConfig, type ModelPrice } from "../core/config.js";
import { appendLine, exists, nowIso, readJsonOr, readLines } from "../core/util.js";
import { loadManifest, saveManifest } from "../core/manifest.js";
import { emitEvent } from "../core/events.js";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface AgentRun {
  ts: string;
  ticket?: string;
  agent: string;
  model?: string;
  /** D-095: the reasoning effort this run was configured with, so a token number can be interpreted later. */
  effort?: string;
  source: "post_tool_use" | "transcript";
  total_tokens: number;
  /** D-094: input + output + cache_creation — what actually cost fresh context. Budgets are judged on this. */
  fresh_tokens?: number;
  usage: Usage;
  duration_ms?: number;
  session_id?: string;
  agent_id?: string;
  usd?: number;
}

/**
 * D-094: fresh tokens = everything except cache reads.
 *
 * Run 1 measured one prior-art agent at 13.3M "tokens", of which 12.6M were cache READS — a re-read of the same
 * context on each of ~63 API round trips, priced at roughly a tenth of an input token. The per-ticket budget of
 * 1.5M was crossed 21× in a single stage and nothing parked, because the number being compared was not the number
 * that costs money. Totals are still recorded (and shown separately in the UI); the budget uses this.
 */
export function freshTokens(u: Usage): number {
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

const zero = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

export function usageFromToolResponse(resp: unknown): { usage: Usage; total: number; model?: string; agentId?: string; durationMs?: number } | undefined {
  if (!resp || typeof resp !== "object") return undefined;
  const r = resp as Record<string, unknown>;
  const u = (r.usage ?? r.tokenUsage ?? r.token_usage) as Partial<Usage> | undefined;
  const usage = zero();
  if (u && typeof u === "object") {
    usage.input_tokens = Number(u.input_tokens ?? 0) || 0;
    usage.output_tokens = Number(u.output_tokens ?? 0) || 0;
    usage.cache_read_input_tokens = Number(u.cache_read_input_tokens ?? 0) || 0;
    usage.cache_creation_input_tokens = Number(u.cache_creation_input_tokens ?? 0) || 0;
  }
  const explicitTotal = Number(r.totalTokens ?? r.total_tokens ?? NaN);
  const total = Number.isFinite(explicitTotal) ? explicitTotal : usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  if (!total && !u) return undefined;
  return { usage, total, model: (r.resolvedModel ?? r.model) as string | undefined, agentId: (r.agentId ?? r.agent_id) as string | undefined, durationMs: Number(r.totalDurationMs ?? r.duration_ms ?? NaN) || undefined };
}

/** Sum usage over a Claude Code transcript (.jsonl). Tolerates unknown shapes. */
export function usageFromTranscript(file: string): { usage: Usage; total: number; model?: string; turns: number } | undefined {
  if (!exists(file)) return undefined;
  const usage = zero();
  let model: string | undefined;
  let turns = 0;
  for (const line of readLines(file)) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const msg = (obj.message ?? obj) as Record<string, unknown>;
    const u = (msg.usage ?? obj.usage) as Partial<Usage> | undefined;
    if (u && typeof u === "object") {
      turns++;
      usage.input_tokens += Number(u.input_tokens ?? 0) || 0;
      usage.output_tokens += Number(u.output_tokens ?? 0) || 0;
      usage.cache_read_input_tokens += Number(u.cache_read_input_tokens ?? 0) || 0;
      usage.cache_creation_input_tokens += Number(u.cache_creation_input_tokens ?? 0) || 0;
      if (!model && typeof msg.model === "string") model = msg.model;
    }
  }
  if (!turns) return undefined;
  return { usage, total: usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens, model, turns };
}

/**
 * D-094: prices come from `metrics/prices.json` when the operator supplies one, otherwise from
 * `config/budgets.yaml → prices` (which ships with defaults). Before this, nothing shipped a price table at all,
 * so every run recorded `usd: 0`, the daily/per-ticket USD budgets never fired and the dashboard always read $0.
 * A model with no matching entry still returns undefined — an honest unknown beats a wrong number.
 */
export function loadPrices(p: ProjectPaths = projectPaths()): Record<string, ModelPrice> | undefined {
  const override = readJsonOr<Record<string, ModelPrice> | undefined>(path.join(p.metrics, "prices.json"), undefined);
  if (override && Object.keys(override).length) return override;
  const { cfg } = tryLoadConfig(p);
  const fromConfig = cfg.budgets?.prices;
  return fromConfig && Object.keys(fromConfig).length ? fromConfig : undefined;
}

export function priceFor(model: string | undefined, prices: Record<string, ModelPrice> | undefined): ModelPrice | undefined {
  if (!prices || !model) return undefined;
  const key = Object.keys(prices).find((k) => model.toLowerCase().includes(k.toLowerCase()));
  return key ? prices[key] : undefined;
}

export function estimateUsd(model: string | undefined, usage: Usage, p: ProjectPaths = projectPaths()): number | undefined {
  const pr = priceFor(model, loadPrices(p));
  if (!pr) return undefined;
  return (usage.input_tokens * pr.input + usage.output_tokens * pr.output + usage.cache_read_input_tokens * (pr.cache_read ?? pr.input * 0.1) + usage.cache_creation_input_tokens * (pr.cache_write ?? pr.input * 1.25)) / 1_000_000;
}

export function recordAgentRun(run: Omit<AgentRun, "ts">, p: ProjectPaths = projectPaths()): AgentRun {
  const full: AgentRun = { ts: nowIso(), ...run };
  if (full.fresh_tokens === undefined) full.fresh_tokens = freshTokens(full.usage);
  if (full.usd === undefined) full.usd = estimateUsd(full.model, full.usage, p);
  if (full.effort === undefined) full.effort = effortForAgent(full.agent, p);
  appendLine(path.join(p.metrics, "agent-runs.jsonl"), JSON.stringify(full));
  if (full.ticket) {
    try {
      const m = loadManifest(full.ticket, p);
      m.budget.tokens += full.total_tokens;
      m.budget.fresh_tokens = (m.budget.fresh_tokens ?? 0) + (full.fresh_tokens ?? 0);
      if (full.usd) m.budget.usd += full.usd;
      m.budget.wall_ms = Date.now() - new Date(m.budget.started_at).getTime();
      saveManifest(m, p);
      emitEvent({ ticket: full.ticket, type: "tokens.recorded", stage: m.stage, agent: full.agent, data: { total_tokens: full.total_tokens, fresh_tokens: full.fresh_tokens, cache_read_tokens: full.usage.cache_read_input_tokens, usd: full.usd, model: full.model, effort: full.effort, source: full.source } }, p);
    } catch { /* manifest may not exist (maintenance agents) */ }
  }
  return full;
}

/** D-095: the configured effort for an agent, recorded alongside its tokens so the number can be read later. */
export function effortForAgent(agent: string, p: ProjectPaths = projectPaths()): string | undefined {
  const { cfg } = tryLoadConfig(p);
  const e = cfg.models?.effort?.[agent] ?? cfg.models?.fallback_effort;
  return e && e !== "inherit" ? e : undefined;
}

/**
 * D-094 migration. A manifest written before `fresh_tokens` existed carries a cache-INFLATED total, so falling
 * back to it treats ~32M cache-read tokens as fresh and parks a ticket that is actually under budget (DEMO-101:
 * stored total 31,965,415, true fresh 1,489,752 — under the 1.5M limit). The per-run usage is still on record in
 * metrics/agent-runs.jsonl, so recompute the truth from it instead of guessing. Returns undefined when there is
 * genuinely nothing recorded — then the cap stays on the total, because an unknown must not silently become 0.
 */
export function backfillTicketBudget(ticket: string, p: ProjectPaths = projectPaths()): { fresh: number; usd: number; runs: number } | undefined {
  const runs = readAgentRuns(p).filter((r) => r.ticket === ticket);
  if (!runs.length) return undefined;
  const prices = loadPrices(p);
  let fresh = 0;
  let usd = 0;
  for (const r of runs) {
    fresh += r.fresh_tokens ?? freshTokens(r.usage);
    // pre-D-094 runs recorded usd: 0 because no price table shipped — re-price them now that one does
    usd += r.usd || (priceFor(r.model, prices) ? estimateUsd(r.model, r.usage, p) ?? 0 : 0);
  }
  return { fresh, usd, runs: runs.length };
}

export function readAgentRuns(p: ProjectPaths = projectPaths()): AgentRun[] {
  const out: AgentRun[] = [];
  for (const l of readLines(path.join(p.metrics, "agent-runs.jsonl"))) {
    try { out.push(JSON.parse(l) as AgentRun); } catch { /* skip */ }
  }
  return out;
}
