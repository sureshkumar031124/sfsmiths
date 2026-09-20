/**
 * privileged/index.ts — org-touching steps the toolkit runs on behalf of agents (P1c/P2):
 *   tests (dev/preprod) · preprod validate-only · dev deploy · retrieve · anonymous Apex (canary-gated) ·
 *   email canary · code analyzer · oracle cache freshen.
 * Every result is a JSON verdict file under work/<T>/validations/ that the gates read. No prose verdicts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, devOrg, preprodOrg, emailDeliveryMode, emailCensusFields, type AllConfig, type Keychain, type EmailDeliveryMode } from "../core/config.js";
import { emitEvent } from "../core/events.js";
import { componentKeyFromPath } from "../core/fingerprint.js";
import { git } from "../core/git.js";
import { loadManifest } from "../core/manifest.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { apexRunAnonymous, apexRunTests, deployStart, describe, orgDisplay, retrieveStart, sf, soql, type ApexTestResult } from "../core/sf.js";
import { run, which } from "../core/shell.js";
import { ensureDir, exists, nowIso, readJsonOr, sha256, tsCompact, uniq, writeJsonAtomic, writeTextAtomic, SfsmithsError } from "../core/util.js";
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

export interface CanaryCensusRow { field: string; non_allowlisted: number | null; note?: string }
export interface CanaryState {
  at: string; org: string; result: "pass" | "fail" | "unknown"; detail: string; recipient_masked: string;
  mode?: EmailDeliveryMode;            // D-102: which containment rule this verdict applied (absent on pre-D-102 files → blocked)
  census?: CanaryCensusRow[];          // allowlist_only only: addresses outside the allowlist per configured field
}

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
export function classifyCanaryResult(res: CanaryApexResult, mode: EmailDeliveryMode = "blocked"): { result: CanaryState["result"]; detail: string } {
  const blocked = res.errors.find((e) => CANARY_BLOCKED_STATUSES.includes(e.status));
  if (mode === "allowlist_only") {
    // D-102: delivery ON is acceptable here — the census (run next) is what makes it safe; a blocked org is safe too
    if (res.success) return { result: "pass", detail: "probe delivered to the canary address — delivery is ON; safe ONLY while the e-mail census finds no address outside the allowlist" };
    if (blocked) return { result: "pass", detail: `${blocked.status} — the org blocks outbound e-mail anyway (allowlist_only mode, nothing can leave)` };
    return { result: "unknown", detail: `unexpected: ${res.errors.map((e) => `${e.status}: ${e.message}`).join("; ") || "no errors, not success"}` };
  }
  if (res.success) return { result: "fail", detail: "email SENT — deliverability is All email (or your address is allowlisted in the org). UNSAFE for test data in blocked mode: switch the sandbox to System email only, or (Developer sandboxes with team-created data only) set safety.email_delivery: allowlist_only in the UI → Safety screen." };
  if (blocked) return { result: "pass", detail: `${blocked.status} — the org blocks outbound e-mail (System email only / No access) confirmed` };
  return { result: "unknown", detail: `unexpected: ${res.errors.map((e) => `${e.status}: ${e.message}`).join("; ") || "no errors, not success"}` };
}

/** One SOQL COUNT() per census field: how many records carry an address outside the allowlist. Globs → LIKE patterns. */
export function censusQuery(field: string, allow: string[]): string {
  const [obj, fld] = field.split(".");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const clauses = allow.map((g) => g.includes("*") ? `(NOT ${fld} LIKE '${esc(g.replace(/%/g, "\\%").replace(/\*/g, "%"))}')` : `${fld} != '${esc(g)}'`);
  return `SELECT COUNT() FROM ${obj} WHERE ${fld} != null${clauses.length ? " AND " + clauses.join(" AND ") : ""}`;
}

/** D-102 e-mail census on the development org: every configured field must hold only allowlisted addresses. */
export async function emailCensus(alias: string, keychain: Keychain, cfg: AllConfig): Promise<{ ok: boolean; rows: CanaryCensusRow[]; detail: string }> {
  const rows: CanaryCensusRow[] = [];
  for (const field of emailCensusFields(cfg.safety)) {
    const r = await soql(censusQuery(field, cfg.safety.allowed_test_emails), alias, { keychain });
    if (!r.ok || !r.data) { rows.push({ field, non_allowlisted: null, note: `query failed: ${r.error ?? "unknown"} — fix or remove the field from safety.email_census_fields` }); continue; }
    const n = Number(r.data.totalSize ?? (r.data.records?.[0] as { expr0?: number } | undefined)?.expr0 ?? NaN);
    rows.push({ field, non_allowlisted: Number.isFinite(n) ? n : null, note: Number.isFinite(n) ? undefined : "unreadable count" });
  }
  const unknown = rows.filter((x) => x.non_allowlisted === null);
  const dirty = rows.filter((x) => (x.non_allowlisted ?? 0) > 0);
  if (unknown.length) return { ok: false, rows, detail: `census could not read ${unknown.map((x) => x.field).join(", ")} — not safe to assume (P11)` };
  if (dirty.length) return { ok: false, rows, detail: `census found addresses OUTSIDE the allowlist: ${dirty.map((x) => `${x.field}=${x.non_allowlisted}`).join(", ")} — scrub them (or use blocked mode) before any test data is created` };
  return { ok: true, rows, detail: `census clean: ${rows.map((x) => `${x.field}=0`).join(", ")}` };
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
      const mode = emailDeliveryMode(cfg.safety);
      const c = classifyCanaryResult(res, mode);
      state = { at: nowIso(), org: org.alias, result: c.result, detail: c.detail, recipient_masked: masked, mode };
      // D-102: in allowlist_only mode a PASS is conditional on the census — no address outside the allowlist may exist in the org
      if (mode === "allowlist_only" && c.result === "pass") {
        const census = await emailCensus(org.alias, org.keychain, cfg);
        state.census = census.rows;
        if (!census.ok) { state.result = "fail"; state.detail = `${c.detail}; ${census.detail}`; }
        else state.detail = `${c.detail}; ${census.detail}`;
      }
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

/* ---------------- preprod parity (D-099) ---------------- */

export type ParityStatus = "MATCH" | "DIFFERENT" | "MISSING_IN_UAT" | "STILL_IN_UAT" | "DELETED_OK" | "ACCEPTED";
export interface ParityRow { key: string; action: "added" | "modified" | "deleted"; dev_sha: string; uat_sha?: string; status: ParityStatus; uat_files?: string[]; note?: string }
export interface ParityResult {
  at: string; ticket: string; org?: string;
  source: "retrieve" | "human" | "skipped";
  ok: boolean;
  skipped?: string;               // no preprod configured
  unavailable?: string;           // could not retrieve — never counts as ok
  rows: ParityRow[];
  files_hash: string;             // the deploy manifest's files_hash this verdict belongs to
  accepted?: { keys: string[]; reason: string; at: string };
}

export function parityFile(p: ProjectPaths, ticket: string): string { return path.join(vaultDir(p, ticket), "validations", "uat-parity.json"); }

const PARITY_OK: Set<ParityStatus> = new Set(["MATCH", "DELETED_OK", "ACCEPTED"]);

/**
 * "Did everything we built in dev actually arrive in preprod?" — the human deploys (P3), the toolkit verifies (P5).
 * Retrieves the ticket's deploy-manifest components from preprod with the ENGINE keychain (P2: agents never touch it),
 * fingerprints them path-independently and compares with the dev source. A human-accepted verdict for the same source
 * hash (sfsmiths-human parity --accept …, reason required, logged) is honoured instead of a retrieve.
 */
export async function uatParity(ticket: string, p: ProjectPaths = projectPaths()): Promise<ParityResult> {
  const cfg = loadConfig(p);
  const m = loadManifest(ticket, p);
  const { buildDeployManifest } = await import("../engines/deploy-manifest.js");
  const mf = await buildDeployManifest(ticket, p);
  const file = parityFile(p, ticket);
  const finish = (r: ParityResult) => { writeJsonAtomic(file, r); writeTextAtomic(path.join(vaultDir(p, ticket), "07a-uat-parity.md"), renderParityMd(r)); emitEvent({ ticket, type: r.ok ? "uat.parity_ok" : "uat.parity_failed", stage: "uat_verify", data: { source: r.source, org: r.org, rows: r.rows.length, not_ok: r.rows.filter((x) => !PARITY_OK.has(x.status)).map((x) => `${x.key}:${x.status}`), unavailable: r.unavailable, skipped: r.skipped } }, p); return r; };
  const pre = preprodOrg(cfg);
  if (!pre || m.flags["no_preprod"] === true) return finish({ at: nowIso(), ticket, source: "skipped", ok: true, skipped: "no preprod org configured (dev-only run)", rows: [], files_hash: mf.files_hash });
  // a human decision for exactly this source stands (P-human authority, recorded)
  const prev = readJsonOr<ParityResult | undefined>(file, undefined);
  if (prev && prev.source === "human" && prev.files_hash === mf.files_hash && prev.ok) return prev;
  if (!mf.components.length) return finish({ at: nowIso(), ticket, org: pre.alias, source: "retrieve", ok: true, rows: [], files_hash: mf.files_hash });
  const tmp = path.join(p.state, "tmp", `parity-${tsCompact()}`);
  ensureDir(tmp);
  try {
    try {
      await privilegedRetrieve("uat", mf.components.map((c) => c.key), tmp, p);
    } catch (e) {
      return finish({ at: nowIso(), ticket, org: pre.alias, source: "retrieve", ok: false, unavailable: `could not retrieve from ${pre.alias}: ${(e as Error).message}`, rows: mf.components.map((c) => ({ key: c.key, action: c.action, dev_sha: c.sha, status: c.action === "deleted" ? "STILL_IN_UAT" : "MISSING_IN_UAT" as ParityStatus, note: "not verified" })), files_hash: mf.files_hash });
    }
    const { groupComponents, componentContentFingerprint } = await import("../core/fingerprint.js");
    const groups = groupComponents(tmp);
    const rows: ParityRow[] = mf.components.map((c) => {
      const uatFiles = groups[c.key];
      if (c.action === "deleted") return { key: c.key, action: c.action, dev_sha: "", uat_files: uatFiles, status: uatFiles?.length ? "STILL_IN_UAT" : "DELETED_OK" };
      if (!uatFiles?.length) return { key: c.key, action: c.action, dev_sha: c.sha, status: "MISSING_IN_UAT" };
      const uatSha = componentContentFingerprint(tmp, uatFiles);
      return { key: c.key, action: c.action, dev_sha: c.sha, uat_sha: uatSha, uat_files: uatFiles, status: uatSha === c.sha ? "MATCH" : "DIFFERENT" };
    });
    return finish({ at: nowIso(), ticket, org: pre.alias, source: "retrieve", ok: rows.every((r) => PARITY_OK.has(r.status)), rows, files_hash: mf.files_hash });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Human verdict on parity: accept named components (or all) that the retrieve reported as not matching, with a reason.
 * Recorded as source "human" for the CURRENT source hash; a later source change voids it. Never silent: event + reason.
 */
export async function parityAccept(ticket: string, opts: { keys?: string[]; all?: boolean; reason: string; p?: ProjectPaths }): Promise<ParityResult> {
  const p = opts.p ?? projectPaths();
  if (!opts.reason || opts.reason.trim().length < 8) throw new SfsmithsError("a reason of at least 8 characters is required to accept a parity difference (it is recorded)", "REASON_REQUIRED");
  const { buildDeployManifest } = await import("../engines/deploy-manifest.js");
  const mf = await buildDeployManifest(ticket, p);
  const prev = readJsonOr<ParityResult | undefined>(parityFile(p, ticket), undefined);
  const base: ParityRow[] = prev && prev.files_hash === mf.files_hash && prev.rows.length ? prev.rows : mf.components.map((c) => ({ key: c.key, action: c.action, dev_sha: c.sha, status: (c.action === "deleted" ? "STILL_IN_UAT" : "MISSING_IN_UAT") as ParityStatus, note: "not verified by retrieve" }));
  const accept = new Set(opts.all ? base.filter((r) => !PARITY_OK.has(r.status)).map((r) => r.key) : (opts.keys ?? []));
  const unknown = [...accept].filter((k) => !base.some((r) => r.key === k));
  if (unknown.length) throw new SfsmithsError(`not in the deploy manifest: ${unknown.join(", ")}`, "UNKNOWN_COMPONENT");
  const rows = base.map((r) => accept.has(r.key) && !PARITY_OK.has(r.status) ? { ...r, status: "ACCEPTED" as ParityStatus, note: `accepted by human: ${opts.reason}` } : r);
  const cfg = loadConfig(p);
  const r: ParityResult = { at: nowIso(), ticket, org: preprodOrg(cfg)?.alias, source: "human", ok: rows.every((x) => PARITY_OK.has(x.status)), rows, files_hash: mf.files_hash, accepted: { keys: [...accept], reason: opts.reason, at: nowIso() } };
  writeJsonAtomic(parityFile(p, ticket), r);
  writeTextAtomic(path.join(vaultDir(p, ticket), "07a-uat-parity.md"), renderParityMd(r));
  emitEvent({ ticket, type: "human.parity_accepted", stage: "uat_verify", data: { keys: [...accept], reason: opts.reason, ok: r.ok } }, p);
  return r;
}

export function renderParityMd(r: ParityResult): string {
  const lines = [`# Preprod parity — ${r.ticket}`, ``];
  if (r.skipped) lines.push(`_Skipped ${r.at}: ${r.skipped}._`);
  else {
    lines.push(`_${r.at} · org **${r.org ?? "?"}** · source: ${r.source === "human" ? "human decision" : "engine retrieve (engine keychain)"} · verdict: **${r.ok ? "OK — every component in preprod matches the dev source" : r.unavailable ? "NOT VERIFIED" : "MISMATCH"}**_`, ``);
    if (r.unavailable) lines.push(`> ⚠ ${r.unavailable}`, `>`, `> Fix the cause and run \`sfsmiths-human deployed ${r.ticket} --org preprod\` again. If you verified the deployment another way (deploy log), record it: \`sfsmiths-human parity ${r.ticket} --accept-all --reason "…"\`.`, ``);
    lines.push(`| Component | Action | Status | Dev | Preprod | Note |`, `|---|---|---|---|---|---|`);
    for (const x of r.rows) lines.push(`| \`${x.key}\` | ${x.action} | ${PARITY_OK.has(x.status) ? "✅" : "❌"} ${x.status} | \`${x.dev_sha ? x.dev_sha.slice(0, 12) : "—"}\` | \`${x.uat_sha ? x.uat_sha.slice(0, 12) : "—"}\` | ${x.note ?? ""} |`);
    if (r.accepted) lines.push(``, `**Accepted by human** (${r.accepted.at}): ${r.accepted.keys.join(", ") || "—"} — _${r.accepted.reason}_`);
    if (!r.ok && !r.unavailable) lines.push(``, `Next: fix the deployment set in your deploy tool for the ❌ rows, then \`sfsmiths-human deployed ${r.ticket} --org preprod\` again (the check re-runs). A DIFFERENT that you know is cosmetic (e.g. the deploy tool rewrote the api version) can be accepted with a reason: \`sfsmiths-human parity ${r.ticket} --accept Type:Name --reason "…"\`.`);
  }
  lines.push(``, `_Source hash \`${r.files_hash.slice(0, 16)}\` — this verdict is void if a source file changes afterwards._`, ``);
  return lines.join("\n");
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
