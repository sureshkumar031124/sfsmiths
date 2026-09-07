#!/usr/bin/env node
/**
 * scripts/hardcode-lint.mjs — nothing company-specific may live outside config/ (and inbox/, work/, docs/org-map/).
 *
 * Anyone must be able to clone SFsmiths and configure their own orgs/tracker/emails. This lint fails the build when
 * source, agents, skills, templates, schemas or docs contain: company names, real ticket prefixes, real usernames/emails,
 * Salesforce org ids, instance hostnames. Extend FORBIDDEN in .hardcode-lint.json at the repo root (gitignored → per clone)
 * or in the array below.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = fs.existsSync(path.join(repo, ".hardcode-lint.json")) ? JSON.parse(fs.readFileSync(path.join(repo, ".hardcode-lint.json"), "utf8")) : {};

const FORBIDDEN = [
  { re: /coursedog/i, why: "company name" },
  { re: /\bESD-\d+/i, why: "real ticket prefix" },
  { re: /[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)(?!sfsmiths\.invalid\b)(?!yourcompany\.example\b)(?!\w+\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: "email address outside the documentation-safe domains" },
  { re: /\b00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/, why: "Salesforce org id" },
  { re: /https?:\/\/(?!test\.salesforce\.com|login\.salesforce\.com|developer\.salesforce\.com|github\.com|www\.npmjs\.com|code\.claude\.com|docs\.claude\.com|json\.schemastore\.org|json-schema\.org|anthropic\.com|www\.anthropic\.com|127\.0\.0\.1|localhost|your-dev-sandbox\.sandbox\.my\.salesforce\.com|acme-corp)[a-z0-9.-]*\.(my\.salesforce\.com|lightning\.force\.com|force\.com)/i, why: "real instance hostname" },
  ...(local.forbidden ?? []).map((s) => ({ re: new RegExp(s, "i"), why: "local rule" })),
];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "work", "config", "inbox", "metrics", ".sfsmiths", "org", "knowledge", "test"]); // test/ holds deliberate negative fixtures (fake emails/hosts the guards must reject)
const SKIP_FILES = new Set(["package-lock.json", ".hardcode-lint.json", "settings.local.json", ".mcp.json"]); // settings.local.json + .mcp.json are gitignored, machine-specific (keychain denies, dev alias)
const ALLOW_DIRS = ["docs/org-map"]; // org facts are allowed to be specific — they are generated per clone
const TEXT_EXT = /\.(ts|mjs|js|json|md|yaml|yml|txt|apex|cls|xml|html|css|sh|cmd|toml)$/;

const problems = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(repo, full).replace(/\\/g, "/");
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name) || ALLOW_DIRS.some((a) => rel.startsWith(a))) continue; walk(full); continue; }
    if (!TEXT_EXT.test(e.name) || SKIP_FILES.has(e.name)) continue;
    if (rel === "scripts/hardcode-lint.mjs") continue;
    const text = fs.readFileSync(full, "utf8");
    text.split("\n").forEach((line, i) => {
      for (const f of FORBIDDEN) if (f.re.test(line)) problems.push(`${rel}:${i + 1}: ${f.why} — ${line.trim().slice(0, 120)}`);
    });
  }
}
walk(repo);
// config/ must not contain secrets either (tokens belong in env vars)
for (const f of fs.existsSync(path.join(repo, "config")) ? fs.readdirSync(path.join(repo, "config")) : []) {
  if (!/\.ya?ml$/.test(f)) continue;
  const text = fs.readFileSync(path.join(repo, "config", f), "utf8");
  if (/(token|password|secret|api[_-]?key)\s*:\s*["']?[A-Za-z0-9_\-./+=]{12,}/i.test(text)) problems.push(`config/${f}: looks like a secret value — use the *_env names instead`);
}
if (problems.length) {
  console.error(`hardcode-lint: ${problems.length} problem(s)\n` + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log("hardcode-lint: clean (nothing company-specific outside config/)");
