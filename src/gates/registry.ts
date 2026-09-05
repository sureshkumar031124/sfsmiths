/**
 * registry.ts — gate lookup + runner. Writes validations/<stage>-<gate>.json, records the result
 * in the manifest, emits events (which the reward ledger scores).
 */
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { emitEvent } from "../core/events.js";
import { loadManifest, recordGate, saveManifest, latestGates, type Manifest } from "../core/manifest.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { STAGE_BY_ID } from "../core/state-machine.js";
import { writeJsonAtomic, nowIso } from "../core/util.js";
import { contractCheck, checklistGate, riskFloor } from "./contract.js";
import { planLint, semanticCheck } from "./grounding.js";
import { emailGuard, namingLint, commentLint, commsLint, securityGate, testQuality } from "./hygiene.js";
import { baselineCheck, deployReport, analyzerGate, assertionReferee } from "./verdicts.js";
import type { Gate, GateContext, GateOutcome } from "./types.js";

export const GATES: Record<string, Gate> = Object.fromEntries(
  [contractCheck, checklistGate, riskFloor, planLint, semanticCheck, emailGuard, namingLint, commentLint, commsLint, securityGate, testQuality, baselineCheck, deployReport, analyzerGate, assertionReferee].map((g) => [g.name, g]),
);

export function gateNames(): string[] {
  return Object.keys(GATES).sort();
}

export function buildContext(ticket: string, stage: string, options: Record<string, string> = {}, p: ProjectPaths = projectPaths()): GateContext {
  const cfg = loadConfig(p);
  const manifest = loadManifest(ticket, p);
  return { p, cfg, ticket, stage, manifest, vault: vaultDir(p, ticket), options };
}

export async function runGate(name: string, ctx: GateContext, opts: { persist?: boolean; agent?: string } = {}): Promise<GateOutcome> {
  const gate = GATES[name];
  let outcome: GateOutcome;
  if (!gate) outcome = { name, status: "unavailable", reason: `unavailable: unknown gate "${name}"` };
  else {
    try {
      outcome = await gate.run(ctx);
    } catch (e) {
      outcome = { name, status: "unavailable", reason: `unavailable: gate crashed — ${(e as Error).message}` };
    }
  }
  if (opts.persist !== false) persistOutcome(ctx, outcome, opts.agent);
  return outcome;
}

export function persistOutcome(ctx: GateContext, outcome: GateOutcome, agent?: string): void {
  const file = path.join(ctx.vault, "validations", `${ctx.stage}-${outcome.name}.json`);
  writeJsonAtomic(file, { ...outcome, stage: ctx.stage, ticket: ctx.ticket, at: nowIso() });
  const prev = latestGates(ctx.manifest, ctx.stage)[outcome.name];
  recordGate(ctx.manifest, ctx.stage, { name: outcome.name, status: outcome.status, reason: outcome.reason, artifact_hash: outcome.artifact_hash, details_file: path.relative(ctx.vault, file) });
  saveManifest(ctx.manifest, ctx.p);
  const type = outcome.status === "passed" ? "gate.passed" : outcome.status === "failed" ? "gate.failed" : "gate.unavailable";
  emitEvent({ ticket: ctx.ticket, type, stage: ctx.stage, agent: agent ?? STAGE_BY_ID[ctx.stage]?.agent, data: { gate: outcome.name, reason: outcome.reason, first_try: !prev, reward_events: outcome.reward_events ?? [] } }, ctx.p);
}

/** Run all gates required by the stage definition (used by the SubagentStop stage-gate hook). */
export async function runStageGates(ticket: string, stage: string, options: Record<string, string> = {}, p: ProjectPaths = projectPaths(), opts: { persist?: boolean } = {}): Promise<{ outcomes: GateOutcome[]; ok: boolean; manifest: Manifest }> {
  const ctx = buildContext(ticket, stage, options, p);
  const def = STAGE_BY_ID[stage];
  const names = def?.gates ?? [];
  const outcomes: GateOutcome[] = [];
  for (const n of names) {
    // reload manifest between gates (risk-floor mutates it)
    ctx.manifest = loadManifest(ticket, p);
    outcomes.push(await runGate(n, ctx, { agent: def?.agent, persist: opts.persist ?? true }));
  }
  const ok = outcomes.every((o) => o.status === "passed");
  return { outcomes, ok, manifest: loadManifest(ticket, p) };
}

export function formatOutcomes(outcomes: GateOutcome[]): string {
  return outcomes.map((o) => `${o.status === "passed" ? "✅" : o.status === "failed" ? "❌" : "⚠️"} ${o.name}: ${o.reason ?? o.status}`).join("\n");
}
