/**
 * approvals.ts — human decisions are FILES with a recorded origin.
 * Origin "user_prompt_submit" can only be produced by the UserPromptSubmit hook (i.e. the human typed it).
 * Origin "cli"/"ui" come from sfsmiths-human, which agents cannot run.
 */
import os from "node:os";
import path from "node:path";
import { emitEvent } from "../core/events.js";
import { loadManifest, saveManifest, type Approval, type Manifest } from "../core/manifest.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { nowIso, tsCompact, writeJsonAtomic, SfsmithsError } from "../core/util.js";

export interface ApprovalInput {
  ticket: string;
  stage?: string;               // default: the stage the ticket is waiting on
  decision: Approval["decision"];
  origin: Approval["origin"];
  answer?: string;
  reason?: string;
  edits?: string;
  by?: string;
}

export function recordApproval(input: ApprovalInput, p: ProjectPaths = projectPaths()): { manifest: Manifest; approval: Approval; file: string } {
  const m = loadManifest(input.ticket, p);
  const stage = input.stage ?? m.waiting?.stage ?? m.stage;
  if (m.waiting && m.waiting.kind === "approval" && input.stage && input.stage !== m.waiting.stage) {
    throw new SfsmithsError(`Ticket ${m.ticket} is waiting for approval of stage "${m.waiting.stage}", not "${input.stage}"`, "WRONG_STAGE");
  }
  if (input.decision !== "rejected" && m.tier === "HIGH" && stage === "plan" && !(input.answer && input.answer.trim().length >= 8)) {
    throw new SfsmithsError(`HIGH tier plan approval needs a typed answer: /approve ${m.ticket} --stage plan --answer "<what you checked>"`, "ANSWER_REQUIRED");
  }
  if (input.decision === "rejected" && !(input.reason && input.reason.trim().length >= 3)) {
    throw new SfsmithsError("A rejection needs --reason (it becomes a lesson candidate)", "REASON_REQUIRED");
  }
  const approval: Approval = {
    stage,
    decision: input.decision,
    by: input.by ?? safeUser(),
    at: nowIso(),
    origin: input.origin,
    answer: input.answer,
    reason: input.reason,
    edits: input.edits,
  };
  m.approvals.push(approval);
  // a decision on the waited stage releases the wait; handoff will advance/bounce
  if (m.waiting && m.waiting.stage === stage && m.waiting.kind === "approval") {
    m.status = "running";
    m.waiting = null; // handoff decides what follows (advance on approval, restart on rejection)
  }
  saveManifest(m, p);
  const file = path.join(vaultDir(p, m.ticket), "approvals", `${stage}-${tsCompact()}.json`);
  writeJsonAtomic(file, approval);
  const type = input.decision === "approved" ? "human.approved" : input.decision === "approved_with_edits" ? "human.approved_with_edits" : "human.rejected";
  emitEvent({ ticket: m.ticket, type, stage, data: { origin: input.origin, has_answer: !!input.answer, reason: input.reason } }, p);
  return { manifest: m, approval, file };
}

export function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "human";
  }
}
