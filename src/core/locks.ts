/**
 * locks.ts — component locks across active tickets (.sfsmiths/locks.json).
 * Two tickets must not edit the same component; baseline sync waits/asks on conflicts.
 */
import path from "node:path";
import { projectPaths, type ProjectPaths } from "./paths.js";
import { readJsonOr, writeJsonAtomic, nowIso } from "./util.js";

export interface LockEntry {
  component: string; // "ApexClass:CaseAutoCloseBatch"
  ticket: string;
  at: string;
  soft?: boolean;    // released softly on hold
}

interface LockFile {
  locks: LockEntry[];
}

function file(p: ProjectPaths) {
  return path.join(p.state, "locks.json");
}

export function readLocks(p: ProjectPaths = projectPaths()): LockEntry[] {
  return readJsonOr<LockFile>(file(p), { locks: [] }).locks;
}

export function acquireLocks(ticket: string, components: string[], p: ProjectPaths = projectPaths()): { acquired: string[]; conflicts: LockEntry[] } {
  const locks = readLocks(p);
  const conflicts = locks.filter((l) => components.includes(l.component) && l.ticket !== ticket && !l.soft);
  const acquired: string[] = [];
  for (const c of components) {
    if (conflicts.some((x) => x.component === c)) continue;
    const idx = locks.findIndex((l) => l.component === c && l.ticket === ticket);
    if (idx >= 0) locks[idx] = { ...locks[idx], soft: false, at: nowIso() };
    else locks.push({ component: c, ticket, at: nowIso() });
    acquired.push(c);
  }
  writeJsonAtomic(file(p), { locks });
  return { acquired, conflicts };
}

export function releaseLocks(ticket: string, opts: { soft?: boolean } = {}, p: ProjectPaths = projectPaths()): void {
  let locks = readLocks(p);
  if (opts.soft) locks = locks.map((l) => (l.ticket === ticket ? { ...l, soft: true } : l));
  else locks = locks.filter((l) => l.ticket !== ticket);
  writeJsonAtomic(file(p), { locks });
}

export function locksFor(ticket: string, p: ProjectPaths = projectPaths()): LockEntry[] {
  return readLocks(p).filter((l) => l.ticket === ticket);
}
