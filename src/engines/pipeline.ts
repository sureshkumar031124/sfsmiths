/**
 * pipeline.ts — unattended mode (Phase 3): `claude -p` with a resume loop. API key by default.
 * Own OAuth token (claude setup-token) technically works without --bare but unattended batch use is a
 * licence gray zone — allowed only with --allow-oauth after reading the note.
 */
import { loadConfig } from "../core/config.js";
import { loadManifest, saveManifest } from "../core/manifest.js";
import { projectPaths, type ProjectPaths } from "../core/paths.js";
import { run } from "../core/shell.js";
import { appendLine, nowIso, safeJsonParse } from "../core/util.js";
import path from "node:path";
import { notify } from "./notify.js";

export interface PipelineResult { ticket: string; loops: number; final_status: string; usd: number; sessions: string[]; stopped_reason: string }

interface ClaudeJson { session_id?: string; total_cost_usd?: number; is_error?: boolean; result?: string; num_turns?: number; usage?: unknown; subtype?: string }

export async function runPipeline(ticket: string, opts: { maxLoops?: number; allowOauth?: boolean; p?: ProjectPaths; log?: (s: string) => void } = {}): Promise<PipelineResult> {
  const p = opts.p ?? projectPaths();
  const cfg = loadConfig(p);
  const log = opts.log ?? (() => {});
  if (!process.env.ANTHROPIC_API_KEY && !opts.allowOauth) {
    throw new Error("pipeline mode needs ANTHROPIC_API_KEY (commercial terms, no training). Your own Claude plan token (claude setup-token) works technically, but unattended batch use is a licence gray zone — pass --allow-oauth only if you accept that.");
  }
  const budget = cfg.budgets.pipeline_max_budget_usd;
  const sessions: string[] = [];
  let usd = 0;
  let loops = 0;
  let stopped = "";
  let sessionId: string | undefined;
  const maxLoops = opts.maxLoops ?? 12;
  while (loops < maxLoops) {
    loops++;
    const prompt = sessionId ? `Continue: run \`sfsmiths agent handoff ${ticket}\` and follow it. If it says WAIT_HUMAN, DONE, ESCALATED or PARKED, report that and stop.` : `/ticket ${ticket}`;
    const args = ["-p", prompt, "--agent", "conductor", "--permission-mode", "acceptEdits", "--output-format", "json", "--max-budget-usd", String(Math.max(1, budget - usd))];
    if (sessionId) args.push("--resume", sessionId);
    log(`claude ${args.slice(0, 6).join(" ")}${sessionId ? ` --resume ${sessionId.slice(0, 8)}…` : ""}`);
    const r = await run("claude", args, { cwd: p.root, timeoutMs: 3 * 60 * 60_000, env: { SFSMITHS_PIPELINE: "1" } });
    const j = safeJsonParse<ClaudeJson>(r.stdout.trim().split("\n").pop() ?? "") ?? safeJsonParse<ClaudeJson>(r.stdout);
    appendLine(path.join(p.metrics, "pipeline.jsonl"), JSON.stringify({ ts: nowIso(), ticket, loop: loops, code: r.code, session_id: j?.session_id, usd: j?.total_cost_usd, is_error: j?.is_error, turns: j?.num_turns }));
    if (j?.session_id) { sessionId = j.session_id; if (!sessions.includes(sessionId)) sessions.push(sessionId); }
    usd += Number(j?.total_cost_usd ?? 0);
    try { const m = loadManifest(ticket, p); m.budget.usd = Math.max(m.budget.usd, usd); saveManifest(m, p); } catch { /* ignore */ }
    if (r.code !== 0 && !j) { stopped = `claude exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`; break; }
    const m = (() => { try { return loadManifest(ticket, p); } catch { return undefined; } })();
    if (!m) { stopped = "no manifest after run"; break; }
    if (m.status !== "running") { stopped = `ticket ${m.status}${m.waiting ? `: ${m.waiting.prompt}` : ""}`; break; }
    if (usd >= budget) { stopped = `pipeline budget ${budget} USD reached`; await notify(cfg, "budget", `${ticket}: pipeline budget reached (${usd.toFixed(2)} USD)`); break; }
  }
  if (!stopped) stopped = `max loops (${maxLoops}) reached`;
  const final = (() => { try { return loadManifest(ticket, p).status; } catch { return "unknown"; } })();
  if (final === "waiting_human") await notify(cfg, "gate_manual", `${ticket}: pipeline paused — needs you`);
  return { ticket, loops, final_status: final, usd, sessions, stopped_reason: stopped };
}
