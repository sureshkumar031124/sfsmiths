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
  source: "post_tool_use" | "transcript";
  total_tokens: number;
  usage: Usage;
  duration_ms?: number;
  session_id?: string;
  agent_id?: string;
  usd?: number;
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

export function estimateUsd(model: string | undefined, usage: Usage, p: ProjectPaths = projectPaths()): number | undefined {
  const prices = readJsonOr<Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> | undefined>(path.join(p.metrics, "prices.json"), undefined);
  if (!prices || !model) return undefined;
  const key = Object.keys(prices).find((k) => model.toLowerCase().includes(k.toLowerCase()));
  if (!key) return undefined;
  const pr = prices[key];
  return (usage.input_tokens * pr.input + usage.output_tokens * pr.output + usage.cache_read_input_tokens * (pr.cache_read ?? pr.input * 0.1) + usage.cache_creation_input_tokens * (pr.cache_write ?? pr.input * 1.25)) / 1_000_000;
}

export function recordAgentRun(run: Omit<AgentRun, "ts">, p: ProjectPaths = projectPaths()): AgentRun {
  const full: AgentRun = { ts: nowIso(), ...run };
  if (full.usd === undefined) full.usd = estimateUsd(full.model, full.usage, p);
  appendLine(path.join(p.metrics, "agent-runs.jsonl"), JSON.stringify(full));
  if (full.ticket) {
    try {
      const m = loadManifest(full.ticket, p);
      m.budget.tokens += full.total_tokens;
      if (full.usd) m.budget.usd += full.usd;
      m.budget.wall_ms = Date.now() - new Date(m.budget.started_at).getTime();
      saveManifest(m, p);
      emitEvent({ ticket: full.ticket, type: "tokens.recorded", stage: m.stage, agent: full.agent, data: { total_tokens: full.total_tokens, model: full.model, source: full.source } }, p);
    } catch { /* manifest may not exist (maintenance agents) */ }
  }
  return full;
}

export function readAgentRuns(p: ProjectPaths = projectPaths()): AgentRun[] {
  const out: AgentRun[] = [];
  for (const l of readLines(path.join(p.metrics, "agent-runs.jsonl"))) {
    try { out.push(JSON.parse(l) as AgentRun); } catch { /* skip */ }
  }
  return out;
}
