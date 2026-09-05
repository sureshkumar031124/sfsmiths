/**
 * paths.ts — where everything lives.
 *
 * Project root resolution order:
 *   1. SFSMITHS_PROJECT_DIR (explicit override, used by tests)
 *   2. CLAUDE_PROJECT_DIR   (set by Claude Code for hooks)
 *   3. walk up from cwd until a directory containing `config/orgs.yaml` AND `.claude/`
 *
 * Nothing here is company-specific. Every location can be overridden by env vars so a
 * user can relocate the runtime state without touching code (hardcode-lint checked).
 */
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface ProjectPaths {
  root: string;            // repo root (contains .claude/, config/, org/, work/)
  config: string;          // <root>/config
  work: string;            // <root>/work  (task vaults, gitignored)
  knowledge: string;       // <root>/knowledge
  docs: string;            // <root>/docs
  org: string;             // <root>/org  (SFDX project)
  forceApp: string;        // <root>/org/force-app
  baseline: string;        // <root>/org/.baseline (gitignored)
  state: string;           // <root>/.sfsmiths (runtime state, gitignored)
  metrics: string;         // <root>/metrics (gitignored)
  templates: string;       // <root>/templates
  schemas: string;         // <root>/schemas
  claude: string;          // <root>/.claude
  agents: string;          // <root>/.claude/agents
  skills: string;          // <root>/.claude/skills
  agentMemory: string;     // <root>/.claude/agent-memory
  spikes: string;          // <root>/spikes
}

export interface HomePaths {
  home: string;            // ~/.sfsmiths
  bin: string;             // ~/.sfsmiths/bin   (installed launchers — hooks call these)
  toolkit: string;         // ~/.sfsmiths/toolkit (installed copy of this package)
  engineHome: string;      // ~/.sfsmiths/engine (HOME for the ENGINE keychain → PartialUAT only)
  sessions: string;        // ~/.sfsmiths/sessions
}

function isRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, "config", "orgs.yaml")) && fs.existsSync(path.join(dir, ".claude"));
}

export function findProjectRoot(start?: string): string {
  const explicit = process.env.SFSMITHS_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR;
  if (explicit && isRoot(explicit)) return path.resolve(explicit);
  let dir = path.resolve(start ?? process.cwd());
  for (let i = 0; i < 12; i++) {
    if (isRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // trust an ABSOLUTE env path even if markers are missing (fresh init); a relative default like "." from .mcp.json is not authoritative
  if (explicit && path.isAbsolute(explicit)) return path.resolve(explicit);
  return path.resolve(start ?? process.cwd());
}

export function projectPaths(root?: string): ProjectPaths {
  const r = root ? path.resolve(root) : findProjectRoot();
  return {
    root: r,
    config: path.join(r, "config"),
    work: path.join(r, "work"),
    knowledge: path.join(r, "knowledge"),
    docs: path.join(r, "docs"),
    org: path.join(r, "org"),
    forceApp: path.join(r, "org", "force-app"),
    baseline: path.join(r, "org", ".baseline"),
    state: path.join(r, ".sfsmiths"),
    metrics: path.join(r, "metrics"),
    templates: path.join(r, "templates"),
    schemas: path.join(r, "schemas"),
    claude: path.join(r, ".claude"),
    agents: path.join(r, ".claude", "agents"),
    skills: path.join(r, ".claude", "skills"),
    agentMemory: path.join(r, ".claude", "agent-memory"),
    spikes: path.join(r, "spikes"),
  };
}

export function homePaths(): HomePaths {
  const home = process.env.SFSMITHS_HOME || path.join(os.homedir(), ".sfsmiths");
  return {
    home,
    bin: path.join(home, "bin"),
    toolkit: path.join(home, "toolkit"),
    engineHome: process.env.SFSMITHS_ENGINE_HOME || path.join(home, "engine"),
    sessions: path.join(home, "sessions"),
  };
}

/** Location of the package's own assets (schemas/, templates/) — works from src or dist. */
export function packageRoot(): string {
  // dist/core/paths.js → package root is two levels up; same for src/core/paths.ts
  const here = path.dirname(fileURLToPath(import.meta.url)); // fileURLToPath: correct on Windows too (no leading "/C:/")
  return path.resolve(here, "..", "..");
}

export function vaultDir(p: ProjectPaths, ticket: string): string {
  return path.join(p.work, sanitizeTicket(ticket));
}

/** Ticket keys are used as folder names — keep them strictly safe. */
export function sanitizeTicket(ticket: string): string {
  const t = String(ticket).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,15}-\d{1,8}$/.test(t)) {
    throw new Error(`Invalid ticket key "${ticket}" — expected PROJECT-123 style (letters, digits, dash).`);
  }
  return t;
}
