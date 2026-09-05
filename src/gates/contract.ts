/**
 * contract-check · checklist · risk-floor
 */
import path from "node:path";
import YAML from "yaml";
import { validateNamed } from "../core/schema.js";
import { exists, readText, sha256, listFiles } from "../core/util.js";
import { applyTier } from "../core/state-machine.js";
import { failed, passed, unavailable, type Gate, type GateContext } from "./types.js";
import { readVaultJson, vaultFile } from "./helpers.js";

/** stage → [markdown output, json contract, schema name] */
export const STAGE_CONTRACTS: Record<string, { md: string; json: string; schema: string }> = {
  prior_art:   { md: "00c-prior-art.md",     json: "00c-prior-art.json",     schema: "prior-art" },
  intake:      { md: "01-intake.md",         json: "01-intake.json",         schema: "intake" },
  cartography: { md: "00d-cartography.md",   json: "00d-cartography.json",   schema: "cartography" },
  repro:       { md: "02-repro.md",          json: "02-repro.json",          schema: "repro" },
  plan:        { md: "03-plan.md",           json: "03-plan.json",           schema: "plan" },
  develop:     { md: "04-implementation.md", json: "04-implementation.json", schema: "implementation" },
  qa_dev:      { md: "05-test-report.md",    json: "05-test-report.json",    schema: "test-report" },
  qa_uat:      { md: "07-uat-report.md",     json: "07-uat-report.json",     schema: "test-report" },
  review:      { md: "06-review.md",         json: "06-review.json",         schema: "review" },
  comms:       { md: "10-comms/README.md",   json: "10-comms/index.json",    schema: "comms" },
};

interface EvidenceRef { source: string; ref: string; verified_at?: string }

function collectEvidence(obj: unknown, out: EvidenceRef[] = []): EvidenceRef[] {
  if (Array.isArray(obj)) obj.forEach((x) => collectEvidence(x, out));
  else if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (typeof o.source === "string" && typeof o.ref === "string" && ["L0", "L1", "L2", "L3", "L4", "vault", "tracker", "git", "human"].includes(o.source)) out.push(o as unknown as EvidenceRef);
    for (const v of Object.values(o)) collectEvidence(v, out);
  }
  return out;
}

export const contractCheck: Gate = {
  name: "contract-check",
  description: "Stage output exists (md + json), json validates against its schema, every evidence ref resolves (evidence-or-nothing).",
  async run(ctx) {
    const c = STAGE_CONTRACTS[ctx.stage];
    if (!c) return passed("contract-check", `no contract defined for stage ${ctx.stage}`);
    const md = vaultFile(ctx, c.md);
    const js = vaultFile(ctx, c.json);
    if (!exists(md)) return failed("contract-check", `missing ${c.md} — write the stage output file`);
    if (!exists(js)) return failed("contract-check", `missing ${c.json} — write the JSON contract next to the markdown (schema: schemas/contracts/${c.schema}.schema.json)`);
    let data: unknown;
    try {
      data = JSON.parse(readText(js));
    } catch (e) {
      return failed("contract-check", `${c.json} is not valid JSON: ${(e as Error).message}`);
    }
    const errors = validateNamed(`contracts/${c.schema}`, data);
    if (errors.length) return failed("contract-check", `${c.json} fails schema ${c.schema}: ${errors.slice(0, 8).join(" | ")}${errors.length > 8 ? ` (+${errors.length - 8} more)` : ""}`, { details: { errors } });
    // evidence refs that look like files must exist
    const missing: string[] = [];
    for (const ev of collectEvidence(data)) {
      if (ev.source === "vault" || ev.source === "L2" || ev.source === "git") {
        const candidates = [path.join(ctx.vault, ev.ref), path.join(ctx.p.root, ev.ref)];
        if (/^[\w./-]+\.(md|json|txt|cls|xml|apex|log|csv|yaml|ts|js)$/.test(ev.ref) && !candidates.some(exists)) missing.push(ev.ref);
      }
    }
    if (missing.length) return failed("contract-check", `evidence refs do not resolve: ${missing.slice(0, 6).join(", ")}`, { details: { missing } });
    const hash = sha256(readText(md) + readText(js));
    return passed("contract-check", `${c.json} valid (${collectEvidence(data).length} evidence refs)`, { artifact_hash: hash });
  },
};

/**
 * checklist — the plan must answer every applicable checklist item (knowledge/checklists/*.yaml).
 * Items: { id, question, applies_when: always|apex|flow|data|email|ui|permissions|integration }.
 */
export const checklistGate: Gate = {
  name: "checklist",
  description: "Plan answers every applicable checklist item (architecture, security, EML-1..4 email, flow, data).",
  async run(ctx) {
    const plan = readVaultJson<{ components?: { type: string }[]; checklist_answers?: Record<string, { answer: string; note?: string }>; touches?: string[] }>(ctx, "03-plan.json");
    if (!plan) return unavailable("checklist", "03-plan.json missing (contract-check will report)");
    const dir = path.join(ctx.p.knowledge, "checklists");
    const files = listFiles(dir, (n) => n.endsWith(".yaml") || n.endsWith(".yml"));
    if (!files.length) return unavailable("checklist", `no checklists found in ${dir}`);
    const types = new Set((plan.components ?? []).map((c) => c.type.toLowerCase()));
    const touches = new Set((plan.touches ?? []).map((t) => t.toLowerCase()));
    const applies = (when: string) => {
      const w = when.toLowerCase();
      if (w === "always") return true;
      if (w === "apex") return [...types].some((t) => t.startsWith("apex"));
      if (w === "flow") return types.has("flow");
      return touches.has(w);
    };
    const missing: string[] = [];
    let total = 0;
    for (const f of files) {
      const doc = YAML.parse(readText(f)) as { items?: { id: string; question: string; applies_when?: string }[] };
      for (const item of doc.items ?? []) {
        if (!applies(item.applies_when ?? "always")) continue;
        total++;
        const a = plan.checklist_answers?.[item.id];
        if (!a || !["yes", "no", "n/a"].includes(String(a.answer).toLowerCase()) || (String(a.answer).toLowerCase() === "n/a" && !a.note)) missing.push(`${item.id} (${item.question})`);
      }
    }
    if (missing.length) return failed("checklist", `${missing.length}/${total} checklist items unanswered or n/a without reason: ${missing.slice(0, 5).join("; ")}`, { details: { missing } });
    return passed("checklist", `${total} applicable items answered`);
  },
};

/**
 * risk-floor — computes the minimum tier from the intake contract. Agent tiers can only be RAISED here (P7).
 */
export const riskFloor: Gate = {
  name: "risk-floor",
  description: "Computes the risk tier floor from scope (Apex/trigger/permissions → HIGH; Flow/VR → MEDIUM; else LOW).",
  async run(ctx) {
    const intake = readVaultJson<{ suggested_tier?: string; scope?: { type: string; api_name: string }[]; objects?: string[]; touches?: string[] }>(ctx, "01-intake.json");
    if (!intake) return unavailable("risk-floor", "01-intake.json missing");
    const types = (intake.scope ?? []).map((s) => s.type.toLowerCase());
    const touches = new Set((intake.touches ?? []).map((t) => t.toLowerCase()));
    let floor: "LOW" | "MEDIUM" | "HIGH" = "LOW";
    const reasons: string[] = [];
    if (types.some((t) => t.startsWith("apex") || t === "batch" || t === "schedulable" || t === "queueable")) { floor = "HIGH"; reasons.push("Apex in scope"); }
    if (touches.has("permissions") || touches.has("sharing") || types.some((t) => t === "permissionset" || t === "profile" || t === "sharingrules")) { floor = "HIGH"; reasons.push("permissions/sharing"); }
    if (touches.has("integration") || touches.has("email")) { floor = floor === "HIGH" ? "HIGH" : "MEDIUM"; reasons.push("integration/email side effects"); }
    if ((intake.scope ?? []).length > 8) { floor = "HIGH"; reasons.push(`${(intake.scope ?? []).length} components in scope`); }
    if (floor === "LOW" && types.some((t) => t === "flow" || t === "validationrule" || t === "customfield")) { floor = "MEDIUM"; reasons.push("declarative automation"); }
    const suggested = String(intake.suggested_tier ?? "").toUpperCase();
    const order: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    let tier = floor;
    if (order[suggested] !== undefined && order[suggested] > order[floor]) tier = suggested as typeof floor; // agent may raise, never lower
    applyTier(ctx.manifest, tier, "risk-floor");
    return passed("risk-floor", `tier ${tier} (floor ${floor}${suggested ? `, agent suggested ${suggested}` : ""}${reasons.length ? `: ${reasons.join(", ")}` : ""})`, { details: { floor, suggested, tier, reasons } });
  },
};
