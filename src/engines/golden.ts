/**
 * golden.ts — Golden Ticket Replay: sealed expectations from solved tickets, scored against a fresh run.
 *   golden add <KEY>     seal what a solved ticket proved (scope, failing/inverse tests, root cause, gates)
 *   golden score <KEY>   compare the current vault's verdict files with the sealed expectations
 *   golden run           Phase 3: replays through pipeline mode (API key) — here it validates prerequisites and lists the set
 * R4 (zero non-existent components) is absolute: any unresolved API name in plan-lint = fail.
 */
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { loadManifest } from "../core/manifest.js";
import { STAGES } from "../core/state-machine.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { ensureDir, exists, listFiles, nowIso, readJsonOr, writeJsonAtomic } from "../core/util.js";

export interface GoldenTicket {
  key: string; sealed_at: string; title?: string;
  scope: string[]; failing_tests: string[]; inverse_tests: string[]; root_cause?: string;
  expected: { repro_fail_then_pass: boolean; unresolved_names: 0; min_gates_passed: number };
}

export function goldenDir(p: ProjectPaths): string {
  return path.join(p.root, "benchmarks", "golden-tickets");
}

export function goldenAdd(key: string, p: ProjectPaths = projectPaths()): GoldenTicket {
  const m = loadManifest(key, p);
  const vault = vaultDir(p, key);
  const scope = readJsonOr<{ components?: string[] }>(path.join(vault, "scope.json"), {}).components ?? [];
  const repro = readJsonOr<{ failing_tests?: string[]; inverse_tests?: string[] }>(path.join(vault, "02-repro.json"), {});
  const plan = readJsonOr<{ root_cause?: string }>(path.join(vault, "03-plan.json"), {});
  const gatesPassed = Object.values(m.gates).flat().filter((g) => g.status === "passed").length;
  const g: GoldenTicket = { key, sealed_at: nowIso(), title: m.title, scope, failing_tests: repro.failing_tests ?? [], inverse_tests: repro.inverse_tests ?? [], root_cause: plan.root_cause, expected: { repro_fail_then_pass: true, unresolved_names: 0, min_gates_passed: Math.max(4, Math.floor(gatesPassed * 0.8)) } };
  ensureDir(goldenDir(p));
  writeJsonAtomic(path.join(goldenDir(p), `${key}.json`), g);
  // keep the ticket snapshot so replays don't need the tracker
  const snap = path.join(vault, "ticket.json");
  if (exists(snap)) writeJsonAtomic(path.join(goldenDir(p), `${key}.ticket.json`), readJsonOr(snap, {}));
  return g;
}

export function goldenList(p: ProjectPaths = projectPaths()): GoldenTicket[] {
  return listFiles(goldenDir(p), (n) => /^[A-Z].*-\d+\.json$/.test(n) && !n.endsWith(".ticket.json")).map((f) => readJsonOr<GoldenTicket>(f, undefined as never)).filter(Boolean);
}

export interface GoldenScore { key: string; ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }

export function goldenScore(key: string, p: ProjectPaths = projectPaths()): GoldenScore {
  const g = readJsonOr<GoldenTicket | undefined>(path.join(goldenDir(p), `${key}.json`), undefined);
  if (!g) throw new Error(`no golden ticket ${key} — sfsmiths-human golden add ${key}`);
  const cfg = loadConfig(p);
  const m = loadManifest(key, p);
  const checks: GoldenScore["checks"] = [];
  const gates = Object.values(m.gates).flat();
  const planLint = gates.filter((x) => x.name === "plan-lint");
  const unresolved = planLint.filter((x) => x.status === "failed").length;
  checks.push({ name: "R4 zero non-existent components", ok: unresolved <= cfg.learning.golden.max_nonexistent_components, detail: `${unresolved} plan-lint failure(s)` });
  const reproFail = gates.some((x) => x.name === "assertion-referee" && x.status === "passed");
  checks.push({ name: "repro FAIL→PASS proven", ok: reproFail, detail: reproFail ? "assertion-referee passed" : "no passing assertion-referee" });
  const passed = gates.filter((x) => x.status === "passed").length;
  checks.push({ name: `≥ ${g.expected.min_gates_passed} gates passed`, ok: passed >= g.expected.min_gates_passed, detail: `${passed} passed` });
  const silentStages = STAGES.filter((s) => s.kind === "agent" && s.gates.length && m.stages[s.id]?.status === "done" && !(m.gates[s.id]?.length)).map((s) => s.id);
  checks.push({ name: "no silent gates (every done agent stage has recorded gate results)", ok: silentStages.length === 0, detail: silentStages.length ? `no gate records for: ${silentStages.join(", ")}` : "every done stage has gate records" });
  const scopeNow = readJsonOr<{ components?: string[] }>(path.join(vaultDir(p, key), "scope.json"), {}).components ?? [];
  const overlap = g.scope.filter((c) => scopeNow.includes(c)).length;
  checks.push({ name: "scope overlap with sealed run", ok: g.scope.length === 0 || overlap / g.scope.length >= 0.6, detail: `${overlap}/${g.scope.length}` });
  return { key, ok: checks.every((c) => c.ok), checks };
}
