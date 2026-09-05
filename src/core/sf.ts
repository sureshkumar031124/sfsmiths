/**
 * sf.ts — the ONLY place that spawns the Salesforce CLI.
 *
 * Two keychains (Part 11 §10.1 L-B):
 *   agent  → the machine's default sf keychain (user HOME): development org RW + evidence org (read-only user)
 *   engine → HOME=~/.sfsmiths/engine: preprod org ONLY. Agents cannot read this dir (settings deny + write-guard).
 *
 * Every call: --json, defensive parsing, `unavailable` semantics instead of guessing (P8).
 */
import { run, type RunResult } from "./shell.js";
import { homePaths } from "./paths.js";
import type { Keychain } from "./config.js";

export interface SfJson<T = unknown> {
  status: number;
  result?: T;
  message?: string;
  name?: string;
  warnings?: string[];
}

export interface SfCallResult<T = unknown> {
  ok: boolean;
  data?: T;
  raw: RunResult;
  error?: string;
  unavailable?: boolean; // CLI missing / timeout / unparseable → never "passed"
}

export function keychainEnv(keychain: Keychain): NodeJS.ProcessEnv {
  if (keychain === "agent") return {};
  const hp = homePaths();
  // sf CLI resolves ~/.sf and ~/.sfdx from HOME → an alternate HOME = an alternate keychain.
  return { HOME: hp.engineHome, USERPROFILE: hp.engineHome, SF_AUTOUPDATE_DISABLE: "true", SF_DISABLE_TELEMETRY: "true" };
}

export async function sf<T = unknown>(args: string[], opts: { keychain?: Keychain; cwd?: string; timeoutMs?: number } = {}): Promise<SfCallResult<T>> {
  const keychain = opts.keychain ?? "agent";
  const finalArgs = args.includes("--json") ? args : [...args, "--json"];
  const raw = await run("sf", finalArgs, { cwd: opts.cwd, env: keychainEnv(keychain), timeoutMs: opts.timeoutMs ?? 10 * 60_000 });
  if (raw.code === -1) return { ok: false, raw, error: "sf CLI not found (install @salesforce/cli)", unavailable: true };
  if (raw.timedOut) return { ok: false, raw, error: "sf CLI timed out", unavailable: true };
  const parsed = parseSfJson<T>(raw.stdout);
  if (!parsed) return { ok: false, raw, error: `sf returned non-JSON output (exit ${raw.code}): ${(raw.stderr || raw.stdout).slice(0, 400)}`, unavailable: true };
  if (parsed.status !== 0 && raw.code !== 0) return { ok: false, raw, data: parsed.result, error: parsed.message ?? `sf exited ${raw.code}` };
  return { ok: true, raw, data: parsed.result };
}

export function parseSfJson<T>(stdout: string): SfJson<T> | undefined {
  const s = stdout.trim();
  if (!s) return undefined;
  // sf may print warnings before the JSON object; find the first '{'
  const i = s.indexOf("{");
  if (i < 0) return undefined;
  try {
    return JSON.parse(s.slice(i)) as SfJson<T>;
  } catch {
    return undefined;
  }
}

/* ---------- typed helpers (shapes from @salesforce/plugin-data / plugin-org; parsed defensively) ---------- */

export interface SoqlRecord {
  attributes?: { type?: string; url?: string };
  [field: string]: unknown;
}
export interface SoqlResult {
  totalSize: number;
  done: boolean;
  records: SoqlRecord[];
}

export async function soql(query: string, org: string, opts: { keychain?: Keychain; tooling?: boolean; cwd?: string } = {}): Promise<SfCallResult<SoqlResult>> {
  const args = ["data", "query", "--query", query, "--target-org", org];
  if (opts.tooling) args.push("--use-tooling-api");
  const r = await sf<SoqlResult>(args, opts);
  if (r.ok && r.data && !Array.isArray(r.data.records)) return { ...r, ok: false, unavailable: true, error: "unexpected query result shape" };
  return r;
}

export interface OrgListEntry {
  alias?: string;
  aliases?: string[];
  username?: string;
  orgId?: string;
  instanceUrl?: string;
  isDevHub?: boolean;
  isSandbox?: boolean;
  isScratch?: boolean;
  connectedStatus?: string;
  isDefaultUsername?: boolean;
  isDefaultDevHubUsername?: boolean;
}
export interface OrgListResult {
  nonScratchOrgs?: OrgListEntry[];
  scratchOrgs?: OrgListEntry[];
  sandboxes?: OrgListEntry[];
  other?: OrgListEntry[];
  devHubs?: OrgListEntry[];
}

export async function orgList(keychain: Keychain): Promise<SfCallResult<OrgListEntry[]>> {
  const r = await sf<OrgListResult>(["org", "list", "--all"], { keychain, timeoutMs: 60_000 });
  if (!r.ok || !r.data) return { ...r, data: undefined };
  const all = [
    ...(r.data.nonScratchOrgs ?? []),
    ...(r.data.sandboxes ?? []),
    ...(r.data.other ?? []),
    ...(r.data.devHubs ?? []),
    ...(r.data.scratchOrgs ?? []),
  ];
  // de-dupe by username
  const seen = new Set<string>();
  const out: OrgListEntry[] = [];
  for (const e of all) {
    const k = e.username ?? JSON.stringify(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return { ...r, data: out };
}

export interface OrgDisplay {
  id?: string;
  username?: string;
  alias?: string;
  instanceUrl?: string;
  apiVersion?: string;
  connectedStatus?: string;
  isSandbox?: boolean;
  isScratch?: boolean;
}

export async function orgDisplay(org: string, keychain: Keychain): Promise<SfCallResult<OrgDisplay>> {
  return sf<OrgDisplay>(["org", "display", "--target-org", org], { keychain, timeoutMs: 60_000 });
}

export interface ApexTestResult {
  summary?: { outcome?: string; testsRan?: number; passing?: number; failing?: number; skipped?: number; testRunId?: string; orgWideCoverage?: string; testExecutionTime?: string };
  tests?: { Outcome?: string; ApexClass?: { Name?: string }; MethodName?: string; Message?: string | null; StackTrace?: string | null; RunTime?: number; FullName?: string }[];
}

export async function apexRunTests(org: string, keychain: Keychain, opts: { classNames?: string[]; tests?: string[]; suite?: string; cwd?: string; codeCoverage?: boolean } = {}): Promise<SfCallResult<ApexTestResult>> {
  const args = ["apex", "run", "test", "--target-org", org, "--synchronous", "--result-format", "json", "--wait", "30"];
  for (const c of opts.classNames ?? []) args.push("--class-names", c);
  for (const t of opts.tests ?? []) args.push("--tests", t);
  if (opts.suite) args.push("--suite-names", opts.suite);
  if (opts.codeCoverage) args.push("--code-coverage");
  return sf<ApexTestResult>(args, { keychain, cwd: opts.cwd, timeoutMs: 40 * 60_000 });
}

export interface ApexRunResult {
  success?: boolean;
  compiled?: boolean;
  compileProblem?: string | null;
  exceptionMessage?: string | null;
  exceptionStackTrace?: string | null;
  line?: number;
  column?: number;
  logs?: string;
}

export async function apexRunAnonymous(file: string, org: string, keychain: Keychain): Promise<SfCallResult<ApexRunResult>> {
  return sf<ApexRunResult>(["apex", "run", "--file", file, "--target-org", org], { keychain, timeoutMs: 5 * 60_000 });
}

export interface DeployResult {
  id?: string;
  status?: string;          // Succeeded | Failed | SucceededPartial | Canceled | InProgress
  success?: boolean;
  checkOnly?: boolean;
  numberComponentErrors?: number;
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  numberTestErrors?: number;
  numberTestsCompleted?: number;
  details?: { componentFailures?: unknown[]; componentSuccesses?: unknown[]; runTestResult?: unknown };
  files?: { fullName?: string; type?: string; state?: string; filePath?: string; error?: string }[];
}

export async function deployStart(org: string, keychain: Keychain, opts: { sourceDirs?: string[]; metadata?: string[]; dryRun?: boolean; testLevel?: string; cwd: string; ignoreConflicts?: boolean }): Promise<SfCallResult<DeployResult>> {
  const args = ["project", "deploy", "start", "--target-org", org, "--wait", "30"];
  for (const d of opts.sourceDirs ?? []) args.push("--source-dir", d);
  for (const m of opts.metadata ?? []) args.push("--metadata", m);
  if (opts.dryRun) args.push("--dry-run");
  if (opts.testLevel) args.push("--test-level", opts.testLevel);
  if (opts.ignoreConflicts) args.push("--ignore-conflicts");
  return sf<DeployResult>(args, { keychain, cwd: opts.cwd, timeoutMs: 40 * 60_000 });
}

export interface RetrieveResult {
  status?: string;
  success?: boolean;
  files?: { fullName?: string; type?: string; state?: string; filePath?: string; error?: string }[];
  messages?: unknown[];
}

export async function retrieveStart(org: string, keychain: Keychain, opts: { metadata: string[]; outputDir?: string; cwd: string }): Promise<SfCallResult<RetrieveResult>> {
  const args = ["project", "retrieve", "start", "--target-org", org, "--wait", "30"];
  for (const m of opts.metadata) args.push("--metadata", m);
  if (opts.outputDir) args.push("--output-dir", opts.outputDir);
  return sf<RetrieveResult>(args, { keychain, cwd: opts.cwd, timeoutMs: 40 * 60_000 });
}

export interface DescribeField {
  name: string;
  label?: string;
  type: string;
  createable?: boolean;
  updateable?: boolean;
  calculated?: boolean;
  nillable?: boolean;
  custom?: boolean;
  referenceTo?: string[];
  picklistValues?: { value: string; active?: boolean; label?: string }[];
  length?: number;
}
export interface DescribeResult {
  name: string;
  label?: string;
  custom?: boolean;
  createable?: boolean;
  updateable?: boolean;
  queryable?: boolean;
  fields: DescribeField[];
  recordTypeInfos?: { name: string; developerName?: string; recordTypeId?: string; active?: boolean }[];
}

export async function describe(sobject: string, org: string, keychain: Keychain): Promise<SfCallResult<DescribeResult>> {
  const r = await sf<DescribeResult>(["sobject", "describe", "--sobject", sobject, "--target-org", org], { keychain, timeoutMs: 2 * 60_000 });
  if (r.ok && r.data && !Array.isArray(r.data.fields)) return { ...r, ok: false, unavailable: true, error: "unexpected describe shape" };
  return r;
}

export async function sfVersion(): Promise<string | undefined> {
  const r = await run("sf", ["--version"], { timeoutMs: 20_000 });
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : undefined;
}
