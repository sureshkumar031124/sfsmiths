/**
 * baseline-check · deploy-report · analyzer · assertion-referee
 * These gates read JSON verdicts produced by CLI/API runs (Bowden rule, P2) — never an agent's prose.
 */
import path from "node:path";
import { exists, readJsonOr } from "../core/util.js";
import { failed, passed, unavailable, type Gate, type GateContext } from "./types.js";
import { changedSourceFiles, hashFiles, readVaultJson } from "./helpers.js";
import type { ApexTestResult, DeployResult } from "../core/sf.js";

/* ---------------- baseline-check ---------------- */

export interface BaselineReport {
  synced_at: string;
  ancestor_source: "fingerprint" | "tooling-dates" | "none";
  scope: string[];
  components: { key: string; classification: string; action: string; dev_hash?: string; uat_hash?: string; post_sync_equal?: boolean }[];
  excluded: string[];
  stopped: boolean;
  stop_reason?: string;
  dev_snapshot_dir?: string;
  git_commit?: string;
  uat_vs_prod_drift?: string[];
}

export const baselineCheck: Gate = {
  name: "baseline-check",
  description: "After baseline sync, every in-scope component is byte-equal (normalised) between development and preprod, or explicitly excluded by a human.",
  async run(ctx) {
    const rep = readVaultJson<BaselineReport>(ctx, "00b-baseline.json");
    if (!rep) return unavailable("baseline-check", "00b-baseline.json missing — run `sfsmiths agent baseline`");
    if (rep.stopped) {
      // a human decision is pending (DEV-NEWER / BOTH-CHANGED / UNKNOWN) — not the agent's fault: unavailable, never a failure
      if (ctx.manifest.status === "waiting_human" || /decision|human/i.test(rep.stop_reason ?? "")) return unavailable("baseline-check", `baseline sync paused for a human decision: ${rep.stop_reason ?? "pending"}`);
      return failed("baseline-check", `baseline sync stopped: ${rep.stop_reason ?? "unknown"}`);
    }
    if (ctx.manifest.flags["no_preprod"] === true) return passed("baseline-check", "no preprod org configured — baseline skipped by config");
    const notEqual = rep.components.filter((c) => !rep.excluded.includes(c.key) && c.classification !== "IDENTICAL" && c.post_sync_equal !== true);
    if (notEqual.length) return failed("baseline-check", `${notEqual.length} in-scope component(s) still differ after sync: ${notEqual.slice(0, 6).map((c) => `${c.key} [${c.classification}]`).join(", ")}`, { details: { notEqual } });
    return passed("baseline-check", `${rep.components.length} component(s) equal to preprod (${rep.excluded.length} excluded, ancestor=${rep.ancestor_source})`);
  },
};

/* ---------------- uat-parity (D-099) ---------------- */

interface ParityFile { ok: boolean; source: string; skipped?: string; unavailable?: string; files_hash: string; rows: { key: string; status: string }[]; at: string }

export const uatParityGate: Gate = {
  name: "uat-parity",
  description: "Before QA runs in preprod: the toolkit's parity verdict (validations/uat-parity.json) says every component the ticket changed is present in preprod with the same normalised content as the dev source (or a human accepted the difference with a reason), and the source has not changed since.",
  async run(ctx) {
    const preprod = ctx.cfg.orgs.orgs.find((o) => o.role === "preprod");
    if (!preprod || ctx.manifest.flags["no_preprod"] === true) return passed("uat-parity", "no preprod org configured — parity skipped by config");
    const f = readVaultJson<ParityFile>(ctx, "validations/uat-parity.json");
    if (!f) return unavailable("uat-parity", "validations/uat-parity.json missing — the uat_verify stage has not run (sfsmiths-human deployed <KEY> --org preprod)");
    if (f.unavailable) return failed("uat-parity", `preprod parity was not verified: ${f.unavailable}`);
    const bad = (f.rows ?? []).filter((r) => !["MATCH", "DELETED_OK", "ACCEPTED"].includes(r.status));
    if (!f.ok || bad.length) return failed("uat-parity", `${bad.length} component(s) not matching preprod: ${bad.slice(0, 6).map((r) => `${r.key} ${r.status}`).join(", ")}`, { details: { rows: f.rows } });
    // void if the source moved on after the verdict (same rule as deploy-report)
    const { computeDeployFilesHash } = await import("../engines/deploy-manifest.js");
    const current = await computeDeployFilesHash(ctx.p, ctx.ticket);
    if (f.files_hash && f.files_hash !== current) return failed("uat-parity", "source changed after the parity verdict — deploy again and re-run sfsmiths-human deployed <KEY> --org preprod");
    return passed("uat-parity", `${(f.rows ?? []).length} component(s) verified in ${preprod.alias} (${f.source === "human" ? "accepted by human" : "retrieve + fingerprint"})`, { artifact_hash: current });
  },
};

/* ---------------- deploy-report ---------------- */

export const deployReport: Gate = {
  name: "deploy-report",
  description: "Development deploy succeeded (0 component errors) and preprod validate-only (dry-run) succeeded when a preprod org exists.",
  async run(ctx) {
    const dev = readJsonOr<(DeployResult & { _files_hash?: string }) | undefined>(path.join(ctx.vault, "validations", "deploy-dev.json"), undefined);
    if (!dev) return unavailable("deploy-report", "validations/deploy-dev.json missing — deploy via `sfsmiths agent privileged deploy-dev`");
    const current = hashFiles((await changedSourceFiles(ctx)).map((f) => path.join(ctx.p.root, f)));
    if (dev._files_hash && dev._files_hash !== current) return failed("deploy-report", "source changed after the last development deploy — deploy again");
    const devOk = (dev.status === "Succeeded" || dev.success === true) && (dev.numberComponentErrors ?? 0) === 0;
    if (!devOk) return failed("deploy-report", `development deploy ${dev.status ?? "unknown"} with ${dev.numberComponentErrors ?? "?"} component error(s)`, { details: { dev } });
    const preprod = ctx.cfg.orgs.orgs.find((o) => o.role === "preprod");
    if (preprod && ctx.manifest.flags["no_preprod"] !== true) {
      const val = readJsonOr<(DeployResult & { _files_hash?: string }) | undefined>(path.join(ctx.vault, "validations", "uat-validate.json"), undefined);
      if (!val) return unavailable("deploy-report", "validations/uat-validate.json missing — run `sfsmiths agent privileged uat-validate`");
      if (val._files_hash && val._files_hash !== current) return failed("deploy-report", "source changed after the last preprod validate — validate again");
      const valOk = (val.status === "Succeeded" || val.success === true) && (val.numberComponentErrors ?? 0) === 0 && (val.numberTestErrors ?? 0) === 0;
      if (!valOk) return failed("deploy-report", `preprod validate-only ${val.status ?? "unknown"}: ${val.numberComponentErrors ?? "?"} component error(s), ${val.numberTestErrors ?? "?"} test error(s)`, { details: { val } });
    }
    return passed("deploy-report", `development deploy ${dev.id ?? ""} succeeded${preprod ? "; preprod validate-only succeeded" : ""}`, { artifact_hash: current });
  },
};

/* ---------------- analyzer (Code Analyzer v5) ---------------- */

export interface AnalyzerResult {
  ran_at: string;
  files_hash: string;
  available: boolean;
  reason?: string;
  violations: { rule: string; severity: number; file: string; line?: number; message: string; engine?: string }[];
  threshold: number;
}

export const analyzerGate: Gate = {
  name: "analyzer",
  description: "Salesforce Code Analyzer (v5) — no violations at or above the severity threshold on changed files.",
  async run(ctx) {
    const res = readJsonOr<AnalyzerResult | undefined>(path.join(ctx.vault, "validations", "analyzer.json"), undefined);
    if (!res) return unavailable("analyzer", "validations/analyzer.json missing — run `sfsmiths agent analyze`");
    if (!res.available) return unavailable("analyzer", res.reason ?? "code analyzer not available");
    const current = hashFiles((await changedSourceFiles(ctx)).map((f) => path.join(ctx.p.root, f)));
    if (res.files_hash !== current) return failed("analyzer", "files changed since the last analyzer run — run `sfsmiths agent analyze` again");
    const bad = res.violations.filter((v) => v.severity <= res.threshold);
    if (bad.length) return failed("analyzer", `${bad.length} violation(s) at severity ≤ ${res.threshold}: ${bad.slice(0, 5).map((v) => `${v.rule}@${path.basename(v.file)}:${v.line ?? "?"}`).join(", ")}`, { details: { bad } });
    return passed("analyzer", `${res.violations.length} finding(s), none at severity ≤ ${res.threshold}`, { artifact_hash: current });
  },
};

/* ---------------- assertion-referee ---------------- */

export interface TestRunFile {
  phase: "repro" | "dev" | "uat";
  ran_at: string;
  org: string;
  source_hash?: string;
  apex?: ApexTestResult;
  soql_assertions?: { description: string; query: string; expected: string; actual?: string | number; pass: boolean; note?: string }[];
  flow_tests?: { name: string; outcome: string; message?: string }[];
}

interface ReproContract {
  failing_tests: string[];       // "Class.method" — must FAIL before fix, PASS after
  inverse_tests: string[];       // must PASS before and after
  predicted_distribution?: { description: string; query: string; expected: string }[];
}

function outcomeOf(run: TestRunFile, fullName: string): string | undefined {
  const [cls, method] = fullName.split(".");
  const t = run.apex?.tests?.find((x) => (x.FullName === fullName) || ((x.ApexClass?.Name === cls) && x.MethodName === method));
  return t?.Outcome;
}

export const assertionReferee: Gate = {
  name: "assertion-referee",
  description: "Repro: failing assertion FAILS, inverse assertions PASS. QA: failing assertion PASSES, inverse still PASS, distribution assertions hold.",
  async run(ctx) {
    const repro = readVaultJson<ReproContract>(ctx, "02-repro.json");
    if (!repro) return unavailable("assertion-referee", "02-repro.json missing");
    if (!repro.failing_tests?.length) return failed("assertion-referee", "02-repro.json must name at least one failing test (Class.method) that proves the bug");
    if ((repro.inverse_tests?.length ?? 0) < 1) return failed("assertion-referee", "02-repro.json must name at least one inverse test (what must keep working)");
    const phase = ctx.options.phase ?? (ctx.stage === "repro" ? "repro" : ctx.stage === "qa_uat" ? "uat" : "dev");
    const file = path.join(ctx.vault, "validations", `tests-${phase}.json`);
    if (!exists(file)) return unavailable("assertion-referee", `validations/tests-${phase}.json missing — run \`sfsmiths agent privileged test --phase ${phase}\``);
    const run = readJsonOr<TestRunFile | undefined>(file, undefined);
    if (!run?.apex?.tests) return unavailable("assertion-referee", `tests-${phase}.json has no Apex test results`);
    const problems: string[] = [];
    for (const t of repro.failing_tests) {
      const o = outcomeOf(run, t);
      if (!o) { problems.push(`${t}: not found in results`); continue; }
      if (phase === "repro" && o !== "Fail" && o !== "CompileFail") problems.push(`${t}: expected FAIL (bug must be proven), got ${o}`);
      if (phase !== "repro" && o !== "Pass") problems.push(`${t}: expected PASS after fix, got ${o}`);
    }
    for (const t of repro.inverse_tests) {
      const o = outcomeOf(run, t);
      if (!o) { problems.push(`${t}: inverse test not found in results`); continue; }
      if (o !== "Pass") problems.push(`${t}: inverse must PASS, got ${o}`);
    }
    if (phase !== "repro") {
      for (const a of run.soql_assertions ?? []) if (!a.pass) problems.push(`distribution: ${a.description} expected ${a.expected} got ${a.actual ?? "?"}`);
      if ((repro.predicted_distribution?.length ?? 0) > 0 && (run.soql_assertions?.length ?? 0) === 0) problems.push("predicted distribution declared but no SOQL assertions were run");
      for (const f of run.flow_tests ?? []) if (!/pass/i.test(f.outcome)) problems.push(`flow test ${f.name}: ${f.outcome}`);
    }
    // stale results guard
    if (run.source_hash) {
      const current = hashFiles((await changedSourceFiles(ctx)).map((f) => path.join(ctx.p.root, f)));
      if (current !== run.source_hash && phase !== "repro") problems.push("source changed after the test run — rerun tests");
    }
    if (problems.length) return failed("assertion-referee", problems.slice(0, 8).join("; "), { details: { problems, phase } });
    const summary = run.apex.summary;
    return passed("assertion-referee", `phase ${phase}: ${repro.failing_tests.length} failing-test(s) ${phase === "repro" ? "FAIL as expected" : "now PASS"}, ${repro.inverse_tests.length} inverse PASS${summary ? ` (${summary.passing ?? "?"}/${summary.testsRan ?? "?"} passing)` : ""}`, { details: { phase, summary } });
  },
};
