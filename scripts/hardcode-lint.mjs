#!/usr/bin/env node
/**
 * scripts/hardcode-lint.mjs — nothing company-specific may be published.
 *
 * Anyone must be able to clone SFsmiths and configure their own orgs/tracker/emails. This lint fails the build when a
 * TRACKED file (what `git ls-files` would publish; falls back to a tree walk outside git) contains: a real-looking ticket
 * key, a real e-mail address, a Salesforce org id, a real instance hostname, or anything you list yourself.
 *
 * Your own company names, project keys and hostnames belong in `.hardcode-lint.json` at the repo root — gitignored, so
 * the rule protects your clone without publishing the very names it protects:
 *   { "forbidden": ["acme corp", "acme-corp", "\\bACM-\\d+"] }
 * (`.hardcode-lint.json.example` shows the shape.) CI cannot know your names; the generic rules below still catch
 * addresses, org ids and hostnames on every push.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = fs.existsSync(path.join(repo, ".hardcode-lint.json")) ? JSON.parse(fs.readFileSync(path.join(repo, ".hardcode-lint.json"), "utf8")) : {};

// documentation-safe Jira keys used in examples; anything else that looks like PROJECT-123 is somebody's real ticket
const DOC_KEYS = ["DEMO", "PROJ", "PROJECT", "SFS", "KEY", "YOUR", "ABC", "XYZ", "TEST", "TICKET", "OTHER"];
const FORBIDDEN = [
  // 2–10 letters, a dash, 3–6 digits (real projects number past 100 quickly); one-letter ids (D-093, L-2026…) and dotted/ranged tokens are not keys
  { re: new RegExp(`(?<![A-Za-z0-9_/.-])(?!(?:${DOC_KEYS.join("|")})-)[A-Z]{2,10}-\\d{3,6}(?![A-Za-z0-9_.-])`), why: "real-looking ticket key (use DEMO-101 / PROJ-123 in examples)" },
  { re: /[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)(?!sfsmiths\.invalid\b)(?!yourcompany\.example\b)(?!\w+\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: "email address outside the documentation-safe domains" },
  { re: /\b00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/, why: "Salesforce org id" },
  { re: /https?:\/\/(?!test\.salesforce\.com|login\.salesforce\.com|developer\.salesforce\.com|help\.salesforce\.com|architect\.salesforce\.com|trailhead\.salesforce\.com|admin\.salesforce\.com|engineering\.salesforce\.com|release\.salesforce\.com|www\.salesforce\.com|salesforce\.com|github\.com|www\.npmjs\.com|code\.claude\.com|docs\.claude\.com|json\.schemastore\.org|json-schema\.org|anthropic\.com|www\.anthropic\.com|127\.0\.0\.1|localhost|your-dev-sandbox\.sandbox\.my\.salesforce\.com|acme|soap\.sforce\.com)[a-z0-9.-]*\.(my\.salesforce\.com|lightning\.force\.com|force\.com|my\.site\.com)/i, why: "real instance hostname" },
  ...(local.forbidden ?? []).map((s) => ({ re: new RegExp(s, "i"), why: "local rule (.hardcode-lint.json)" })),
];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "work", "inbox", "metrics", ".sfsmiths", "org", "knowledge", "test"]); // test/ holds deliberate negative fixtures (fake emails/hosts the guards must reject)
const SKIP_FILES = new Set(["package-lock.json", ".hardcode-lint.json", ".hardcode-lint.json.example", "settings.local.json", ".mcp.json"]);
const TEXT_EXT = /\.(ts|mjs|js|json|md|yaml|yml|txt|apex|cls|xml|html|css|sh|cmd|toml)$/;

/** What would be published: tracked files when inside git, else every text file under the repo. */
function candidateFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split("\0").filter(Boolean);
    if (files.length) return files;
  } catch { /* not a git checkout */ }
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      files.push(path.relative(repo, full).replace(/\\/g, "/"));
    }
  };
  walk(repo);
  return files;
}

const problems = [];
for (const rel of candidateFiles()) {
  const top = rel.split("/")[0];
  if (SKIP_DIRS.has(top) && !rel.startsWith("knowledge/mirror/sources.yaml")) continue;
  if (!TEXT_EXT.test(rel) || SKIP_FILES.has(path.basename(rel))) continue;
  if (/^config\/[^/]+\.ya?ml$/.test(rel)) continue; // personal config (gitignored anyway) — config/defaults/ IS scanned
  if (rel === "scripts/hardcode-lint.mjs") continue;
  const full = path.join(repo, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const f of FORBIDDEN) if (f.re.test(line)) problems.push(`${rel}:${i + 1}: ${f.why} — ${line.trim().slice(0, 120)}`);
  });
}
// config/ must not contain secrets either (tokens belong in env vars)
for (const f of fs.existsSync(path.join(repo, "config")) ? fs.readdirSync(path.join(repo, "config")) : []) {
  if (!/\.ya?ml$/.test(f)) continue;
  const text = fs.readFileSync(path.join(repo, "config", f), "utf8");
  if (/(token|password|secret|api[_-]?key)\s*:\s*["']?[A-Za-z0-9_\-./+=]{12,}/i.test(text)) problems.push(`config/${f}: looks like a secret value — use the *_env names instead`);
}
// generated org artefacts must never be tracked, whatever .gitignore says on a given clone
try {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "docs/org-map", ".claude/skills"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  for (const t of tracked) {
    if (/^docs\/org-map\/(?!README\.md$)/.test(t)) problems.push(`${t}: generated org map is tracked — it carries your org id, hostnames and every component name (git rm --cached it)`);
    if (/^\.claude\/skills\/(?!std-)[a-z0-9]+-(comment-conventions|naming-rules)\//.test(t)) problems.push(`${t}: generated org-convention skill is tracked — it carries your org's code samples (git rm --cached it)`);
  }
} catch { /* not a git checkout */ }

if (problems.length) {
  console.error(`hardcode-lint: ${problems.length} problem(s)\n` + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log("hardcode-lint: clean (nothing company-specific in tracked files — config/defaults/ included)");
