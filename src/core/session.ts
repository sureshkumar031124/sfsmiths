/**
 * session.ts — which ticket is a Claude Code session working on?
 *
 * Hooks receive `session_id`; the toolkit stores session→ticket under .sfsmiths/sessions/<id>.json.
 * `work/.active-ticket` is a convenience pointer for single-ticket use (Phase 1-2).
 * Also tracks whether the session is a conductor session (agent_type === "conductor" on hooks).
 */
import path from "node:path";
import { projectPaths, type ProjectPaths } from "./paths.js";
import { exists, readJsonOr, writeJsonAtomic, writeTextAtomic, readTextOr, nowIso } from "./util.js";

export interface SessionInfo {
  session_id: string;
  ticket?: string;
  conductor: boolean;
  started_at: string;
  updated_at: string;
  cwd?: string;
}

function sessionFile(p: ProjectPaths, id: string): string {
  return path.join(p.state, "sessions", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function getSession(id: string, p: ProjectPaths = projectPaths()): SessionInfo | undefined {
  return readJsonOr<SessionInfo | undefined>(sessionFile(p, id), undefined);
}

export function upsertSession(id: string, patch: Partial<SessionInfo>, p: ProjectPaths = projectPaths()): SessionInfo {
  const cur = getSession(id, p) ?? { session_id: id, conductor: false, started_at: nowIso(), updated_at: nowIso() };
  const next: SessionInfo = { ...cur, ...patch, session_id: id, updated_at: nowIso() };
  writeJsonAtomic(sessionFile(p, id), next);
  return next;
}

export function setActiveTicket(ticket: string, p: ProjectPaths = projectPaths()): void {
  writeTextAtomic(path.join(p.work, ".active-ticket"), ticket + "\n");
}

export function getActiveTicket(p: ProjectPaths = projectPaths()): string | undefined {
  const t = readTextOr(path.join(p.work, ".active-ticket"), "").trim();
  return t || undefined;
}

/** Ticket for a hook call: session mapping first, then the active pointer. */
export function ticketForSession(sessionId: string | undefined, p: ProjectPaths = projectPaths()): string | undefined {
  if (sessionId) {
    const s = getSession(sessionId, p);
    if (s?.ticket) return s.ticket;
  }
  return getActiveTicket(p);
}

export function isConductorSession(sessionId: string | undefined, agentType: string | undefined, p: ProjectPaths = projectPaths()): boolean {
  if (agentType === "conductor") return true;
  if (!sessionId) return false;
  return getSession(sessionId, p)?.conductor === true;
}

export function sessionsDirExists(p: ProjectPaths = projectPaths()): boolean {
  return exists(path.join(p.state, "sessions"));
}
