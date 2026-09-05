/**
 * util.ts — small, dependency-free helpers used everywhere.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function tsCompact(d: Date = new Date()): string {
  // 2026-09-05T13-24-05Z — filesystem-safe timestamp
  return d.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function shortHash(data: string | Buffer, n = 12): string {
  return sha256(data).slice(0, n);
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readText(p: string): string {
  return fs.readFileSync(p, "utf8");
}

export function readTextOr(p: string, fallback: string): string {
  return exists(p) ? readText(p) : fallback;
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeTextAtomic(p: string, content: string): void {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(readText(p)) as T;
}

export function readJsonOr<T>(p: string, fallback: T): T {
  if (!exists(p)) return fallback;
  try {
    return readJson<T>(p);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(p: string, value: unknown): void {
  writeTextAtomic(p, JSON.stringify(value, null, 2) + "\n");
}

export function appendLine(p: string, line: string): void {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, line.endsWith("\n") ? line : line + "\n", "utf8");
}

export function readLines(p: string): string[] {
  if (!exists(p)) return [];
  return readText(p).split(/\r?\n/).filter((l) => l.trim().length > 0);
}

export function readJsonl<T = unknown>(p: string): T[] {
  const out: T[] = [];
  for (const line of readLines(p)) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip corrupt line — never crash a gate on a bad log line */
    }
  }
  return out;
}

export function safeJsonParse<T = unknown>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

export function listFiles(dir: string, filter?: (name: string) => boolean): string[] {
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && (!filter || filter(d.name)))
    .map((d) => path.join(dir, d.name))
    .sort();
}

export function listDirs(dir: string): string[] {
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name))
    .sort();
}

/** Recursively list files under dir (relative paths), skipping node_modules/.git. */
export function walkFiles(dir: string, opts: { maxFiles?: number } = {}): string[] {
  const out: string[] = [];
  const max = opts.maxFiles ?? 50_000;
  const walk = (d: string) => {
    if (out.length >= max || !exists(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(path.relative(dir, full));
      if (out.length >= max) return;
    }
  };
  walk(dir);
  return out.sort();
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function daysBetween(aIso: string, bIso: string): number {
  return Math.abs(new Date(bIso).getTime() - new Date(aIso).getTime()) / 86_400_000;
}

/** Wrap untrusted text (P7): evidence, never instruction. */
export function envelope(source: string, text: string): string {
  const safe = String(text ?? "").replace(/<\/?untrusted[^>]*>/gi, "");
  return `<untrusted source="${source}">\n${safe}\n</untrusted>`;
}

export class SfsmithsError extends Error {
  constructor(message: string, public readonly code: string = "SFSMITHS_ERROR", public readonly details?: unknown) {
    super(message);
    this.name = "SfsmithsError";
  }
}
