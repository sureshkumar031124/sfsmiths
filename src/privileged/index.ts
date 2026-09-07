/**
 * privileged/index.ts — org-touching steps the toolkit runs on behalf of agents (P1c/P2):
 *   tests (dev/preprod) · preprod validate-only · dev deploy · retrieve · anonymous Apex (canary-gated) ·
 *   email canary · code analyzer · oracle cache freshen.
 * Every result is a JSON verdict file under work/<T>/validations/ that the gates read. No prose verdicts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, devOrg, preprodOrg, type AllConfig, type Keychain } from "../core/config.js";
import { emitEvent } from "../core/events.js";
import { componentKeyFromPath } from "../core/fingerprint.js";
import { git } from "../core/git.js";
import { loadManifest } from "../core/manifest.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { apexRunAnonymous, apexRunTests, deployStart, describe, orgDisplay, retrieveStart, sf, soql, type ApexTestResult } from "../core/sf.js";
import { run, which } from "../core/shell.js";
import { ensureDir, exists, nowIso, readJsonOr, sha256, tsCompact, uniq, writeJsonAtomic, SfsmithsError } from "../core/util.js";
import { compareExpected } from "../engines/lifecycle.js";
import type { AnalyzerResult, TestRunFile } from "../gates/verdicts.js";
import { notify } from "../engines/notify.js";
import { emailAllowed } from "../gates/hygiene.js";

/* ---------------- shared ---------------- */

export async function changedFiles(p: ProjectPaths, ticket?: string): Promise<string[]> {
  const rel = path.relative(p.root, p.forceApp);
  const base = ticket ? (loadManifest(ticket, p).flags.baseline_commit as string | undefined) : undefined;
  const out = new Set<string>();
  const d = await git(["diff", "--name-only", base ?? "HEAD", "--", rel], p.root);
  if (d.ok) d.out.split(/\r?\n/).filter(Boolean).forEach((f) => out.add(f));
  const u = await git(["ls-files", "--others", "--exclude-standard", "--", rel], p.root);
  if (u.ok) u.out.split(/\r?\n/).filter(Boolean).forEach((f) => out.add(f));
  const s = await git(["diff", "--name-only", "--cached", "--", rel], p.root);
  if (s.ok) s.out.split(/\r?\n/).filter(Boolean).forEach((f) => out.add(f));
  return [...out].filter((f) => exists(path.join(p.root, f))).sort();
}

export function filesHash(p: ProjectPaths, files: string[]): string {
  return sha256(files.filter((f) => exists(path.join(p.root, f))).sort().map((f) => `${f}:${sha256(fs.readFileSync(path.join(p.root, f)))}`).join("\n"));
}

export function componentKeys(files: string[]): string[] {
  return uniq(files.map((f) => componentKeyFromPath(f)).filter((k): k is string => !!k));
}

function orgFor(cfg: AllConfig, which: "dev" | "uat"): { alias: string; keychain: Keychain } {
  if (which === "dev") { const o = devOrg(cfg); return { alias: o.alias, keychain: o.keychain }; }
  const u = preprodOrg(cfg);
  if (!u) throw new SfsmithsError("no preprod org configured", "NO_PREPROD");
  return { alias: u.alias, keychain: u.keychain };
}

/* ---------------- canary (P9 layer 2) ---------------- */

export interface CanaryState { at: string; org: string; result: "pass" | "fail" | "unknown"; detail: string; recipient_masked: string }

export function canaryFile(p: ProjectPaths, alias: string): string {
  return path.join(p.state, "canary", `${alias}.json`);
}

export function canaryFresh(cfg: AllConfig, p: ProjectPaths, alias: string): { fresh: boolean; state?: CanaryState; reason: string } {
  const st = readJsonOr<CanaryState | undefined>(canaryFile(p, alias), undefined);
  if (!st) return { fresh: false, reason: `no canary result for ${alias} — run \`sfsmiths agent canary --org ${alias}\`` };
  const ageMin = (Date.now() - new Date(st.at).getTime()) / 60_000;
  if (st.result !== "pass") return { fresh: false, state: st, reason: `last canary on ${alias} was ${st.result.toUpperCase()}: ${st.detail}` };
  if (ageMin > cfg.safety.canary_max_age_minutes) return { fresh: false, state: st, reason: `canary on ${alias} is ${Math.round(ageMin)} min old (> ${cfg.safety.canary_max_age_minutes}) — rerun` };
  return { fresh: true, state: st, reason: `canary pass ${Math.round(ageMin)} min ago` };
}

export interface CanaryApexResult { success: boolean; errors: { status: string; message: string }[] }

/**
 * Status codes that mean "this org refuses to send user-initiated e-mail" — observed on real sandboxes (Spike 5):
 * a SingleEmailMessage under "System email only" / "No access" fails with NO_SINGLE_MAIL_PERMISSION; mass mail with
 * NO_MASS_MAIL_PERMISSION. Either is a PASS. success:true means the mail left the org → FAIL. Anything else → unknown (P11).
 */
export const CANARY_BLOCKED_STATUSES = ["NO_SINGLE_MAIL_PERMISSION", "NO_MASS_MAIL_PERMISSION"];
export function classifyCanaryResult(res: CanaryApexResult): { result: CanaryState["result"]; detail: string } {
  if (res.success) return { result: "fail", detail: "email SENT — deliverability is All email (or your address is allowlisted in the org). UNSAFE for test data." };
  const blocked = res.errors.find((e) => CANARY_BLOCKED_STATUSES.includes(e.status));
  if (blocked) return { result: "pass", detail: `${blocked.status} — the org blocks outbound e-mail (System email only / No access) confirmed` };
  return { result: "unknown", detail: `unexpected: ${res.errors.map((e) => `${e.status}: ${e.message}`).join("; ") || "no errors, not success"}` };
}

export async function runCanary(alias: string, opts: { p?: ProjectPaths; cfg?: AllConfig } = {}): Promise<CanaryState> {
  const p = opts.p ?? projectPaths();
  const cfg = opts.cfg ?? loadConfig(p);
  const org = cfg.orgs.orgs.find((o) => o.alias.toLowerCase() === alias.toLowerCase());
  if (!org) throw new SfsmithsError(`org ${alias} not in config/orgs.yaml`, "NO_ORG");
  if (org.role === "evidence") throw new SfsmithsError("never send a canary from production", "P1");
  const recipient = process.env[cfg.safety.canary_recipient_env];
  if (!recipient) throw new SfsmithsError(`set ${cfg.safety.canary_recipient_env} to your own address (the canary's only allowed recipient)`, "CANARY_RECIPIENT");
  if (!emailAllowed(recipient, [...cfg.safety.allowed_test_emails, recipient])) throw new SfsmithsError("recipient rejected", "CANARY_RECIPIENT");
  const apex = `
// SFsmiths email canary — proves sandbox deliverability blocks outbound mail (expects NO_SINGLE_MAIL_PERMISSION / NO_MASS_MAIL_PERMISSION)
Messaging.SingleEmailMessage m = new Messaging.SingleEmailMessage();
m.setToAddresses(new String[]{ '${recipient.replace(/'/g, "")}' });
m.setSubject('[SFSMITHS canary] deliverability probe ${nowIso()}');
m.setPlainTextBody('If you received this, the sandbox is NOT on System-email-only. Tell the SFsmiths operator.');
m.setSaveAsActivity(false);
List<Map<String,Object>> errs = new List<Map<String,Object>>();
Boolean ok = false;
try {
  Messaging.SendEmailResult[] r = Messaging.sendEmail(new Messaging.SingleEmailMessage[]{ m }, false);
  ok = r[0].isSuccess();
  for (Messaging.SendEmailError e : r[0].getErrors()) {
    errs.add(new Map<String,Object>{ 'status' => String.valueOf(e.getStatusCode()), 'message' => e.getMessage() });
  }
} catch (Exception ex) {
  errs.add(new Map<String,Object>{ 'status' => 'EXCEPTION:' + ex.getTypeName(), 'message' => ex.getMessage() });
}
System.debug('SFSMITHS_CANARY_RESULT:' + JSON.serialize(new Map<String,Object>{ 'success' => ok, 'errors' => errs }));
`;
  const tmp = path.join(os.tmpdir(), `sfsmiths-canary-${Date.now()}.apex`);
  fs.writeFileSync(tmp, apex, "utf8");
  let state: CanaryState;
  try {
    const r = await apexRunAnonymous(tmp, org.alias, org.keychain);
    const logs = String(r.data?.logs ?? "") + "\n" + r.raw.stdout;
    const m = logs.match(/SFSMITHS_CANARY_RESULT:(\{.*\})/);
    const masked = recipient.replace(/^(.).*(@.*)$/, "$1***$2");
    if (!r.ok && !m) state = { at: nowIso(), org: org.alias, result: "unknown", detail: `anonymous Apex failed: ${r.error ?? r.data?.exceptionMessage ?? "unknown"}`, recipient_masked: masked };
    else if (!m) state = { at: nowIso(), org: org.alias, result: "unknown", detail: "canary marker not found in debug log", recipient_masked: masked };
    else {
      const res = JSON.parse(m[1]) as CanaryApexResult;
      const c = classifyCanaryResult(res);
      state = { at: nowIso(), org: org.alias, result: c.result, detail: c.detail, recipient_masked: masked };
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  writeJsonAtomic(canaryFile(p, org.alias), state);
  emitEvent({ ticket: "-", type: state.result === "pass" ? "canary.pass" : state.result === "fail" ? "canary.fail" : "canary.unknown", data: { org: org.alias, detail: state.detail } }, p);
  if (state.result !== "pass") await notify(cfg, "canary_fail", `${org.alias}: canary ${state.result} — ${state.detail}`);
  return state;
}

/* ---------------- tests ---------------- */

export interface TestOptions { ticket: string; phase: "repro" | "dev" | "uat"; classNames?: string[]; tests?: string[]; p?: ProjectPaths }

export async function privilegedTest(o: TestOptions): Promise<TestRunFile> {
  const p = o.p ?? projectPaths();
  const cfg = loadConfig(p);
  const org = orgFor(cfg, o.phase === "uat" ? "uat" : "dev");
  const vault = vaultDir(p, o.ticket);
  const files = await changedFiles(p, o.ticket);
  // default class selection: changed test classes + those named in 02-repro.json
  let classNames = o.classNames ?? [];
  if (!classNames.length && !o.tests?.length) {
    const repro = readJsonOr<{ failing_tests?: string[]; inverse_tests?: string[] }>(path.join(vault, "02-repro.json"), {});
    const fromRepro = [...(repro.failing_tests ?? []), ...(repro.inverse_tests ?? [])].map((t) => t.split(".")[0]);
    const changedTests = files.filter((f) => f.endsWith(".cls") && /@IsTest/i.test(fs.readFileSync(path.join(p.root, f), "utf8"))).map((f) => path.basename(f, ".cls"));
    classNames = uniq([...fromRepro, ...changedTests]);
  }
  const apex = classNames.length || o.tests?.length ? await apexRunTests(org.alias, org.keychain, { classNames: classNames.length ? classNames : undefined, tests: o.tests, cwd: p.org, codeCoverage: o.phase !== "repro" }) : undefined;
  const out: TestRunFile = { phase: o.phase, ran_at: nowIso(), org: org.alias, source_hash: filesHash(p, files), apex: apex?.data, soql_assertions: [], flow_tests: [] };
  if (apex && !apex.ok && !apex.data) out.apex = { summary: { outcome: `unavailable: ${apex.error}` }, tests: [] } as ApexTestResult;
  // SOQL state assertions (artifacts/assertions.json) — evaluated on the same org
  const asserts = readJsonOr<{ description: string; query: string; expected: string; phases?: string[] }[]>(path.join(vault, "artifacts", "assertions.json"), []);
  for (const a of asserts) {
    if (a.phases && !a.phases.includes(o.phase)) continue;
    const r = await soql(a.query, org.alias, { keychain: org.keychain });
    if (!r.ok || !r.data) { out.soql_assertions!.push({ ...a, pass: false, note: `query failed: ${r.error}` }); continue; }
    const rec = r.data.records[0] ?? {};
    const actual = String(rec.expr0 ?? Object.values(rec).find((v) => typeof v === "number") ?? r.data.totalSize);
    out.soql_assertions!.push({ description: a.description, query: a.query, expected: a.expected, actual, pass: compareExpected(actual, a.expected) });
  }
  // Flow tests (plugin-flow) — opt-in via artifacts/flow-tests.json [{ name }]
  const flowTests = readJsonOr<{ name: string }[]>(path.join(vault, "artifacts", "flow-tests.json"), []);
  for (const ft of flowTests) {
    const r = await sf<{ summary?: { outcome?: string }; tests?: { Outcome?: string; FullName?: string; Message?: string }[] }>(["flow", "run", "test", "--test-names", ft.name, "--target-org", org.alias, "--wait", "10"], { keychain: org.keychain, timeoutMs: 15 * 60_000 });
    if (!r.ok) out.flow_tests!.push({ name: ft.name, outcome: r.unavailable ? "unavailable" : "Fail", message: r.error });
    else out.flow_tests!.push({ name: ft.name, outcome: r.data?.summary?.outcome ?? r.data?.tests?.[0]?.Outcome ?? "unknown", message: r.data?.tests?.[0]?.Message ?? undefined });
  }
  writeJsonAtomic(path.join(vault, "validations", `tests-${o.phase}.json`), out);
  emitEvent({ ticket: o.ticket, type: "test.run", stage: o.phase === "uat" ? "qa_uat" : o.phase === "repro" ? "repro" : "qa_dev", data: { org: org.alias, classes: classNames, outcome: out.apex?.summary?.outcome } }, p);
  return out;
}

/* ---------------- preprod validate-only · dev deploy ---------------- */

export async function uatValidate(ticket: string, p: ProjectPaths = projectPaths()): Promise<unknown> {
  const cfg = loadConfig(p);
  const org = orgFor(cfg, "uat");
  const files = await changedFiles(p, ticket);
  const keys = componentKeys(files);
  if (!keys.length) throw new SfsmithsError("no changed components to validate", "NOTHING_TO_VALIDATE");
  const r = await deployStart(org.alias, org.keychain, { metadata: keys, dryRun: true, testLevel: "RunLocalTests", cwd: p.org });
  const data = { ...(r.data ?? {}), _files_hash: filesHash(p, files), _components: keys, _at: nowIso(), _error: r.ok ? undefined : r.error, status: r.data?.status ?? (r.ok ? "Succeeded" : "Failed") };
  writeJsonAtomic(path.join(vaultDir(p, ticket), "validations", "uat-validate.json"), data);
  return data;
}

export async function deployDev(ticket: string, p: ProjectPaths = projectPaths()): Promise<unknown> {
  const cfg = loadConfig(p);
  const org = orgFor(cfg, "dev");
  const files = await changedFiles(p, ticket);
  const keys = componentKeys(files);
  if (!keys.length) throw new SfsmithsError("no changed components to deploy", "NOTHING_TO_DEPLOY");
  const r = await deployStart(org.alias, org.keychain, { metadata: keys, cwd: p.org, ignoreConflicts: true });
  const data = { ...(r.data ?? {}), _files_hash: filesHash(p, files), _components: keys, _at: nowIso(), _error: r.ok ? undefined : r.error, status: r.data?.status ?? (r.ok ? "Succeeded" : "Failed") };
  writeJsonAtomic(path.join(vaultDir(p, ticket), "validations", "deploy-dev.json"), data);
  emitEvent({ ticket, type: "deploy.dev", stage: "develop", data: { components: keys, status: data.status, id: r.data?.id } }, p);
  return data;
}

export async function privilegedRetrieve(which: "dev" | "uat", metadata: string[], outDir: string, p: ProjectPaths = projectPaths()): Promise<unknown> {
  const cfg = loadConfig(p);
  const org = orgFor(cfg, which);
  ensureDir(outDir);
  const r = await retrieveStart(org.alias, org.keychain, { metadata, outputDir: outDir, cwd: p.org });
  if (!r.ok) throw new SfsmithsError(`retrieve failed: ${r.error}`, "RETRIEVE_FAILED");
  return r.data;
}

/** Anonymous Apex on the development org only — canary must be fresh (it may create data / fire automation). */
export async function apexRunDev(ticket: string, file: string, p: ProjectPaths = projectPaths()): Promise<unknown> {
  const cfg = loadConfig(p);
  const org = orgFor(cfg, "dev");
  if (cfg.safety.require_canary_before_data_stages) {
    const c = canaryFresh(cfg, p, org.alias);
    if (!c.fresh) throw new SfsmithsError(`REFUSED (P9): ${c.reason}`, "CANARY_STALE");
  }
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    if (!emailAllowed(m[0], cfg.safety.allowed_test_emails)) throw new SfsmithsError(`REFUSED (P9): non-allowlisted email in script: ${m[0].replace(/^(..).*(@.*)$/, "$1***$2")}`, "EMAIL_GUARD");
  }
  const r = await apexRunAnonymous(file, org.alias, org.keychain);
  const out = { ok: r.ok, ...(r.data ?? {}), _at: nowIso(), _error: r.error };
  writeJsonAtomic(path.join(vaultDir(p, ticket), "validations", `apex-run-${tsCompact()}.json`), out);
  return out;
}

/* ---------------- Code Analyzer v5 ---------------- */

export async function runAnalyzer(ticket: string, p: ProjectPaths = projectPaths(), threshold = 3): Promise<AnalyzerResult> {
  const files = (await changedFiles(p, ticket)).filter((f) => /\.(cls|trigger|js|html|xml|page|cmp)$/.test(f));
  const result: AnalyzerResult = { ran_at: nowIso(), files_hash: filesHash(p, await changedFiles(p, ticket)), available: false, violations: [], threshold };
  const outFile = path.join(vaultDir(p, ticket), "validations", "analyzer-raw.json");
  if (!files.length) { result.available = true; result.reason = "no analyzable files changed"; writeJsonAtomic(path.join(vaultDir(p, ticket), "validations", "analyzer.json"), result); return result; }
  const args = ["code-analyzer", "run", "--rule-selector", "Recommended", "--output-file", outFile, "--severity-threshold", "5"];
  for (const f of files) args.push("--workspace", path.join(p.root, f));
  const r = await run("sf", args, { cwd: p.root, timeoutMs: 15 * 60_000 });
  if (r.code === -1) { result.reason = "sf CLI not found"; }
  else if (/not a sf command|command code-analyzer|Warning: code-analyzer/i.test(r.stderr + r.stdout) && !exists(outFile)) { result.reason = "code-analyzer plugin not installed: sf plugins install code-analyzer"; }
  else if (!exists(outFile)) { result.reason = `analyzer produced no output (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`; }
  else {
    result.available = true;
    const raw = readJsonOr<{ violations?: { rule?: string; engine?: string; severity?: number; message?: string; locations?: { file?: string; startLine?: number }[]; primaryLocationIndex?: number }[] }>(outFile, {});
    for (const v of raw.violations ?? []) {
      const loc = v.locations?.[v.primaryLocationIndex ?? 0] ?? v.locations?.[0];
      result.violations.push({ rule: v.rule ?? "?", engine: v.engine, severity: Number(v.severity ?? 5), file: loc?.file ?? "?", line: loc?.startLine, message: v.message ?? "" });
    }
  }
  writeJsonAtomic(path.join(vaultDir(p, ticket), "validations", "analyzer.json"), result);
  return result;
}

/* ---------------- oracle cache (gate 0) ---------------- */

export async function cacheFreshen(opts: { objects?: string[]; types?: string[]; ticket?: string; p?: ProjectPaths }): Promise<{ objects: string[]; types: string[]; errors: string[] }> {
  const p = opts.p ?? projectPaths();
  const cfg = loadConfig(p);
  const dev = devOrg(cfg);
  const errors: string[] = [];
  let objects = opts.objects ?? [];
  if (!objects.length && opts.ticket) {
    const scope = readJsonOr<{ objects?: string[]; components?: string[] }>(path.join(vaultDir(p, opts.ticket), "scope.json"), {});
    objects = uniq([...(scope.objects ?? []), ...(scope.components ?? []).filter((c) => c.startsWith("CustomObject:")).map((c) => c.split(":")[1]), ...(scope.components ?? []).filter((c) => c.startsWith("CustomField:")).map((c) => c.split(":")[1].split(".")[0])]);
  }
  if (!objects.length) objects = Object.keys(cfg.masking.objects);
  for (const o of objects) {
    const r = await describe(o, dev.alias, dev.keychain);
    if (!r.ok || !r.data) { errors.push(`describe ${o}: ${r.error}`); continue; }
    const fields: Record<string, unknown> = {};
    for (const f of r.data.fields) fields[f.name] = { type: f.type, createable: f.createable, updateable: f.updateable, calculated: f.calculated, custom: f.custom, picklist: f.picklistValues?.filter((v) => v.active !== false).map((v) => v.value) };
    writeJsonAtomic(path.join(p.state, "cache", "describe", `${o}.json`), { name: o, fetched_at: nowIso(), fields, recordTypes: r.data.recordTypeInfos?.map((x) => x.developerName ?? x.name) });
  }
  const types = opts.types ?? ["ApexClass", "ApexTrigger", "Flow", "CustomObject", "ValidationRule", "PermissionSet", "Layout", "FlexiPage", "QuickAction", "LightningComponentBundle"];
  for (const t of types) {
    const r = await sf<{ fullName?: string; namespacePrefix?: string; manageableState?: string }[]>(["org", "list", "metadata", "--metadata-type", t, "--target-org", dev.alias], { keychain: dev.keychain, timeoutMs: 5 * 60_000 });
    if (!r.ok || !Array.isArray(r.data)) { errors.push(`list metadata ${t}: ${r.error ?? "unexpected shape"}`); continue; }
    const names = r.data.map((x) => x.fullName ?? "").filter(Boolean);
    const namespaced = r.data.filter((x) => x.namespacePrefix || (x.manageableState && x.manageableState !== "unmanaged")).map((x) => x.fullName ?? "").filter(Boolean);
    writeJsonAtomic(path.join(p.state, "cache", "metadata", `${t}.json`), { type: t, fetched_at: nowIso(), names, namespaced });
  }
  const disp = await orgDisplay(dev.alias, dev.keychain);
  if (disp.ok && disp.data) writeJsonAtomic(path.join(p.state, "cache", "org.json"), { alias: dev.alias, apiVersion: disp.data.apiVersion, id: disp.data.id, instanceUrl: disp.data.instanceUrl, fetched_at: nowIso() });
  return { objects, types, errors };
}

export async function toolAvailable(cmd: string): Promise<boolean> {
  return !!(await which(cmd));
}
