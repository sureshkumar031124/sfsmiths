/**
 * setup.ts — first-run wizard. Writes config/*.yaml (never credentials), then sync. Interactive or flag-driven.
 */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfigFile, writeConfigFile, type OrgsConfig, type TrackerConfig, type SafetyConfig, type NotifyConfig } from "../core/config.js";
import { projectPaths, type ProjectPaths } from "../core/paths.js";
import { ensureRuntimeDirs, syncAll } from "./sync.js";

export interface SetupAnswers {
  dev: string; preprod?: string; evidence?: string; readonlyUser?: string;
  tracker: "jira" | "file"; projectKey: string; jiraUrl?: string;
  emails: string[]; tagField: string; slack: boolean;
}

export async function askAll(defaults: Partial<SetupAnswers>, nonInteractive: boolean): Promise<SetupAnswers> {
  if (nonInteractive) {
    if (!defaults.dev || !defaults.projectKey) throw new Error("non-interactive setup needs --dev and --project (and --emails)");
    return { dev: defaults.dev, preprod: defaults.preprod, evidence: defaults.evidence, readonlyUser: defaults.readonlyUser, tracker: defaults.tracker ?? "file", projectKey: defaults.projectKey, jiraUrl: defaults.jiraUrl, emails: defaults.emails?.length ? defaults.emails : ["*@example.com", "*.invalid"], tagField: defaults.tagField ?? "Test_Tag__c", slack: defaults.slack ?? false };
  }
  const rl = readline.createInterface({ input, output });
  // Lines are queued as they arrive, so answers piped in all at once (`printf 'a\nb\n' | sfsmiths-human setup`) are not lost
  // between questions the way rl.question() loses them; a TTY behaves exactly as before. EOF answers "" (= default) to the rest.
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else lines.push(l); });
  rl.on("close", () => { closed = true; for (const w of waiters.splice(0)) w(""); });
  const ask = (prompt: string) => new Promise<string>((resolve) => { output.write(prompt); const l = lines.shift(); if (l !== undefined) resolve(l); else if (closed) resolve(""); else waiters.push(resolve); });
  // Enter keeps the default; typing `none` (or `-`) clears an optional answer — Enter alone can never mean "empty" once a default exists
  const q = async (label: string, def?: string) => { const a = (await ask(`${label}${def ? ` [${def}]` : ""}: `)).trim(); return a === "-" || /^none$/i.test(a) ? "" : a || def || ""; };
  try {
    output.write("\nSFsmiths setup — config only (logins come next with `sfsmiths-human org login`). Enter = default, `none` = skip an optional org.\n\n");
    const dev = await q("Development sandbox alias (agents deploy ONLY here)", defaults.dev ?? "DevSandbox");
    const preprod = await q("Preprod/UAT sandbox alias (baseline source; engine-only) — `none` to skip for now", defaults.preprod ?? "PartialUAT");
    const evidence = await q("Production alias (READ-ONLY evidence) — `none` to skip for now", defaults.evidence ?? "Production");
    const readonlyUser = evidence ? await q("Username of the READ-ONLY production user (admin creates it; no Modify All Data / Modify Metadata / Author Apex)", defaults.readonlyUser ?? "") : "";
    const tracker = (await q("Tracker adapter: jira | file", defaults.tracker ?? "file")).toLowerCase() === "jira" ? "jira" : "file";
    const projectKey = (await q("Tracker project key (e.g. SFS)", defaults.projectKey ?? "DEMO")).toUpperCase();
    const jiraUrl = tracker === "jira" ? await q("Jira base URL", defaults.jiraUrl ?? "https://your-site.atlassian.net") : undefined;
    const emailsRaw = await q("Allowed TEST email patterns, comma separated (your own address pattern too, e.g. you+*@company.com)", (defaults.emails?.length ? defaults.emails : ["*@example.com", "*.invalid"]).join(","));
    const tagField = await q("Custom text field on test records that holds the ticket tag", defaults.tagField ?? "Test_Tag__c");
    const slack = /^y/i.test(await q("Enable Slack notifications (webhook URL via env SFSMITHS_SLACK_WEBHOOK)? y/n", defaults.slack ? "y" : "n"));
    return { dev, preprod: preprod || undefined, evidence: evidence || undefined, readonlyUser: readonlyUser || undefined, tracker, projectKey, jiraUrl, emails: emailsRaw.split(",").map((s) => s.trim()).filter(Boolean), tagField, slack };
  } finally {
    rl.close();
  }
}

export function applyAnswers(a: SetupAnswers, p: ProjectPaths = projectPaths()): string[] {
  const written: string[] = [];
  const orgs: OrgsConfig = { version: 1, default_count: 3, orgs: [{ alias: a.dev, role: "development", keychain: "agent", write: true, email_deliverability: "unknown", deliverability_verified_on: null, deliverability_verified_by: null }] };
  if (a.preprod) orgs.orgs.push({ alias: a.preprod, role: "preprod", keychain: "engine", write: false, email_deliverability: "unknown", deliverability_verified_on: null, deliverability_verified_by: null });
  if (a.evidence) orgs.orgs.push({ alias: a.evidence, role: "evidence", keychain: "agent", write: false, readonly_user: a.readonlyUser ?? "" });
  writeConfigFile("orgs", orgs, p); written.push("config/orgs.yaml");
  const tracker = loadConfigFile("tracker", p) as TrackerConfig;
  tracker.adapter = a.tracker; tracker.project_key = a.projectKey; if (a.jiraUrl) tracker.jira.base_url = a.jiraUrl;
  writeConfigFile("tracker", tracker, p); written.push("config/tracker.yaml");
  const safety = loadConfigFile("safety", p) as SafetyConfig;
  safety.allowed_test_emails = a.emails; safety.test_tag_field = a.tagField;
  writeConfigFile("safety", safety, p); written.push("config/safety.yaml");
  const notify = loadConfigFile("notify", p) as NotifyConfig;
  notify.slack.enabled = a.slack;
  writeConfigFile("notify", notify, p); written.push("config/notify.yaml");
  const policy = loadConfigFile("policy", p);
  policy.allowed_deploy_targets = [a.dev];
  writeConfigFile("policy", policy, p); written.push("config/policy.yaml");
  ensureRuntimeDirs(p);
  syncAll(p);
  written.push(".mcp.json", ".sfsmiths/policy.compiled.json", ".claude/agents/*.md (model lines)");
  return written;
}
