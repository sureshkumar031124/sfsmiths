/**
 * state-machine.ts — the ticket lifecycle, as CODE (P4).
 *
 * The conductor never decides what comes next; it runs `sfsmiths agent handoff <ticket>`
 * and follows the answer. Gates are checked here from the manifest (written by the
 * SubagentStop stage-gate hook). Human gates come from config/autonomy.yaml + hard floor.
 */
import type { AllConfig, Tier as CfgTier } from "./config.js";
import { stageRecord, stageGatesAllPassed, type Manifest, type GateRecord } from "./manifest.js";
import { nowIso } from "./util.js";

export type StageKind = "toolkit" | "agent" | "human";

export interface StageDef {
  id: string;
  title: string;
  kind: StageKind;
  agent?: string;                 // subagent name for kind=agent
  gates: string[];                // gate names required to pass (run by stage-gate hook)
  human_gate?: string;            // key in autonomy.tiers[tier].human_gates (ask|auto)
  always_human?: boolean;         // hard floor: never auto (deploys, remediation)
  optional?: (m: Manifest) => boolean; // stage may be skipped when returns true
  output?: string;                // primary output file
}

export const STAGES: StageDef[] = [
  { id: "open",        title: "Open",            kind: "toolkit", gates: [] },
  { id: "prior_art",   title: "Prior Art",       kind: "agent", agent: "a1-intake",        gates: ["contract-check"], output: "00c-prior-art.md" },
  { id: "intake",      title: "Intake",          kind: "agent", agent: "a1-intake",        gates: ["contract-check", "risk-floor"], human_gate: "intake", output: "01-intake.md" },
  { id: "baseline",    title: "Baseline Sync",   kind: "agent", agent: "a0b-baseline",     gates: ["baseline-check"], output: "00b-baseline.md" },
  { id: "cartography", title: "Cartography",     kind: "agent", agent: "a0-cartographer",  gates: ["contract-check"], output: "00d-cartography.md" },
  { id: "repro",       title: "Reproduce",       kind: "agent", agent: "a2-repro",         gates: ["email-guard", "naming-lint", "assertion-referee", "contract-check"], output: "02-repro.md" },
  { id: "plan",        title: "Plan",            kind: "agent", agent: "a3-architect",     gates: ["plan-lint", "semantic-check", "checklist", "contract-check"], human_gate: "plan", output: "03-plan.md" },
  { id: "develop",     title: "Develop",         kind: "agent", agent: "a4-developer",     gates: ["comment-lint", "naming-lint", "plan-lint", "deploy-report", "contract-check"], output: "04-implementation.md" },
  { id: "qa_dev",      title: "QA (Dev)",        kind: "agent", agent: "a5-qa",            gates: ["assertion-referee", "test-quality", "contract-check"], output: "05-test-report.md" },
  { id: "review",      title: "Review",          kind: "agent", agent: "a6-reviewer",      gates: ["security", "contract-check"], human_gate: "review", output: "06-review.md" },
  { id: "comms",       title: "Comms drafts",    kind: "agent", agent: "a9-comms",         gates: ["comms-lint"], output: "10-comms/" },
  // no preprod org configured (flag set by the baseline engine) → nothing to deploy to or test in: both preprod stages are skipped
  { id: "deploy_uat",  title: "Deploy to preprod (human)", kind: "human", gates: [], always_human: true,
    optional: (m) => m.flags["no_preprod"] === true },
  // D-099: after the human deploys, the toolkit retrieves the same components from preprod (engine keychain) and compares
  // fingerprints with the dev source — "did everything we built arrive?" is a hash comparison, not anyone's opinion.
  // A mismatch sends the ticket back to the deploy step with the list; QA in preprod never runs on a partial deploy.
  { id: "uat_verify",  title: "Preprod parity (toolkit)", kind: "toolkit", gates: [], output: "07a-uat-parity.md",
    optional: (m) => m.flags["no_preprod"] === true },
  { id: "qa_uat",      title: "QA (preprod)",    kind: "agent", agent: "a5-qa",            gates: ["uat-parity", "assertion-referee", "contract-check"], output: "07-uat-report.md",
    optional: (m) => m.flags["no_preprod"] === true },
  { id: "deploy_prod", title: "Deploy to production (human)", kind: "human", gates: [], always_human: true },
  { id: "prod_verify", title: "Production verify (read-only)", kind: "toolkit", gates: [], output: "08-prod-verify.md" },
  { id: "remediation", title: "Remediation (human runs script)", kind: "human", gates: [], always_human: true,
    optional: (m) => m.flags["has_remediation"] !== true },
  { id: "learn",       title: "Score + learn",   kind: "agent", agent: "a7-coach", gates: [], output: "09-retro.md" },
  { id: "done",        title: "Done",            kind: "toolkit", gates: [] },
];

export const STAGE_BY_ID: Record<string, StageDef> = Object.fromEntries(STAGES.map((s) => [s.id, s]));
export const AGENT_NAMES = [
  "conductor", "a0-cartographer", "a0b-baseline", "a1-intake", "a2-repro", "a3-architect",
  "a4-developer", "a5-qa", "a6-reviewer", "a7-coach", "a8-ui", "a9-comms",
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** Agents the conductor may spawn outside the strict stage order (support roles). */
export const SUPPORT_AGENTS_BY_STAGE: Record<string, string[]> = {
  repro: ["a8-ui", "playwright-planner", "playwright-generator", "playwright-healer"],
  qa_dev: ["a8-ui", "playwright-planner", "playwright-generator", "playwright-healer"],
  qa_uat: ["a8-ui"],
};

export function stageIndex(id: string): number {
  return STAGES.findIndex((s) => s.id === id);
}

export function nextStageId(m: Manifest, from: string): string | undefined {
  let i = stageIndex(from) + 1;
  while (i < STAGES.length) {
    const s = STAGES[i];
    if (s.optional && s.optional(m)) {
      stageRecord(m, s.id).status = "skipped";
      i++;
      continue;
    }
    return s.id;
  }
  return undefined;
}

export function allowedAgentsFor(stageId: string): string[] {
  const s = STAGE_BY_ID[stageId];
  const out: string[] = [];
  if (s?.agent) out.push(s.agent);
  out.push(...(SUPPORT_AGENTS_BY_STAGE[stageId] ?? []));
  return out;
}

export function humanGateMode(m: Manifest, s: StageDef, cfg: AllConfig): "ask" | "auto" {
  if (s.always_human) return "ask";
  const tier = (m.tier === "UNSET" ? "HIGH" : m.tier) as CfgTier; // unknown tier = most careful
  let mode: "ask" | "auto" = "auto";
  if (s.human_gate) mode = cfg.autonomy.tiers[tier]?.human_gates?.[s.human_gate] ?? "ask";
  // per-agent overlay from the UI (Agents screen): "Ask before proceeding" wins over tier matrix
  if (s.agent && cfg.autonomy.agents?.[s.agent] === "ask") mode = "ask";
  return mode;
}

/**
 * D-093: how many consecutive WAIT_AGENT answers we give before treating a stage whose agent never
 * reported back as a genuine failure. Bounded by OUR persisted counter (the house rule), not by
 * session state — the Stop hook's 8-block cap is the second, independent belt.
 */
export const AGENT_WAIT_CAP = 8;

export type HandoffAction =
  | { action: "SPAWN"; stage: string; agent: string; allowed_agents: string[]; attempt: number }
  | { action: "RUN_TOOLKIT"; stage: string; verb: string }
  | { action: "WAIT_AGENT"; stage: string; agent: string; since?: string; waits: number }
  | { action: "WAIT_HUMAN"; stage: string; kind: NonNullable<Manifest["waiting"]>["kind"]; prompt: string }
  | { action: "HOLD"; reason: string }
  | { action: "ESCALATED"; stage: string; reason: string }
  | { action: "PARKED"; reason: string }
  | { action: "FAILED"; reason: string }
  | { action: "DONE" };

export interface HandoffResult {
  decision: HandoffAction;
  manifest: Manifest;
  notes: string[];
}

/** The most recent human decision on a stage since the stage's last completion (an older decision belongs to an older attempt). */
function latestDecision(m: Manifest, stage: string) {
  const since = new Date(stageRecord(m, stage).ended_at ?? 0).getTime();
  return [...m.approvals].reverse().find((a) => a.stage === stage && new Date(a.at).getTime() >= since);
}

function hasApproval(m: Manifest, stage: string): boolean {
  const d = latestDecision(m, stage);
  return !!d && d.decision !== "rejected";
}

function latestRejection(m: Manifest, stage: string) {
  const d = latestDecision(m, stage);
  return d && d.decision === "rejected" ? d : undefined;
}

/**
 * Bounce ladder (mechanical): QA failure → develop (1) → plan (2) → human (3).
 * Repro: max 2 attempts → honest escalation.
 */
export function bounceTarget(m: Manifest, from: string): { to: string; reason: string } | { escalate: string } {
  const fails = m.bounces.filter((b) => b.from === from).length;
  if (from === "qa_dev" || from === "qa_uat") {
    if (fails === 0) return { to: "develop", reason: `${from} failed — first bounce to develop` };
    if (fails === 1) return { to: "plan", reason: `${from} failed twice — bounce to plan (design defect?)` };
    return { escalate: `${from} failed 3× — human decision needed` };
  }
  if (from === "repro") {
    const attempts = stageRecord(m, "repro").attempts;
    if (attempts < 2) return { to: "repro", reason: "reproduce again with NEW evidence (max 2 tries)" };
    return { escalate: "could not reproduce after 2 evidence-backed tries — honest escalation" };
  }
  // every other agent stage gets ONE retry with the gate report in its prompt (partial results, maxTurns, a fixable gate);
  // the second failure escalates honestly — no silent loops
  const attempts = stageRecord(m, from).attempts;
  if (STAGE_BY_ID[from]?.kind === "agent" && attempts < 2) return { to: from, reason: `${from} failed once — retry with the gate report (max 2 tries)` };
  return { escalate: `${from} failed ${attempts}× — human decision needed` };
}

/**
 * Core decision. Pure w.r.t. side effects except mutating the passed manifest copy.
 * The CLI persists the manifest and emits events.
 */
export function decideHandoff(m: Manifest, cfg: AllConfig): HandoffResult {
  const notes: string[] = [];
  if (m.status === "on_hold") return { decision: { action: "HOLD", reason: m.held?.reason ?? "on hold" }, manifest: m, notes };
  if (m.status === "parked") return { decision: { action: "PARKED", reason: "budget/quota parked — resume when available" }, manifest: m, notes };
  if (m.status === "escalated") return { decision: { action: "ESCALATED", stage: m.stage, reason: m.escalation?.reason ?? "escalated" }, manifest: m, notes };
  if (m.status === "failed") return { decision: { action: "FAILED", reason: "ticket failed" }, manifest: m, notes };
  if (m.status === "done" || m.stage === "done") {
    m.status = "done";
    return { decision: { action: "DONE" }, manifest: m, notes };
  }

  // budget hard stop (park, resumable).
  // D-094: judged on FRESH tokens (input + output + cache_creation), not the cache-read-inflated total — a cache read
  // is a re-read of context already paid for, and counting it made the token budget meaningless (21× over in one
  // stage with nothing parked). Older manifests have no fresh_tokens: fall back to the total so they still park.
  const freshUsed = m.budget.fresh_tokens ?? m.budget.tokens;
  if (freshUsed > cfg.budgets.per_ticket.tokens || m.budget.usd > cfg.budgets.per_ticket.usd) {
    m.status = "parked";
    m.waiting = { kind: "budget", stage: m.stage, prompt: `Budget exceeded (fresh tokens ${freshUsed} of ${cfg.budgets.per_ticket.tokens}, usd ${m.budget.usd.toFixed(2)} of ${cfg.budgets.per_ticket.usd}; ${m.budget.tokens} total incl. cache reads). Raise config/budgets.yaml or resume with --allow-budget.`, since: nowIso() };
    return { decision: { action: "PARKED", reason: m.waiting.prompt }, manifest: m, notes };
  }

  const cur = STAGE_BY_ID[m.stage];
  if (!cur) return { decision: { action: "FAILED", reason: `unknown stage ${m.stage}` }, manifest: m, notes };
  const rec = stageRecord(m, cur.id);

  // 1. waiting for a human? stay until an approval/deploy mark arrives
  if (m.status === "waiting_human" && m.waiting) {
    if (m.waiting.kind === "approval" && latestDecision(m, m.waiting.stage)) {
      const wstage = m.waiting.stage;
      const rej = latestRejection(m, wstage);
      if (rej) {
        // rejected → redo that stage (the agent gets the rejection reason via the vault)
        notes.push(`human rejected ${wstage}: ${rej.reason ?? ""}`);
        m.status = "running";
        m.waiting = null;
        return restartStage(m, wstage, `human rejected: ${rej.reason ?? "no reason"}`, notes);
      }
      m.status = "running";
      m.waiting = null;
      notes.push(`approval recorded for ${cur.id}`);
      return advance(m, cfg, notes);
    }
    if (m.waiting.kind === "deploy" && rec.status === "done") {
      m.status = "running";
      m.waiting = null;
      return advance(m, cfg, notes);
    }
    if (m.waiting.kind === "remediation" && rec.status === "done") {
      m.status = "running";
      m.waiting = null;
      return advance(m, cfg, notes);
    }
    return { decision: { action: "WAIT_HUMAN", stage: m.waiting.stage, kind: m.waiting.kind, prompt: m.waiting.prompt }, manifest: m, notes };
  }

  // 2. stage not started yet → start it
  if (rec.status === "pending") return startStage(m, cfg, cur, notes);

  // 3. stage running (agent spawned, not yet marked done by stage-gate) → spawn again (conductor re-entry) is NOT allowed.
  //    The SubagentStop stage-gate marks the stage done/failed AND stamps `agent_ended_at`. Without that stamp the
  //    subagent is still alive (D-093: a background/async Agent call ends the conductor's turn while the agent works —
  //    calling that a failure bounced the stage and spawned a second specialist in parallel). Only a stamped end,
  //    or too many waits, is a failure.
  if (rec.status === "running") {
    if (cur.kind === "agent") {
      // support flow: the stage agent asked for a support agent (e.g. a UI observation) and stopped cleanly
      const support = typeof m.flags.support_requested === "string" ? m.flags.support_requested : undefined;
      if (support && (SUPPORT_AGENTS_BY_STAGE[cur.id] ?? []).includes(support)) {
        m.flags.support_requested = false;
        m.flags.resume_stage_agent = true;
        m.next_allowed_stages = allowedAgentsFor(cur.id);
        notes.push(`${cur.agent} requested support from ${support}`);
        return { decision: { action: "SPAWN", stage: cur.id, agent: support, allowed_agents: m.next_allowed_stages, attempt: rec.attempts }, manifest: m, notes };
      }
      if (m.flags.resume_stage_agent === true) {
        m.flags.resume_stage_agent = false;
        rec.blocks = 0;
        clearAgentEnd(rec);       // D-093: the stage agent is about to run again on the same attempt
        notes.push(`resuming ${cur.agent} with the support report (same attempt ${rec.attempts})`);
        return { decision: { action: "SPAWN", stage: cur.id, agent: cur.agent ?? "", allowed_agents: allowedAgentsFor(cur.id), attempt: rec.attempts }, manifest: m, notes };
      }
      // the stage-gate has NOT recorded an end for this attempt → the agent is still running
      if (!rec.agent_ended_at) {
        const waits = (rec.agent_waits ?? 0) + 1;
        rec.agent_waits = waits;
        if (waits <= AGENT_WAIT_CAP) {
          notes.push(`stage ${cur.id} is running and its agent has not reported back (wait ${waits}/${AGENT_WAIT_CAP})`);
          return { decision: { action: "WAIT_AGENT", stage: cur.id, agent: cur.agent ?? "", since: rec.started_at, waits }, manifest: m, notes };
        }
        notes.push(`stage ${cur.id}: agent never reported back after ${AGENT_WAIT_CAP} waits`);
        return handleStageFailure(m, cfg, cur, `agent never reported back (no SubagentStop end recorded after ${AGENT_WAIT_CAP} waits) — it may have been spawned in the background or died silently`, notes);
      }
      notes.push(`stage ${cur.id} still 'running' when handoff called — subagent ended (${rec.agent_ended_at}) without passing gates`);
      return handleStageFailure(m, cfg, cur, "agent ended without passing stage gates", notes);
    }
    if (cur.kind === "toolkit") return { decision: { action: "RUN_TOOLKIT", stage: cur.id, verb: toolkitVerb(cur.id) }, manifest: m, notes };
  }

  // 4. stage done → check gates, human gate, then advance
  if (rec.status === "done") {
    if (cur.gates.length) {
      const g = stageGatesAllPassed(m, cur.id, cur.gates);
      if (!g.ok) {
        const why = [...g.failing.map((f) => `${f.name}: ${f.status}${f.reason ? ` — ${f.reason}` : ""}`), ...g.missing.map((x) => `${x}: not run`)].join("; ");
        return handleStageFailure(m, cfg, cur, `gates not passed → ${why}`, notes);
      }
    }
    // a rejection recorded since this completion → redo the stage with the reason (whatever the gate mode)
    const rej = latestRejection(m, cur.id);
    if (rej && cur.kind === "agent") {
      notes.push(`human rejected ${cur.id}: ${rej.reason ?? ""}`);
      m.waiting = null;
      return restartStage(m, cur.id, `human rejected: ${rej.reason ?? "no reason"}`, notes);
    }
    // human stages (deploys, remediation) are marked done BY the human — that mark is the approval
    if (cur.kind !== "human" && humanGateMode(m, cur, cfg) === "ask" && !hasApproval(m, cur.id)) {
      m.status = "waiting_human";
      m.waiting = { kind: "approval", stage: cur.id, prompt: approvalPrompt(m, cur), since: nowIso() };
      return { decision: { action: "WAIT_HUMAN", stage: cur.id, kind: "approval", prompt: m.waiting.prompt }, manifest: m, notes };
    }
    m.waiting = null;
    return advance(m, cfg, notes);
  }

  if (rec.status === "failed") return handleStageFailure(m, cfg, cur, rec.note ?? "stage failed", notes);
  if (rec.status === "skipped") return advance(m, cfg, notes);
  return { decision: { action: "FAILED", reason: `unhandled state ${rec.status} at ${cur.id}` }, manifest: m, notes };
}

function toolkitVerb(stage: string): string {
  switch (stage) {
    case "open": return "open";
    case "prod_verify": return "prod-verify";
    case "uat_verify": return "uat-parity";
    case "learn": return "learn-digest";
    default: return stage;
  }
}

function approvalPrompt(m: Manifest, s: StageDef): string {
  const out = s.output ? `work/${m.ticket}/${s.output}` : `work/${m.ticket}/`;
  const typed = m.tier === "HIGH" && s.id === "plan" ? " HIGH tier: typed answer required (--answer \"...\")." : "";
  return `Stage "${s.title}" finished. Review ${out} then: /approve ${m.ticket} --stage ${s.id} [--answer "..."]  or  /reject ${m.ticket} --stage ${s.id} --reason "...".${typed}`;
}

function startStage(m: Manifest, cfg: AllConfig, s: StageDef, notes: string[]): HandoffResult {
  const rec = stageRecord(m, s.id);
  rec.status = s.kind === "human" ? "pending" : "running";
  rec.attempts += 1;
  rec.started_at = nowIso();
  rec.blocks = 0;
  rec.agent = s.agent;
  clearAgentEnd(rec);           // D-093: a new attempt has no recorded agent end yet
  if (s.kind === "agent" && s.agent) {
    m.next_allowed_stages = allowedAgentsFor(s.id);
    // safety: data-creating stages need a fresh canary (checked by the privileged/data verbs too)
    return { decision: { action: "SPAWN", stage: s.id, agent: s.agent, allowed_agents: m.next_allowed_stages, attempt: rec.attempts }, manifest: m, notes };
  }
  if (s.kind === "human") {
    m.next_allowed_stages = [];
    m.status = "waiting_human";
    const kind: NonNullable<Manifest["waiting"]>["kind"] = s.id === "remediation" ? "remediation" : "deploy";
    const prompt = s.id === "deploy_uat"
      ? `Read work/${m.ticket}/06b-deploy-brief.md → deploy exactly the components in work/${m.ticket}/06c-deploy-manifest.md (artifacts/package.xml) to preprod with your deploy tool → then: sfsmiths-human deployed ${m.ticket} --org preprod (the toolkit then verifies the deploy against the dev source before QA runs)`
      : s.id === "deploy_prod"
        ? `Preprod QA passed (07-uat-report.md). Deploy to production (RunLocalTests, window check) → then: sfsmiths-human deployed ${m.ticket} --org production`
        : `Run the reviewed remediation script (work/${m.ticket}/artifacts/remediation/) in production yourself → then: sfsmiths-human verify ${m.ticket} --remediation`;
    m.waiting = { kind, stage: s.id, prompt, since: nowIso() };
    return { decision: { action: "WAIT_HUMAN", stage: s.id, kind, prompt }, manifest: m, notes };
  }
  m.next_allowed_stages = [];
  return { decision: { action: "RUN_TOOLKIT", stage: s.id, verb: toolkitVerb(s.id) }, manifest: m, notes };
}

function advance(m: Manifest, cfg: AllConfig, notes: string[]): HandoffResult {
  const next = nextStageId(m, m.stage);
  if (!next) {
    m.stage = "done";
    m.status = "done";
    m.next_allowed_stages = [];
    return { decision: { action: "DONE" }, manifest: m, notes };
  }
  m.stage = next;
  const s = STAGE_BY_ID[next];
  if (next === "done") {
    m.status = "done";
    m.next_allowed_stages = [];
    return { decision: { action: "DONE" }, manifest: m, notes };
  }
  return startStage(m, cfg, s, notes);
}

function restartStage(m: Manifest, stage: string, reason: string, notes: string[]): HandoffResult {
  const rec = stageRecord(m, stage);
  rec.note = reason;
  m.bounces.push({ from: m.stage, to: stage, at: nowIso(), reason });
  m.stage = stage;
  notes.push(`restart ${stage}: ${reason}`);
  markStart(m, stage);
  return { decision: { action: "SPAWN", stage, agent: STAGE_BY_ID[stage].agent ?? "", allowed_agents: allowedAgentsFor(stage), attempt: rec.attempts }, manifest: m, notes };
}

function markStart(m: Manifest, stage: string): Manifest {
  const rec = stageRecord(m, stage);
  rec.status = "running";
  rec.attempts += 1;
  rec.started_at = nowIso();
  rec.blocks = 0;
  clearAgentEnd(rec);           // D-093
  m.next_allowed_stages = allowedAgentsFor(stage);
  m.status = "running";
  return m;
}

/**
 * D-093: forget the previous subagent's end for this stage. Called whenever an agent is about to run
 * again — a new attempt, or the same attempt resumed after a support agent. A stale stamp would make
 * the next handoff read a live agent as a finished, gate-less failure.
 */
export function clearAgentEnd(rec: { agent_ended_at?: string; agent_waits?: number }): void {
  delete rec.agent_ended_at;
  rec.agent_waits = 0;
}

/** D-093: called by the SubagentStop stage-gate when this attempt's subagent has genuinely ended. */
export function markAgentEnded(m: Manifest, stage: string): void {
  const rec = stageRecord(m, stage);
  rec.agent_ended_at = nowIso();
  rec.agent_waits = 0;
}

function handleStageFailure(m: Manifest, cfg: AllConfig, s: StageDef, reason: string, notes: string[]): HandoffResult {
  const rec = stageRecord(m, s.id);
  rec.status = "failed";
  rec.ended_at = nowIso();
  rec.note = reason;
  const b = bounceTarget(m, s.id);
  if ("escalate" in b) return escalate(m, s.id, `${reason} → ${b.escalate}`, notes);
  m.bounces.push({ from: s.id, to: b.to, at: nowIso(), reason: b.reason });
  notes.push(`bounce ${s.id} → ${b.to}: ${b.reason}`);
  m.stage = b.to;
  const target = STAGE_BY_ID[b.to];
  stageRecord(m, b.to).status = "pending";
  stageRecord(m, b.to).note = `bounced from ${s.id}: ${reason}`;
  return startStage(m, cfg, target, notes);
}

export function escalate(m: Manifest, stage: string, reason: string, notes: string[] = []): HandoffResult {
  m.status = "escalated";
  m.escalation = { at: nowIso(), reason, stage };
  m.next_allowed_stages = [];
  m.waiting = { kind: "question", stage, prompt: `Escalated at ${stage}: ${reason}. Decide: /resume ${m.ticket} --restart-from <stage> | /hold ${m.ticket} | fix by hand and /resume.`, since: nowIso() };
  notes.push(`ESCALATED: ${reason}`);
  return { decision: { action: "ESCALATED", stage, reason }, manifest: m, notes };
}

/** Called by the stage-gate hook after a subagent stops with all gates passed. */
export function markStageDone(m: Manifest, stage: string, outputs: string[] = []): void {
  const rec = stageRecord(m, stage);
  rec.status = "done";
  rec.ended_at = nowIso();
  rec.outputs = outputs;
  m.next_allowed_stages = [];
}

/** Provisional tier from intake (risk-floor gate may only RAISE it, never lower — mechanical floor, P8). */
export function applyTier(m: Manifest, tier: Tier, source: Manifest["tier_source"]): void {
  const order: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  if (m.tier === "UNSET" || order[tier] > order[m.tier as string] || source === "human") {
    m.tier = tier;
    m.tier_source = source;
  }
}
export type Tier = CfgTier;

export function describeGates(g: GateRecord[]): string {
  return g.map((x) => `${x.name}=${x.status}`).join(", ");
}
