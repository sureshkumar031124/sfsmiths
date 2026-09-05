/**
 * git.ts — minimal git helper (snapshots, commits, log grep for prior art).
 * The agent never pushes anywhere; Blue Canvas remotes are denied by policy (P1b).
 */
import { run } from "./shell.js";

export async function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await run("git", args, { cwd, timeoutMs: 120_000 });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(["rev-parse", "--is-inside-work-tree"], cwd)).ok;
}

export async function commitAll(cwd: string, message: string, paths: string[] = ["."]): Promise<{ ok: boolean; sha?: string; note?: string }> {
  if (!(await isRepo(cwd))) return { ok: false, note: "not a git repo" };
  await git(["add", "--", ...paths], cwd);
  const status = await git(["status", "--porcelain"], cwd);
  if (!status.out) return { ok: true, note: "nothing to commit" };
  const c = await git(["commit", "-q", "-m", message], cwd);
  if (!c.ok) return { ok: false, note: c.err };
  const sha = (await git(["rev-parse", "--short", "HEAD"], cwd)).out;
  return { ok: true, sha };
}

export async function remotes(cwd: string): Promise<{ name: string; url: string }[]> {
  const r = await git(["remote", "-v"], cwd);
  if (!r.ok) return [];
  const out: { name: string; url: string }[] = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (m) out.push({ name: m[1], url: m[2] });
  }
  return out;
}

/** git log --grep <pattern> -- <path>: [{sha, date, subject}] */
export async function logGrep(cwd: string, pattern: string, pathFilter?: string, max = 50): Promise<{ sha: string; date: string; subject: string }[]> {
  const args = ["log", `--max-count=${max}`, "--date=short", "--format=%h%x09%ad%x09%s", "-i", `--grep=${pattern}`];
  if (pathFilter) args.push("--", pathFilter);
  const r = await git(args, cwd);
  if (!r.ok || !r.out) return [];
  return r.out.split(/\r?\n/).map((l) => {
    const [sha, date, ...rest] = l.split("\t");
    return { sha, date, subject: rest.join("\t") };
  });
}

/** commits touching a path in the last N days */
export async function logPath(cwd: string, pathFilter: string, sinceDays = 365, max = 50): Promise<{ sha: string; date: string; subject: string }[]> {
  const r = await git(["log", `--max-count=${max}`, `--since=${sinceDays} days ago`, "--date=short", "--format=%h%x09%ad%x09%s", "--", pathFilter], cwd);
  if (!r.ok || !r.out) return [];
  return r.out.split(/\r?\n/).map((l) => {
    const [sha, date, ...rest] = l.split("\t");
    return { sha, date, subject: rest.join("\t") };
  });
}

export async function diffNames(cwd: string, from: string, to = "HEAD"): Promise<string[]> {
  const r = await git(["diff", "--name-only", from, to], cwd);
  return r.ok && r.out ? r.out.split(/\r?\n/) : [];
}
