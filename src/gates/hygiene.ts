/**
 * email-guard · naming-lint · comment-lint · comms-lint · security · test-quality
 */
import fs from "node:fs";
import path from "node:path";
import { exists, listFiles, readText, walkFiles } from "../core/util.js";
import { componentKeyFromPath } from "../core/fingerprint.js";
import { failed, passed, unavailable, type Gate, type GateContext } from "./types.js";
import { changedSourceFiles, hashFiles, readVaultJson } from "./helpers.js";

/* ---------------- email-guard (P9) ---------------- */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export function emailAllowed(email: string, allow: string[]): boolean {
  return allow.some((g) => globToRegex(g).test(email));
}

/** Files the email-guard scans: vault artifacts (test data, scripts) + changed source files. */
async function emailGuardTargets(ctx: GateContext): Promise<string[]> {
  const targets: string[] = [];
  const art = path.join(ctx.vault, "artifacts");
  for (const f of walkFiles(art)) if (/\.(json|csv|apex|cls|txt|md|yaml|yml|js|ts|xml)$/i.test(f)) targets.push(path.join(art, f));
  for (const f of await changedSourceFiles(ctx)) targets.push(path.join(ctx.p.root, f));
  return targets;
}

export const emailGuard: Gate = {
  name: "email-guard",
  description: "No email address outside config/safety.yaml allowlist in test data, scripts or changed code (P9 zero real email).",
  async run(ctx) {
    const allow = ctx.cfg.safety.allowed_test_emails;
    const targets = await emailGuardTargets(ctx);
    const offenders: { file: string; email: string }[] = [];
    for (const f of targets) {
      let text: string;
      try { text = readText(f); } catch { continue; }
      for (const m of text.matchAll(EMAIL_RE)) {
        const e = m[0];
        if (/@example\.(com|org|net)$/i.test(e) && allow.some((g) => g.includes("example."))) continue;
        if (!emailAllowed(e, allow)) offenders.push({ file: path.relative(ctx.p.root, f), email: mask(e) });
      }
    }
    if (offenders.length) {
      return failed("email-guard", `${offenders.length} non-allowlisted email address(es): ${offenders.slice(0, 5).map((o) => `${o.email} in ${o.file}`).join("; ")}`,
        { details: { offenders }, reward_events: ["email_guard.blocked"], artifact_hash: hashFiles(targets) });
    }
    return passed("email-guard", `${targets.length} file(s) scanned, all addresses allowlisted`, { artifact_hash: hashFiles(targets) });
  },
};

function mask(email: string): string {
  const [u, d] = email.split("@");
  return `${u.slice(0, 2)}***@${d}`;
}

/* ---------------- naming-lint (G9) ---------------- */

type RuleKey = "apex_class" | "apex_test_class" | "apex_trigger" | "flow" | "custom_field" | "custom_object" | "validation_rule" | "test_record" | "permission_set";

function ruleForComponent(key: string, filePath: string): RuleKey | undefined {
  const [type] = key.split(":");
  switch (type) {
    case "ApexClass": return /Test\.cls$/.test(filePath) || /@IsTest/i.test(safeRead(filePath)) ? "apex_test_class" : "apex_class";
    case "ApexTrigger": return "apex_trigger";
    case "Flow": return "flow";
    case "CustomField": return "custom_field";
    case "CustomObject": return "custom_object";
    case "ValidationRule": return "validation_rule";
    case "PermissionSet": return "permission_set";
    default: return undefined;
  }
}
function safeRead(f: string): string {
  try { return readText(f); } catch { return ""; }
}

export function wordCount(name: string): number {
  // CamelCase / snake_case / spaces → words; drop ticket keys and pure numbers
  const cleaned = name.replace(/__c$|__r$/g, "").replace(/[A-Z][A-Z0-9_]{0,15}-\d{1,8}/g, " ");
  const words = cleaned.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z]+/).filter((w) => w.length > 1 && !/^\d+$/.test(w));
  return words.length;
}

export function checkName(name: string, rule: { pattern: string; min_words?: number }, ticketRe: RegExp, forbidTicketOnly: boolean): string | undefined {
  if (!new RegExp(rule.pattern).test(name)) return `"${name}" does not match ${rule.pattern}`;
  if (forbidTicketOnly) {
    const stripped = name.replace(ticketRe, "").replace(/[^A-Za-z]/g, "");
    if (stripped.length < 4) return `"${name}" is only a ticket number/placeholder — give it a purpose-based name`;
    if (/^(test|temp|tmp|fix|new|record|item|thing|foo|bar)\d*$/i.test(stripped)) return `"${name}" is a placeholder name`;
    // a hyphen-less ticket key baked into the name (PROJ1234Class, Test_PROJ1234, Fix1234) is still a ticket-number name
    if (/(^|[^A-Za-z])[A-Z]{2,}_?\d{3,}/.test(name) || /^[A-Za-z]{1,5}\d{3,}/.test(name)) return `"${name}" embeds a ticket-like key — name the purpose instead (the ticket goes in the modification log / tag field)`;
  }
  if (rule.min_words && wordCount(name) < rule.min_words) return `"${name}" needs ≥${rule.min_words} descriptive words`;
  return undefined;
}

export const namingLint: Gate = {
  name: "naming-lint",
  description: "Changed components and test records have purpose-based names (config/naming.yaml); ticket tag lives in the tag field, not the name.",
  async run(ctx) {
    const n = ctx.cfg.naming;
    const ticketRe = new RegExp(n.ticket_key_regex, "g");
    const problems: string[] = [];
    // components
    const files = await changedSourceFiles(ctx);
    for (const f of files) {
      const key = componentKeyFromPath(f);
      if (!key) continue;
      const rk = ruleForComponent(key, path.join(ctx.p.root, f));
      if (!rk) continue;
      const name = key.split(":")[1].split(".").pop() ?? "";
      const err = checkName(name, n.rules[rk], ticketRe, n.forbid_ticket_only_names);
      if (err) problems.push(`${key}: ${err}`);
    }
    // test records (artifacts/test-data/*.json — arrays or objects with Name/Subject/Title)
    const tdDir = path.join(ctx.vault, "artifacts", "test-data");
    let records = 0;
    for (const f of listFiles(tdDir, (x) => x.endsWith(".json"))) {
      let data: unknown;
      try { data = JSON.parse(readText(f)); } catch { problems.push(`${path.basename(f)}: invalid JSON`); continue; }
      const rows: Record<string, unknown>[] = Array.isArray(data) ? data as Record<string, unknown>[] : (data && typeof data === "object" && Array.isArray((data as { records?: unknown }).records)) ? (data as { records: Record<string, unknown>[] }).records : [data as Record<string, unknown>];
      for (const r of rows) {
        records++;
        const label = String(r.Name ?? r.Subject ?? r.Title ?? r.LastName ?? "");
        if (label) {
          const err = checkName(label, n.rules.test_record, ticketRe, n.forbid_ticket_only_names);
          if (err) problems.push(`${path.basename(f)}: ${err}`);
        }
        const tag = r[ctx.cfg.safety.test_tag_field];
        if (tag === undefined) problems.push(`${path.basename(f)}: record missing ${ctx.cfg.safety.test_tag_field} tag`);
        else if (!String(tag).startsWith(ctx.cfg.safety.test_tag_prefix)) problems.push(`${path.basename(f)}: tag must start with ${ctx.cfg.safety.test_tag_prefix}`);
      }
    }
    if (problems.length) return failed("naming-lint", problems.slice(0, 8).join("; "), { details: { problems }, reward_events: ["naming.fail"] });
    return passed("naming-lint", `${files.length} component file(s), ${records} test record(s) checked`);
  },
};

/* ---------------- comment-lint (G11) ---------------- */

export interface CommentFinding { file: string; issue: string }

export function lintApexComments(src: string, ticket: string, opts: { requireModLog: boolean }): string[] {
  const issues: string[] = [];
  const head = src.slice(0, 1500);
  if (!/\/\*\*[\s\S]*?\*\/\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|global|private|protected)?\s*(?:with|without|inherited)?\s*(?:sharing)?\s*(?:virtual|abstract)?\s*(class|trigger|interface|enum)/i.test(head)) issues.push("missing header doc block (/** ... */) before the class/trigger");
  if (opts.requireModLog && !new RegExp(ticket.replace(/[-]/g, "\\-")).test(src)) issues.push(`missing modification-log entry mentioning ${ticket}`);
  // public/global methods need a doc comment right above
  const methodRe = /^[ \t]*(?:@\w+(?:\([^)]*\))?\s*)*(public|global)\s+(?:static\s+)?(?:override\s+)?(?:virtual\s+)?(?!class|interface|enum)[\w<>\[\],\s]+?\s+(\w+)\s*\([^)]*\)\s*\{/gm;
  const lines = src.split("\n");
  for (const m of src.matchAll(methodRe)) {
    const idx = src.slice(0, m.index ?? 0).split("\n").length - 1;
    let j = idx - 1;
    while (j >= 0 && /^\s*@/.test(lines[j])) j--;
    const above = lines.slice(Math.max(0, j - 12), j + 1).join("\n");
    if (!/\*\/\s*$/.test(above.trimEnd()) && !/\/\/\s*\S+/.test(lines[j] ?? "")) issues.push(`method ${m[2]}() has no doc comment`);
  }
  if (/\bTODO\b(?![^\n]*[A-Z][A-Z0-9_]*-\d+)/.test(src)) issues.push("TODO without a ticket reference");
  return issues;
}

export function lintMetadataDescription(xml: string): string | undefined {
  if (!/<description>[^<]{3,}<\/description>/.test(xml)) return "missing <description>";
  return undefined;
}

export const commentLint: Gate = {
  name: "comment-lint",
  description: "Changed code carries the team's comment conventions: header doc, method docs, modification log with ticket, metadata descriptions.",
  async run(ctx) {
    const scope = ctx.options.scope ?? (ctx.stage === "repro" ? "tests" : "all");
    const files = await changedSourceFiles(ctx);
    const findings: CommentFinding[] = [];
    let checked = 0;
    for (const rel of files) {
      const full = path.join(ctx.p.root, rel);
      if (!exists(full)) continue;
      if (/\.(cls|trigger)$/.test(rel)) {
        const src = readText(full);
        const isTest = /@IsTest/i.test(src) || /Test\.cls$/.test(rel);
        if (scope === "tests" && !isTest) continue;
        checked++;
        for (const i of lintApexComments(src, ctx.ticket, { requireModLog: !isTest || scope === "all" })) findings.push({ file: rel, issue: i });
      } else if (scope === "all" && /\.(flow|field|validationRule|object|permissionset|quickAction|flexipage)-meta\.xml$/.test(rel)) {
        checked++;
        const i = lintMetadataDescription(readText(full));
        if (i) findings.push({ file: rel, issue: i });
      } else if (scope === "all" && /\/lwc\/[^/]+\/[^/]+\.js$/.test(rel)) {
        checked++;
        const src = readText(full);
        if (!/^\s*(\/\*\*|\/\/)/.test(src)) findings.push({ file: rel, issue: "missing header comment" });
      }
    }
    if (findings.length) return failed("comment-lint", findings.slice(0, 8).map((f) => `${path.basename(f.file)}: ${f.issue}`).join("; "), { details: { findings, scope }, reward_events: ["comment.fail"] });
    return passed("comment-lint", `${checked} file(s) checked (scope=${scope})`);
  },
};

/* ---------------- comms-lint ---------------- */

export const commsLint: Gate = {
  name: "comms-lint",
  description: "Drafts have an audience header, no forbidden internal terms in client-visible drafts, no secrets/URLs/emails outside allowlist.",
  async run(ctx) {
    const dir = path.join(ctx.vault, "10-comms");
    const files = listFiles(dir, (n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md");
    if (!files.length) return failed("comms-lint", "no drafts in 10-comms/");
    const forbiddenFile = path.join(ctx.p.knowledge, "guards", "comms-forbidden.txt");
    const forbidden = exists(forbiddenFile) ? readText(forbiddenFile).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
    const problems: string[] = [];
    for (const f of files) {
      const text = readText(f);
      const audience = text.match(/^audience:\s*(client-visible|internal)\s*$/im)?.[1];
      if (!audience) { problems.push(`${path.basename(f)}: missing 'audience: client-visible|internal' header line`); continue; }
      if (audience === "client-visible") {
        for (const term of forbidden) if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) problems.push(`${path.basename(f)}: forbidden term "${term}" in client-visible draft`);
        for (const m of text.matchAll(EMAIL_RE)) problems.push(`${path.basename(f)}: client-visible drafts carry no email addresses (${mask(m[0])})`);
      } else {
        // internal drafts: only allowlisted test addresses — a real person's address in a draft is a leak (P9/FERPA)
        for (const m of text.matchAll(EMAIL_RE)) if (!emailAllowed(m[0], ctx.cfg.safety.allowed_test_emails)) problems.push(`${path.basename(f)}: non-allowlisted email ${mask(m[0])} in an internal draft — refer to people by role`);
      }
      if (/(?:sk|key|token|secret)[-_ ]?[A-Za-z0-9]{16,}/i.test(text) || /\b00D[A-Za-z0-9]{12,15}\b/.test(text)) problems.push(`${path.basename(f)}: looks like a secret/org id`);
      if (/<untrusted/i.test(text)) problems.push(`${path.basename(f)}: raw untrusted envelope leaked into a draft`);
    }
    if (problems.length) return failed("comms-lint", problems.slice(0, 8).join("; "), { details: { problems } });
    return passed("comms-lint", `${files.length} draft(s) ok`);
  },
};

/* ---------------- security ruleset ---------------- */

export function apexSecurityFindings(src: string, file: string): string[] {
  const out: string[] = [];
  if (/\bwithout sharing\b/i.test(src)) out.push(`${file}: 'without sharing' — justify in review or use inherited/with sharing`);
  // dynamic SOQL built by concatenation (anywhere in the call) or from a bare variable, without escapeSingleQuotes → injection risk
  if ((/Database\.(query|countQuery|getQueryLocator)\s*\([^;]*?\+/.test(src) || /Database\.(query|countQuery|getQueryLocator)\s*\(\s*\w+\s*\)/.test(src)) && !/escapeSingleQuotes/.test(src)) out.push(`${file}: dynamic SOQL without String.escapeSingleQuotes / bind variables`);
  if (/\b[a-zA-Z0-9]{18}\b/.test(src) && /'[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?'/.test(src) && /(Id|ID)\s*=\s*'/.test(src)) out.push(`${file}: hard-coded record Id`);
  if (/\bSeeAllData\s*=\s*true/i.test(src)) out.push(`${file}: @IsTest(SeeAllData=true)`);
  if (/(?:System\.)?debug\s*\(\s*(?:LoggingLevel\.\w+\s*,\s*)?[^)]*(password|token|secret)/i.test(src)) out.push(`${file}: logging a secret-looking value`);
  if (/\bHttpRequest\b/.test(src) && !/Named\s*Credential|callout:/i.test(src)) out.push(`${file}: callout without Named Credential (callout: prefix)`);
  return out;
}

export const securityGate: Gate = {
  name: "security",
  description: "Static security ruleset on changed Apex + review contract declares CRUD/FLS and sharing posture.",
  async run(ctx) {
    const files = await changedSourceFiles(ctx);
    const findings: string[] = [];
    for (const rel of files) {
      if (!/\.(cls|trigger)$/.test(rel)) continue;
      findings.push(...apexSecurityFindings(readText(path.join(ctx.p.root, rel)), path.basename(rel)));
    }
    const review = readVaultJson<{ security?: { crud_fls?: string; sharing?: string; injection?: string; findings?: unknown[] } }>(ctx, "06-review.json");
    if (ctx.stage === "review") {
      if (!review) return unavailable("security", "06-review.json missing");
      if (!review.security?.crud_fls || !review.security?.sharing) findings.push("06-review.json: security section must state crud_fls and sharing posture");
    }
    if (findings.length) return failed("security", findings.slice(0, 8).join("; "), { details: { findings } });
    return passed("security", `${files.filter((f) => /\.(cls|trigger)$/.test(f)).length} Apex file(s) clean`);
  },
};

/* ---------------- test-quality ---------------- */

export function testQualityFindings(src: string, file: string): string[] {
  const out: string[] = [];
  if (!/@IsTest/i.test(src)) return out;
  const methods = [...src.matchAll(/@IsTest\s*(?:\([^)]*\))?\s*(?:static\s+)?(?:void\s+)?(\w+)\s*\(/gi)].map((m) => m[1]).filter((n) => !/^(setup|makeData|setupData|testSetup)$/i.test(n));
  for (const name of methods) {
    const body = methodBody(src, name);
    if (!body) continue;
    if (!/\b(System\.assert\w*|Assert\.\w+)\s*\(/.test(body)) out.push(`${file}.${name}(): no assertion`);
  }
  if (/SeeAllData\s*=\s*true/i.test(src)) out.push(`${file}: SeeAllData=true`);
  if (!/\b(200|201|250|bulk)\b/i.test(src)) out.push(`${file}: no bulk (200 records) test evidence`);
  return out;
}

function methodBody(src: string, name: string): string | undefined {
  const i = src.search(new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (i < 0) return undefined;
  let depth = 0;
  let start = -1;
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") { if (depth === 0) start = k; depth++; }
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(start, k + 1); }
  }
  return undefined;
}

export const testQuality: Gate = {
  name: "test-quality",
  description: "Every test method asserts; no SeeAllData; bulk (200) coverage present for Apex changes.",
  async run(ctx) {
    const files = (await changedSourceFiles(ctx)).filter((f) => /\.cls$/.test(f));
    const findings: string[] = [];
    let tests = 0;
    for (const rel of files) {
      const src = readText(path.join(ctx.p.root, rel));
      if (!/@IsTest/i.test(src)) continue;
      tests++;
      findings.push(...testQualityFindings(src, path.basename(rel, ".cls")));
    }
    const report = readVaultJson<{ tests?: { name: string; outcome: string }[] }>(ctx, ctx.stage === "qa_uat" ? "07-uat-report.json" : "05-test-report.json");
    if (tests === 0 && !report) return unavailable("test-quality", "no test classes changed and no test report");
    const zero = findings.filter((f) => f.includes("no assertion"));
    if (zero.length) return failed("test-quality", findings.slice(0, 8).join("; "), { details: { findings }, reward_events: ["test_quality.zero_assertion"] });
    if (findings.length) return failed("test-quality", findings.slice(0, 8).join("; "), { details: { findings } });
    return passed("test-quality", `${tests} test class(es) ok`);
  },
};


