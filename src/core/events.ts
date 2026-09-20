/**
 * events.ts — append-only event log per ticket (work/<T>/events.jsonl) + global mirror.
 * events.jsonl is the ONLY evidence A7 (coach) may use (P7). Rewards are computed from it.
 */
import path from "node:path";
import { projectPaths, vaultDir, type ProjectPaths } from "./paths.js";
import { appendLine, nowIso, readJsonl } from "./util.js";

export type EventType =
  | "ticket.opened" | "ticket.resumed" | "ticket.held" | "ticket.parked" | "ticket.escalated" | "ticket.done" | "ticket.failed" | "ticket.restarted"
  | "stage.started" | "stage.done" | "stage.bounced" | "stage.blocked" | "stage.recovered" | "stage.waiting_agent"
  | "agent.notification"
  | "gate.passed" | "gate.failed" | "gate.unavailable"
  | "human.approved" | "human.approved_with_edits" | "human.rejected" | "human.question" | "human.feedback"
  | "agent.spawn_denied" | "policy.denied" | "write.denied" | "stop.blocked" | "stop.cap_hit"
  | "escalation.honest" | "escalation.weak"
  | "baseline.synced" | "baseline.stopped" | "baseline.decision"
  | "prior_art.found" | "prior_art.none"
  | "canary.pass" | "canary.fail" | "canary.unknown"
  | "email_guard.blocked"
  | "deploy.dev" | "deploy.marked" | "prod.verified" | "remediation.verified" | "escaped_defect"
  | "uat.parity_ok" | "uat.parity_failed" | "human.parity_accepted"
  | "budget.exceeded" | "tokens.recorded" | "test.run"
  | "lesson.candidate" | "lesson.approved" | "lesson.rejected" | "lesson.promoted" | "lesson.retired" | "lesson.reverted"
  | "resume.classified" | "tracker.changed";

export interface SfEvent {
  ts: string;
  ticket: string;
  type: EventType;
  stage?: string;
  agent?: string;
  session_id?: string;
  data?: Record<string, unknown>;
}

export function eventsFile(p: ProjectPaths, ticket: string): string {
  return path.join(vaultDir(p, ticket), "events.jsonl");
}

export function emitEvent(ev: Omit<SfEvent, "ts">, p: ProjectPaths = projectPaths()): SfEvent {
  const full: SfEvent = { ts: nowIso(), ...ev };
  const line = JSON.stringify(full);
  // ticket "-" (or empty) = system-level event (human feedback, UI actions): global mirror only, no vault dir
  if (ev.ticket && ev.ticket !== "-") appendLine(eventsFile(p, ev.ticket), line);
  appendLine(path.join(p.state, "events.jsonl"), line); // global mirror for learn/dashboard
  return full;
}

export function readEvents(ticket: string, p: ProjectPaths = projectPaths()): SfEvent[] {
  return readJsonl<SfEvent>(eventsFile(p, ticket));
}

export function readAllEvents(p: ProjectPaths = projectPaths()): SfEvent[] {
  return readJsonl<SfEvent>(path.join(p.state, "events.jsonl"));
}
